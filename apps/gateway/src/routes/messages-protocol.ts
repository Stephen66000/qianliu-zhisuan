import type { FastifyReply } from "fastify";
import type { GatewayStreamWriter } from "./chat-protocol.js";

interface ToolBlock {
  blockIndex: number;
  id: string;
  name: string;
  started: boolean;
}

const STREAM_PING_INTERVAL_MS = 5_000;

/**
 * OpenAI-compatible Chat delta -> Anthropic Messages SSE 实时转换。
 * 不缓存消息正文；仅在内存中保留工具块的索引、ID 和名称。
 */
export function createMessagesStreamWriter(
  reply: FastifyReply,
  input: {
    requestId: string;
    traceId: string;
    model: string;
  },
): GatewayStreamWriter {
  let started = false;
  let ended = false;
  let nextBlockIndex = 0;
  let textBlockIndex: number | null = null;
  let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
  const openBlocks = new Set<number>();
  const tools = new Map<number, ToolBlock>();
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const stopPings = () => {
    if (pingTimer === null) return;
    clearInterval(pingTimer);
    pingTimer = null;
  };

  const write = (event: string, data: Record<string, unknown>) => {
    if (ended || reply.raw.destroyed) return;
    start();
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  };
  const start = () => {
    if (started || ended) return;
    started = true;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "x-request-id": input.traceId,
      "x-ai-request-id": input.requestId,
    });
    reply.raw.flushHeaders();
    reply.raw.write(`event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: `msg_${input.requestId}`,
        type: "message",
        role: "assistant",
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // Chat 上游的精确 usage 仅在末块到达；最终值在 message_delta 补齐。
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`);
    pingTimer = setInterval(() => {
      if (ended || reply.raw.destroyed) {
        stopPings();
        return;
      }
      reply.raw.write('event: ping\ndata: {"type":"ping"}\n\n');
    }, STREAM_PING_INTERVAL_MS);
    pingTimer.unref?.();
  };
  const ensureTextBlock = () => {
    if (textBlockIndex !== null) return textBlockIndex;
    textBlockIndex = nextBlockIndex++;
    openBlocks.add(textBlockIndex);
    write("content_block_start", {
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    return textBlockIndex;
  };
  const stopOpenBlocks = () => {
    for (const index of [...openBlocks].sort((left, right) => left - right)) {
      write("content_block_stop", { index });
      openBlocks.delete(index);
    }
  };
  const ensureToolBlock = (upstreamIndex: number, raw: Record<string, unknown>) => {
    let block = tools.get(upstreamIndex);
    const fn = isRecord(raw.function) ? raw.function : {};
    if (!block) {
      block = {
        blockIndex: nextBlockIndex++,
        id: "",
        name: "",
        started: false,
      };
      tools.set(upstreamIndex, block);
    }
    // tool id/name 可能被 OpenAI-compatible 上游拆成多个 delta；在首段参数到达前
    // 只缓存这些元数据，确保 Anthropic content_block_start 一次给出完整标识。
    if (!block.started) {
      block.id += stringValue(raw.id);
      block.name += stringValue(fn.name);
    }
    return block;
  };
  const startToolBlock = (block: ToolBlock) => {
    if (block.started) return;
    stopOpenBlocks();
    block.started = true;
    openBlocks.add(block.blockIndex);
    write("content_block_start", {
      index: block.blockIndex,
      content_block: {
        type: "tool_use",
        id: block.id || `call_${input.requestId}_${block.blockIndex}`,
        name: block.name || "tool",
        input: {},
      },
    });
  };

  return {
    get committed() {
      return started;
    },
    async writeChunk(payload) {
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      for (const rawChoice of choices) {
        const choice = isRecord(rawChoice) ? rawChoice : {};
        const delta = isRecord(choice.delta) ? choice.delta : {};
        const content = stringValue(delta.content);
        if (content) {
          write("content_block_delta", {
            index: ensureTextBlock(),
            delta: { type: "text_delta", text: content },
          });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            const call = isRecord(rawCall) ? rawCall : {};
            const upstreamIndex = integerValue(call.index);
            const block = ensureToolBlock(upstreamIndex, call);
            const fn = isRecord(call.function) ? call.function : {};
            const partialJson = stringValue(fn.arguments);
            if (partialJson) {
              startToolBlock(block);
              write("content_block_delta", {
                index: block.blockIndex,
                delta: { type: "input_json_delta", partial_json: partialJson },
              });
            }
          }
        }
        if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
        if (choice.finish_reason === "length") stopReason = "max_tokens";
      }
    },
    complete(outcome) {
      if (ended) return;
      if (!started) start();
      stopPings();
      for (const block of [...tools.values()].sort((left, right) => left.blockIndex - right.blockIndex)) {
        startToolBlock(block);
      }
      stopOpenBlocks();
      write("message_delta", {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: outcome.usage.input,
          output_tokens: outcome.usage.output,
          cache_read_input_tokens: outcome.usage.cache,
        },
      });
      write("message_stop", {});
      ended = true;
      if (!reply.raw.destroyed) reply.raw.end();
    },
    fail(error) {
      if (ended) return;
      write("error", {
        error: {
          type: error.code,
          message: error.message,
          request_id: error.requestId,
        },
      });
      stopPings();
      ended = true;
      if (!reply.raw.destroyed) reply.raw.end();
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 极简 WebSocket 客户端（仅用于本地取证脚本，不是产品代码）。
 *
 * 为什么手写：本机没有 playwright / puppeteer 的浏览器二进制，而 Node 22 内置的
 * `WebSocket` 在本机 Chrome DevTools 端点上握手成功却收不到任何消息帧。
 * DevTools 协议只需「文本帧 + 掩码」这一点子集，手写约百行即可稳定工作。
 *
 * 支持：文本帧（含分片重组）、ping→pong、16/64 位扩展长度（截图 base64 会超过 64KB）。
 */
import { randomBytes } from "node:crypto";
import { connect } from "node:net";

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const mask = randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

export function connectWebSocket(url) {
  const parsed = new URL(url);
  const socket = connect(Number(parsed.port), parsed.hostname);
  const state = { buffer: Buffer.alloc(0), fragments: [], handshakeDone: false, closed: false };
  const textHandlers = [];
  const closeHandlers = [];

  const writeFrame = (opcode, payload) => {
    if (!state.closed) socket.write(encodeFrame(opcode, payload));
  };

  const dispatch = (text) => {
    for (const handler of textHandlers) handler(text);
  };

  const parse = () => {
    for (;;) {
      const buffer = state.buffer;
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= maskKey[index % 4];
        }
      }
      state.buffer = buffer.subarray(offset + length);
      if (opcode === 0x1 || opcode === 0x0) {
        state.fragments.push(Buffer.from(payload));
        if (fin) {
          dispatch(Buffer.concat(state.fragments).toString("utf8"));
          state.fragments = [];
        }
      } else if (opcode === 0x8) {
        state.closed = true;
        for (const handler of closeHandlers) handler();
        return;
      } else if (opcode === 0x9) {
        writeFrame(0xa, payload);
      }
    }
  };

  socket.on("data", (chunk) => {
    if (state.closed) return;
    state.buffer = Buffer.concat([state.buffer, chunk]);
    if (!state.handshakeDone) {
      const end = state.buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = state.buffer.subarray(0, end).toString("latin1");
      if (!/^HTTP\/1\.1 101/.test(head)) {
        state.closed = true;
        throw new Error(`WebSocket 升级失败：${head.split("\r\n")[0]}`);
      }
      state.buffer = state.buffer.subarray(end + 4);
      state.handshakeDone = true;
    }
    parse();
  });

  const ready = new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write([
        `GET ${parsed.pathname} HTTP/1.1`,
        `Host: ${parsed.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "", "",
      ].join("\r\n"));
      const deadline = Date.now() + 10_000;
      const wait = setInterval(() => {
        if (state.handshakeDone) {
          clearInterval(wait);
          resolve();
        } else if (state.closed || Date.now() > deadline) {
          clearInterval(wait);
          reject(new Error("WebSocket 握手超时"));
        }
      }, 20);
    });
  });

  return {
    ready,
    onText: (handler) => textHandlers.push(handler),
    onClose: (handler) => closeHandlers.push(handler),
    sendText: (text) => writeFrame(0x1, text),
    close: () => { socket.destroy(); state.closed = true; },
  };
}

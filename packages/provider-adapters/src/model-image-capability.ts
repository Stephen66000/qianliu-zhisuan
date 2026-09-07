/** Exact upstream-model facts checked against official docs on 2026-09-07.
 * https://docs.bigmodel.cn/cn/guide/models/text/{model}
 * No prefix matching: glm-5.3-flash / future models must not inherit text-only facts.
 * Unknown capability stays unknown; absence of a vision flag is not proof of no vision.
 */
const ZHIPU_TEXT_MODELS = new Set(["glm-4.6", "glm-4.7", "glm-5", "glm-5.2", "glm-5.3"]);

export function modelSupportsImages(providerCode: string, upstreamModel: string): false | null {
  return providerCode === "zhipu" && ZHIPU_TEXT_MODELS.has(upstreamModel) ? false : null;
}

export const MODEL_IMAGE_UNSUPPORTED = "model_image_unsupported";
export const IMAGE_INPUT_UNSUPPORTED = "image_input_unsupported";

/** One block reference: undefined means non-image, null means malformed image. */
function imageReference(block: Record<string, unknown>, converted: boolean): string | null | undefined {
  const object = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
  if (block.type === "image_url") {
    const url = object(block.image_url).url;
    return typeof url === "string" ? `url:${url}` : null;
  }
  if (block.type === "input_image") {
    return typeof block.image_url === "string" ? `url:${block.image_url}`
      : typeof block.file_id === "string" ? `file:${block.file_id}` : null;
  }
  if (block.type === "image") {
    const source = object(block.source);
    return source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string"
      ? `url:data:${source.media_type};base64,${source.data}`
      : source.type === "url" && typeof source.url === "string" ? `url:${source.url}`
      : source.type === "file" && typeof source.file_id === "string" ? `file:${source.file_id}` : null;
  }
  if (converted && block.type === "file" && typeof block.file_id === "string") return `file:${block.file_id}`;
  return undefined;
}

/** Traverse protocol envelopes separately: extension fields must not hide their messages.
 * Tool arguments are application data; only content/output slots contain multimodal blocks.
 * References stay in memory and are never persisted or logged.
 */
function imageReferences(body: unknown, converted = false): Array<string | null> {
  type Kind = "request" | "message" | "block";
  const refs: Array<string | null> = [];
  const stack: Array<{ value: unknown; kind: Kind }> = [{ value: body, kind: "request" }];
  while (stack.length) {
    const item = stack.pop()!;
    if (Array.isArray(item.value)) {
      for (const value of item.value) stack.push({ value, kind: item.kind === "request" ? "message" : item.kind });
      continue;
    }
    if (typeof item.value !== "object" || item.value === null) continue;
    const block = item.value as Record<string, unknown>;
    if (item.kind === "request") {
      for (const key of ["messages", "input"]) stack.push({ value: block[key], kind: "message" });
      stack.push({ value: block.system, kind: "block" }, { value: block.responsesRequest, kind: "request" });
      continue;
    }
    if (item.kind === "message") {
      stack.push({ value: block.content, kind: "block" });
      if (block.type === "function_call_output") stack.push({ value: block.output, kind: "block" });
      // Direct Responses image items may not be convertible, but must fail explicitly.
    } else {
      if (block.type === "tool_use" || block.type === "function_call") continue;
      for (const key of ["content", "output"]) stack.push({ value: block[key], kind: "block" });
    }
    const ref = imageReference(block, converted);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

export function hasImageInput(body: unknown): boolean { return imageReferences(body).length > 0; }

/** Fail explicitly if conversion cannot represent any image; never silently send the text alone. */
export function preservesImageInputs(original: unknown, converted: unknown): boolean {
  const available = new Map<string | null, number>();
  for (const ref of imageReferences(converted, true)) available.set(ref, (available.get(ref) ?? 0) + 1);
  for (const ref of imageReferences(original)) {
    const count = available.get(ref) ?? 0;
    if (ref === null || count === 0) return false;
    available.set(ref, count - 1);
  }
  return true;
}

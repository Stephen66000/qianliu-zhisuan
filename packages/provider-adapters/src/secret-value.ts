/**
 * 强制脱敏的凭证包装。
 * 任何 JSON.stringify/toString 都返回 [REDACTED]，明文只能通过 reveal() 取出。
 */
export class SecretValue {
  #value: string;
  #redacted = "[REDACTED]";

  constructor(value: string) {
    this.#value = value;
  }

  /** 取明文。调用方负责不写入日志/Trace/DB。 */
  reveal(): string {
    return this.#value;
  }

  /** 是否已配置（非空）。 */
  isConfigured(): boolean {
    return this.#value.length > 0;
  }

  /** 强制脱敏。 */
  toString(): string {
    return this.#redacted;
  }

  toJSON(): string {
    return this.#redacted;
  }

  /** 用于显示的指纹（前 4 位 + 长度，不泄露可还原信息）。 */
  fingerprint(): string {
    if (this.#value.length === 0) return "[EMPTY]";
    const head = this.#value.slice(0, 4);
    return `${head}…(len=${this.#value.length})`;
  }
}

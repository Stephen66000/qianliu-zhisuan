/**
 * IP 白名单匹配（TRD §5.3：Key 校验后执行 IP 限制）。
 *
 * 支持精确 IP 与 CIDR（IPv4/IPv6），IPv4-mapped IPv6（::ffff:a.b.c.d）按其
 * 内嵌 IPv4 地址参与 v4 比较。条目解析失败视为不匹配（fail-closed）；
 * 写入侧（control-api）用 isValidIpAllowlistEntry 校验格式。
 */

interface ParsedIp {
  /** 大端整数值。 */
  value: bigint;
  /** 地址族位宽：32 或 128。 */
  bits: 32 | 128;
}

function parseIpv4(value: string): ParsedIp | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    acc = (acc << 8n) | BigInt(octet);
  }
  return { value: acc, bits: 32 };
}

function parseIpv6Group(group: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  return parseInt(group, 16);
}

function parseIpv6(value: string): ParsedIp | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 && halves[1] === "" ? [] : (halves[1]?.split(":") ?? []);
  const headGroups: number[] = [];
  for (const group of head) {
    const parsed = parseIpv6Group(group);
    if (parsed === null) return null;
    headGroups.push(parsed);
  }
  const tailGroups: number[] = [];
  for (const group of tail) {
    if (group.includes(".")) {
      // IPv4-mapped 尾部（形如 ::ffff:1.2.3.4）只能出现在末尾并展开为两个 hextet。
      if (group !== tail[tail.length - 1]) return null;
      const mapped = parseIpv4(group);
      if (!mapped) return null;
      tailGroups.push(Number((mapped.value >> 16n) & 0xffffn));
      tailGroups.push(Number(mapped.value & 0xffffn));
      continue;
    }
    const parsed = parseIpv6Group(group);
    if (parsed === null) return null;
    tailGroups.push(parsed);
  }
  let groups = [...headGroups, ...tailGroups];
  if (halves.length === 2) {
    const missing = 8 - groups.length;
    if (missing < 1) return null;
    groups = [...headGroups, ...Array.from({ length: missing }, () => 0), ...tailGroups];
  }
  if (groups.length !== 8) return null;
  let acc = 0n;
  for (const group of groups) acc = (acc << 16n) | BigInt(group);
  return { value: acc, bits: 128 };
}

export function parseIpForAllowlist(value: string): ParsedIp | null {
  const trimmed = value.trim();
  if (trimmed.includes(":")) return parseIpv6(trimmed);
  return parseIpv4(trimmed);
}

/** 条目是否合法：精确 IP 或 `<IP>/<前缀位>` CIDR（CIDR 主机位必须为零）。 */
export function isValidIpAllowlistEntry(entry: string): boolean {
  const trimmed = entry.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) return parseIpForAllowlist(trimmed) !== null;
  const base = parseIpForAllowlist(trimmed.slice(0, slash));
  if (!base) return false;
  if (!/^\d{1,3}$/.test(trimmed.slice(slash + 1))) return false;
  const bits = Number(trimmed.slice(slash + 1));
  if (bits < 0 || bits > base.bits) return false;
  // 主机位非零（如 203.0.113.1/24）说明书写网络与意图不符，写入侧拒绝。
  const shift = BigInt(base.bits - bits);
  return base.value >> shift << shift === base.value;
}

function entryMatchesIp(entry: string, ip: ParsedIp): boolean {
  const trimmed = entry.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const base = parseIpForAllowlist(trimmed);
    return base !== null && base.bits === ip.bits && base.value === ip.value;
  }
  const base = parseIpForAllowlist(trimmed.slice(0, slash));
  if (!base || base.bits !== ip.bits) return false;
  if (!/^\d{1,3}$/.test(trimmed.slice(slash + 1))) return false;
  const bits = Number(trimmed.slice(slash + 1));
  if (bits < 0 || bits > base.bits) return false;
  const shift = BigInt(base.bits - bits);
  return base.value >> shift === ip.value >> shift;
}

/** 请求 IP 是否命中白名单；空白名单拒绝所有 IP（fail-closed），NULL 白名单由调用方放行。 */
export function ipMatchesAllowlist(ip: string, entries: readonly string[]): boolean {
  const parsed = parseIpForAllowlist(ip);
  if (!parsed) return false;
  return entries.some((entry) => entryMatchesIp(entry, parsed));
}

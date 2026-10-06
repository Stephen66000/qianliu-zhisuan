import { describe, expect, it } from "vitest";
import { ipMatchesAllowlist, isValidIpAllowlistEntry } from "../ip-allowlist.js";

describe("IP 白名单匹配（F-014）", () => {
  it("IPv4 精确匹配", () => {
    expect(isValidIpAllowlistEntry("203.0.113.7")).toBe(true);
    expect(ipMatchesAllowlist("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(ipMatchesAllowlist("203.0.113.8", ["203.0.113.7"])).toBe(false);
  });

  it("IPv4 CIDR 前缀比较", () => {
    expect(ipMatchesAllowlist("203.0.113.7", ["203.0.113.0/24"])).toBe(true);
    expect(ipMatchesAllowlist("203.0.114.7", ["203.0.113.0/24"])).toBe(false);
    expect(ipMatchesAllowlist("0.0.0.0", ["0.0.0.0/0"])).toBe(true);
    expect(ipMatchesAllowlist("255.255.255.255", ["0.0.0.0/0"])).toBe(true);
    expect(ipMatchesAllowlist("203.0.113.7", ["203.0.113.7/32"])).toBe(true);
    expect(ipMatchesAllowlist("203.0.113.8", ["203.0.113.7/32"])).toBe(false);
  });

  it("IPv6 精确与 CIDR", () => {
    expect(ipMatchesAllowlist("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipMatchesAllowlist("::1", ["::1/128"])).toBe(true);
    expect(ipMatchesAllowlist("2001:0db8:0000:0000:0000:0000:0000:0001", ["2001:db8::/32"])).toBe(true);
  });

  it("IPv4-mapped IPv6 按内嵌 IPv4 参与 v4 比较", () => {
    expect(isValidIpAllowlistEntry("::ffff:203.0.113.7")).toBe(true);
    expect(ipMatchesAllowlist("::ffff:203.0.113.7", ["203.0.113.0/24"])).toBe(false);
    expect(ipMatchesAllowlist("203.0.113.7", ["::ffff:203.0.113.7"])).toBe(false);
  });

  it("地址族不同不匹配", () => {
    expect(ipMatchesAllowlist("::1", ["127.0.0.1"])).toBe(false);
    expect(ipMatchesAllowlist("127.0.0.1", ["::1"])).toBe(false);
  });

  it("条目非法视为不匹配（fail-closed），但写入侧校验应拦截", () => {
    expect(isValidIpAllowlistEntry("not-an-ip")).toBe(false);
    expect(isValidIpAllowlistEntry("203.0.113.0/33")).toBe(false);
    expect(isValidIpAllowlistEntry("2001:db8::/129")).toBe(false);
    expect(isValidIpAllowlistEntry("203.0.113.1/24")).toBe(false);
    expect(isValidIpAllowlistEntry("2001:db8::/32")).toBe(true);
    expect(isValidIpAllowlistEntry("2001:db8::1/32")).toBe(false);
    expect(ipMatchesAllowlist("203.0.113.7", ["not-an-ip", "300.1.2.3"])).toBe(false);
  });

  it("非法请求 IP 不命中任何白名单", () => {
    expect(ipMatchesAllowlist("garbage", ["0.0.0.0/0"])).toBe(false);
  });

  it("边界：前缀 0 与 /128、/32 全覆盖", () => {
    expect(ipMatchesAllowlist("::ffff:0.0.0.0", ["::/0"])).toBe(true);
    expect(ipMatchesAllowlist("2001:db8::9", ["::/0"])).toBe(true);
  });
});

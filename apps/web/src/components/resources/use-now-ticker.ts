/**
 * 以固定间隔推进的「当前时间」钩子（WP05）。
 *
 * 用途：候选 TTL 倒计时与静默租约剩余时间的展示。只推进展示用的时间戳，
 * 不参与任何门禁判定——服务端始终按自己的服务器时间判断有效期（PFA-09）。
 */
import { useEffect, useState } from "react";

export function useNowTicker(intervalMs = 1000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

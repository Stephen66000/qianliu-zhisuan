#!/usr/bin/env node

/**
 * 安全读取 Kimi Code 套餐用量。
 *
 * 与 Kimi Code 官方 OAuthManager 保持相同的关键语义：
 * - access token 进入动态阈值（至少 5 分钟、或 TTL 的一半）后先刷新；
 * - 使用 ~/.kimi-code/oauth/kimi-code.lock 协调跨进程刷新；
 * - 刷新后的凭证以 0600 权限原子写回；
 * - 标准输出只包含用量和过期时间，永不输出 access/refresh token。
 */

import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KIMI_CODE_HOME = process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
const CREDENTIAL_PATH = join(KIMI_CODE_HOME, 'credentials', 'kimi-code.json');
const LOCK_TARGET = join(KIMI_CODE_HOME, 'oauth', 'kimi-code');
const LOCK_PATH = `${LOCK_TARGET}.lock`;
const OAUTH_HOST = (process.env.KIMI_CODE_OAUTH_HOST ?? 'https://auth.kimi.com').replace(/\/+$/, '');
const USAGE_URL = `${(process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1').replace(/\/+$/, '')}/usages`;
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const nowSeconds = () => Math.floor(Date.now() / 1000);

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
}

function validateCredential(value) {
  if (typeof value !== 'object' || value === null) throw new Error('Kimi 凭证文件格式无效，请重新执行 kimi login');
  const credential = value;
  if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
    throw new Error('Kimi 凭证缺少 access_token，请重新执行 kimi login');
  }
  if (typeof credential.refresh_token !== 'string' || credential.refresh_token.length === 0) {
    throw new Error('Kimi 凭证缺少 refresh_token，请重新执行 kimi login');
  }
  if (!Number.isFinite(Number(credential.expires_at))) {
    throw new Error('Kimi 凭证缺少 expires_at，请重新执行 kimi login');
  }
  return {
    access_token: credential.access_token,
    refresh_token: credential.refresh_token,
    expires_at: Number(credential.expires_at),
    expires_in: Number.isFinite(Number(credential.expires_in)) ? Number(credential.expires_in) : 0,
    scope: typeof credential.scope === 'string' ? credential.scope : '',
    token_type: typeof credential.token_type === 'string' ? credential.token_type : 'Bearer',
  };
}

async function loadCredential() {
  let raw;
  try {
    raw = await readFile(CREDENTIAL_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('未找到 Kimi 登录凭证，请先执行 kimi login');
    throw error;
  }
  try {
    return validateCredential(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Kimi 凭证文件不是有效 JSON，请重新执行 kimi login');
    throw error;
  }
}

function shouldRefresh(credential, force = false) {
  if (force) return true;
  if (credential.expires_at === 0) return false;
  const threshold = Math.max(300, credential.expires_in > 0 ? credential.expires_in * 0.5 : 0);
  return credential.expires_at - nowSeconds() < threshold;
}

async function acquireRefreshLock() {
  await mkdir(dirname(LOCK_TARGET), { recursive: true, mode: 0o700 });
  await writeFile(LOCK_TARGET, '', { flag: 'a' });

  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      await mkdir(LOCK_PATH);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('等待 Kimi OAuth 刷新锁超时，请稍后重试');

      // 与官方 proper-lockfile 的 5 秒 stale 配置兼容。先原子改名再清理，
      // 避免直接删除一个刚被其他进程重新获取的锁目录。
      try {
        const lockStat = await stat(LOCK_PATH);
        if (Date.now() - lockStat.mtimeMs > 10_000) {
          const stalePath = `${LOCK_PATH}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
          await rename(LOCK_PATH, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code !== 'ENOENT') throw lockError;
      }
      await sleep(500);
    }
  }

  let released = false;
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(LOCK_PATH, now, now).catch(() => {});
  }, 2_000);
  heartbeat.unref();

  return async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    try {
      await rm(LOCK_PATH, { recursive: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
}

async function atomicSaveCredential(credential) {
  const directory = dirname(CREDENTIAL_PATH);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const temporaryPath = `${CREDENTIAL_PATH}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const handle = await open(temporaryPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, CREDENTIAL_PATH);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function postRefresh(refreshToken) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${OAUTH_HOST}/api/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      let payload = {};
      try {
        const parsed = await response.json();
        payload = typeof parsed === 'object' && parsed !== null ? parsed : {};
      } catch {
        // 只按状态码处理；不输出可能包含敏感信息的原始响应。
      }

      if (response.ok) {
        if (
          typeof payload.access_token !== 'string' || payload.access_token.length === 0 ||
          typeof payload.refresh_token !== 'string' || payload.refresh_token.length === 0 ||
          !Number.isFinite(Number(payload.expires_in)) || Number(payload.expires_in) <= 0
        ) {
          throw new Error('Kimi OAuth 刷新响应缺少必要字段');
        }
        const expiresIn = Number(payload.expires_in);
        return {
          access_token: payload.access_token,
          refresh_token: payload.refresh_token,
          expires_at: nowSeconds() + expiresIn,
          scope: typeof payload.scope === 'string' ? payload.scope : '',
          token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
          expires_in: expiresIn,
        };
      }

      if (response.status === 401 || response.status === 403 || payload.error === 'invalid_grant') {
        throw new Error('Kimi refresh_token 已失效或被撤销，请执行 kimi login 重新授权');
      }
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`Kimi OAuth 刷新失败（HTTP ${response.status}）`);
      }
      lastError = new Error(`Kimi OAuth 暂时不可用（HTTP ${response.status}）`);
    } catch (error) {
      if (error?.message?.includes('refresh_token 已失效') || error?.message?.includes('刷新失败')) throw error;
      lastError = error;
    }
    if (attempt < 2) await sleep(2 ** attempt * 1_000);
  }
  throw lastError ?? new Error('Kimi OAuth 刷新失败');
}

async function ensureFresh(force = false) {
  const initial = await loadCredential();
  if (!shouldRefresh(initial, force)) return { credential: initial, refreshed: false };

  const release = await acquireRefreshLock();
  try {
    const current = await loadCredential();
    if (
      force &&
      (current.access_token !== initial.access_token ||
        current.refresh_token !== initial.refresh_token ||
        current.expires_at !== initial.expires_at)
    ) {
      return { credential: current, refreshed: false };
    }
    if (!shouldRefresh(current, force)) return { credential: current, refreshed: false };
    const refreshed = await postRefresh(current.refresh_token);
    await atomicSaveCredential(refreshed);
    return { credential: refreshed, refreshed: true };
  } finally {
    await release();
  }
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function safeUsageRow(raw, window = undefined) {
  if (typeof raw !== 'object' || raw === null) return null;
  const used = toInteger(raw.used);
  const limit = toInteger(raw.limit);
  if (used === null && limit === null) return null;
  const normalizedLimit = limit ?? 0;
  const normalizedUsed = used ?? 0;
  return {
    ...(window === undefined ? {} : { window }),
    used: normalizedUsed,
    limit: normalizedLimit,
    remaining: Math.max(0, normalizedLimit - normalizedUsed),
    ...(typeof raw.resetTime === 'string' ? { resetTime: raw.resetTime } : {}),
  };
}

function safeUsagePayload(payload) {
  const weekly = safeUsageRow(payload?.usage);
  const windows = [];
  if (Array.isArray(payload?.limits)) {
    for (const item of payload.limits) {
      if (typeof item !== 'object' || item === null) continue;
      const duration = toInteger(item.window?.duration);
      const timeUnit = typeof item.window?.timeUnit === 'string' ? item.window.timeUnit : undefined;
      const row = safeUsageRow(item.detail, duration === null ? undefined : { duration, timeUnit });
      if (row !== null) windows.push(row);
    }
  }
  return { weekly, windows };
}

async function fetchUsage(accessToken) {
  const response = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) return { kind: 'unauthorized' };
  if (!response.ok) throw new Error(`Kimi 用量接口失败（HTTP ${response.status}）`);
  return { kind: 'ok', usage: safeUsagePayload(await response.json()) };
}

async function main() {
  let auth = await ensureFresh(false);
  let result = await fetchUsage(auth.credential.access_token);
  if (result.kind === 'unauthorized' && !auth.refreshed) {
    auth = await ensureFresh(true);
    result = await fetchUsage(auth.credential.access_token);
  }
  if (result.kind === 'unauthorized') {
    throw new Error('Kimi 官方接口拒绝刷新后的凭证，请执行 kimi login 重新授权');
  }

  process.stdout.write(`${JSON.stringify({
    sampledAt: new Date().toISOString(),
    auth: {
      refreshed: auth.refreshed,
      accessExpiresAt: new Date(auth.credential.expires_at * 1000).toISOString(),
      accessTtlSeconds: auth.credential.expires_in,
    },
    usage: result.usage,
  }, null, 2)}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

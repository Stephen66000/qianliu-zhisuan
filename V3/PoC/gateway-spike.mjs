import { createHmac } from 'node:crypto';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function hmac(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function usageTotal(usage = {}) {
  return (usage.input ?? 0) + (usage.output ?? 0);
}

export class GatewayError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ThinGateway {
  constructor({ principals, resources, routes, upstream, pepper = 'poc-pepper', affinitySecret = 'poc-affinity' }) {
    this.pepper = pepper;
    this.affinitySecret = affinitySecret;
    this.principals = principals.map((principal) => ({
      ...principal,
      keyDigest: hmac(principal.key, pepper),
      key: undefined,
      used: principal.used ?? 0,
      inflight: 0,
    }));
    this.resources = new Map(resources.map((resource) => [resource.id, { ...resource }]));
    this.routes = new Map(routes.map((route) => [route.model, { ...route }]));
    this.upstream = upstream;
    this.affinity = new Map();
    this.requests = new Map();
    this.attempts = [];
    this.ledgerLines = [];
    this.settlements = new Map();
    this.dispatchEvidence = [];
  }

  authenticate(key) {
    const digest = hmac(key, this.pepper);
    const principal = this.principals.find((item) => item.keyDigest === digest);
    if (!principal || principal.status !== 'ACTIVE') {
      throw new GatewayError(401, 'invalid_principal_key', '主体 Key 无效或已停用');
    }
    return principal;
  }

  affinityKey(sessionId) {
    return sessionId ? hmac(sessionId, this.affinitySecret) : null;
  }

  score(resource, affinityResourceId) {
    const factors = {
      priority: resource.priority ?? 1,
      weight: resource.weight ?? 0,
      load: resource.inflight ?? 0,
      capacity: resource.concurrency ?? 1,
      errorRate: resource.errorRate ?? 0,
      ttftMs: resource.ttftMs ?? 0,
      remaining: resource.remaining ?? 1,
      resetAt: resource.resetAt ?? null,
      marginalCost: resource.marginalCost ?? 0,
      affinity: resource.id === affinityResourceId ? 18 : 0,
    };
    const total =
      (10 - factors.priority) * 10 +
      factors.weight * 0.1 +
      (1 - factors.load / factors.capacity) * 10 -
      factors.errorRate * 100 -
      factors.ttftMs / 100 -
      factors.marginalCost * 10 +
      factors.affinity;
    return { factors, total: Number(total.toFixed(3)) };
  }

  candidatesFor(principal, request) {
    const route = this.routes.get(request.model);
    if (!route || !principal.models.includes(request.model)) {
      throw new GatewayError(403, 'model_not_allowed', '主体未授权该模型');
    }
    if (!route.capabilities.includes(request.capability)) {
      throw new GatewayError(422, 'capability_not_supported', '目标能力未启用', {
        capability: request.capability,
        model: request.model,
        retryable: false,
      });
    }

    const affinityKey = this.affinityKey(request.sessionId);
    const affinityResourceId = affinityKey ? this.affinity.get(affinityKey) : null;
    const candidates = route.resources
      .map((id) => this.resources.get(id))
      .filter((resource) =>
        resource &&
        resource.status === 'ACTIVE' &&
        resource.capabilities.includes(request.capability) &&
        (resource.inflight ?? 0) < (resource.concurrency ?? 1) &&
        (resource.remaining ?? 1) > 0)
      .map((resource) => ({ resource, ...this.score(resource, affinityResourceId) }))
      .sort((a, b) => b.total - a.total || a.resource.id.localeCompare(b.resource.id));

    if (candidates.length === 0) {
      throw new GatewayError(503, 'no_healthy_resource', '没有可用上游资源');
    }

    const affinityCandidate = candidates.find((item) => item.resource.id === affinityResourceId);
    if (affinityCandidate) {
      candidates.splice(candidates.indexOf(affinityCandidate), 1);
      candidates.unshift(affinityCandidate);
    }
    return { candidates, affinityKey, affinityResourceId };
  }

  applyBusinessPolicy(candidates, request) {
    const baseline = candidates[0];
    if (!request.highPeak || candidates.length < 2) {
      return {
        ordered: candidates,
        action: 'ALLOW',
        code: baseline.resource.id === request.affinityResourceId ? 'ALLOW_AFFINITY' : 'ALLOW_POLICY',
        saving: 'NOT_CALCULABLE',
        baseline: baseline.resource.id,
      };
    }

    const equivalent = candidates
      .filter((item) => item.resource.equivalentGroup && item.resource.equivalentGroup === baseline.resource.equivalentGroup)
      .sort((a, b) => (a.resource.multiplier ?? 1) - (b.resource.multiplier ?? 1));
    const chosen = equivalent[0] ?? baseline;
    const ordered = [chosen, ...candidates.filter((item) => item !== chosen)];
    const hasBaseline =
      chosen !== baseline &&
      Number.isFinite(baseline.resource.multiplier) &&
      Number.isFinite(chosen.resource.multiplier);
    return {
      ordered,
      action: chosen === baseline ? 'ALLOW' : 'SWITCH',
      code: chosen === baseline ? 'ALLOW_POLICY' : 'SWITCH_SCHEDULED',
      saving: hasBaseline ? { baselineMultiplier: baseline.resource.multiplier, actualMultiplier: chosen.resource.multiplier } : 'NOT_CALCULABLE',
      baseline: baseline.resource.id,
    };
  }

  recordAttempt(requestId, resource, number, outcome) {
    const usage = outcome.usage ?? { input: 0, output: 0, cache: 0, quality: 'UNAVAILABLE' };
    const attempt = {
      requestId,
      number,
      resourceId: resource.id,
      status: outcome.status ?? 0,
      committed: Boolean(outcome.committed),
      error: outcome.error ?? null,
      usage: { ...usage },
      cost: outcome.cost ?? 0,
    };
    this.attempts.push(attempt);
    const ledgerId = `${requestId}:${number}`;
    if (!this.ledgerLines.some((line) => line.id === ledgerId) && usageTotal(usage) > 0) {
      this.ledgerLines.push({ id: ledgerId, ...attempt });
    }
    return attempt;
  }

  settle(requestId, principal, attempts, dispatch, status) {
    if (this.settlements.has(requestId)) return this.settlements.get(requestId);
    const usage = attempts.reduce((sum, attempt) => ({
      input: sum.input + (attempt.usage.input ?? 0),
      output: sum.output + (attempt.usage.output ?? 0),
      cache: sum.cache + (attempt.usage.cache ?? 0),
    }), { input: 0, output: 0, cache: 0 });
    const qualities = [...new Set(attempts.map((attempt) => attempt.usage.quality).filter(Boolean))];
    const apiCost = attempts.reduce((sum, attempt) => sum + attempt.cost, 0);
    const deduction = attempts.reduce((sum, attempt) => {
      const resource = this.resources.get(attempt.resourceId);
      return sum + (resource.mode === 'PLAN' ? usageTotal(attempt.usage) * (resource.multiplier ?? 1) : 0);
    }, 0);
    const overage = principal.used + usageTotal(usage) > principal.quota;
    principal.used += usageTotal(usage);
    const saving = dispatch.saving === 'NOT_CALCULABLE'
      ? 'NOT_CALCULABLE'
      : usageTotal(usage) * (dispatch.saving.baselineMultiplier - dispatch.saving.actualMultiplier);
    const settlement = {
      requestId,
      status,
      usage,
      quality: qualities.length > 1 ? `MIXED:${qualities.sort().join('+')}` : (qualities[0] ?? 'UNAVAILABLE'),
      apiCost: Number(apiCost.toFixed(6)),
      deduction,
      overage,
      attemptCount: attempts.length,
      saving,
    };
    this.settlements.set(requestId, settlement);
    return settlement;
  }

  async handle(request) {
    if (this.settlements.has(request.id)) {
      return { replay: true, settlement: this.settlements.get(request.id) };
    }
    const principal = this.authenticate(request.key);
    if (principal.inflight >= principal.concurrency) {
      throw new GatewayError(429, 'principal_concurrency_exceeded', '主体并发额度已满');
    }
    if (principal.used >= principal.quota && !principal.allowOverage) {
      throw new GatewayError(429, 'principal_quota_exhausted', '主体额度已耗尽');
    }

    principal.inflight += 1;
    const metadata = {
      id: request.id,
      principalId: principal.id,
      model: request.model,
      capability: request.capability,
      sessionHash: this.affinityKey(request.sessionId),
      status: 'RUNNING',
    };
    this.requests.set(request.id, metadata);
    const requestAttempts = [];
    try {
      const selection = this.candidatesFor(principal, request);
      request.affinityResourceId = selection.affinityResourceId;
      const dispatch = this.applyBusinessPolicy(selection.candidates, request);
      this.dispatchEvidence.push({
        requestId: request.id,
        action: dispatch.action,
        code: dispatch.code,
        baseline: dispatch.baseline,
        candidates: selection.candidates.map(({ resource, factors, total }) => ({ resourceId: resource.id, factors, total })),
      });

      for (let index = 0; index < dispatch.ordered.length; index += 1) {
        const resource = dispatch.ordered[index].resource;
        resource.inflight = (resource.inflight ?? 0) + 1;
        let outcome;
        try {
          outcome = await this.upstream(resource, request, index + 1);
        } catch (error) {
          const cancelled = error?.name === 'AbortError' || request.signal?.aborted;
          outcome = { status: 0, committed: false, error: cancelled ? 'client_cancelled' : 'transport_error', cancelled };
        } finally {
          resource.inflight -= 1;
        }

        const attempt = this.recordAttempt(request.id, resource, index + 1, outcome);
        requestAttempts.push(attempt);
        if (outcome.cancelled) {
          metadata.status = 'CANCELLED';
          return { settlement: this.settle(request.id, principal, requestAttempts, dispatch, 'CANCELLED') };
        }
        if ((outcome.status ?? 0) >= 200 && outcome.status < 300 && !outcome.error) {
          metadata.status = 'SUCCESS';
          if (selection.affinityKey) this.affinity.set(selection.affinityKey, resource.id);
          return { settlement: this.settle(request.id, principal, requestAttempts, dispatch, 'SUCCESS') };
        }
        const retryable = !outcome.committed && (RETRYABLE.has(outcome.status) || outcome.error === 'transport_error');
        if (!retryable) break;
      }
      metadata.status = 'FAILED';
      return { settlement: this.settle(request.id, principal, requestAttempts, dispatch, 'FAILED') };
    } finally {
      principal.inflight -= 1;
    }
  }

  scanCanary(canary) {
    const stored = JSON.stringify({
      principals: this.principals,
      resources: [...this.resources.values()],
      requests: [...this.requests.values()],
      attempts: this.attempts,
      ledgerLines: this.ledgerLines,
      settlements: [...this.settlements.values()],
      affinity: [...this.affinity.entries()],
      dispatchEvidence: this.dispatchEvidence,
    });
    return stored.includes(canary) ? 1 : 0;
  }
}

export function forecastSupply({ remaining, speedsPerDay, nextRecoveryAt, now = new Date('2026-07-26T00:00:00Z') }) {
  const valid = speedsPerDay.filter((value) => Number.isFinite(value) && value > 0);
  if (!Number.isFinite(remaining) || valid.length === 0) {
    return { expectedExhaustionAt: null, coverageDays: null, nextRecoveryAt, confidence: 'LOW', reason: 'DATA_INSUFFICIENT' };
  }
  const speed = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const coverageDays = remaining / speed;
  return {
    speedPerDay: Number(speed.toFixed(3)),
    coverageDays: Number(coverageDays.toFixed(3)),
    expectedExhaustionAt: new Date(now.getTime() + coverageDays * 86_400_000).toISOString(),
    nextRecoveryAt,
    confidence: valid.length >= 3 ? 'HIGH' : 'MEDIUM',
    reason: 'MULTI_WINDOW_AVERAGE',
  };
}


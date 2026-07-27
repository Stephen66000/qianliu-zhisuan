# POC-03 计量与持久化闭环 Evidence

- 执行时间：2026-07-26
- Runtime：Node.js v22.17.1
- PostgreSQL：17-alpine（隔离容器）
- Redis：8-alpine（隔离容器）
- 状态：**PASS**

## 冻结制品

| 文件 | SHA-256 |
|---|---|
| `gateway-spike.mjs` | `dc63224eb27f102da11d3aa1848a0cfa31a13e5d37dce9af550b426ef7a86ece` |
| `gateway-spike.test.mjs` | `13d2d5b2a5d78467a0cb1a9c16888ff466b90eb2b50a88b318b152c3ea188876` |
| `bench-100.mjs` | `8c8f0c3fee31ad1655f06639cfa3aea24298776368a37f5fe1f49b7e77803c89` |
| `persistent-gateway/package.json` | `c78c5b32063ab065ceda8754f40731c0f87925a9a3abe5b0811e58deb7ac2e68` |
| `persistent-gateway/pnpm-lock.yaml` | `8081735b2edfa199132185f37bef09909541fa6d94a585315f85980ebb58c1b2` |
| `persistent-gateway/schema.sql` | `c0652eb25cda3ba37c634df9cb58496d296f36a7cd8590f987881c9515b0b45f` |
| `persistent-gateway/test/integration.test.mjs` | `26608169eed097ddad4abed07fafc3acc376e8f054d859918612e1d1ac32c24e` |

## 原始执行命令

```bash
docker compose up -d --wait
corepack pnpm@11.11.0 test
node --test ../gateway-spike.test.mjs
node ../bench-100.mjs
```

## 原始结果

```text
持久化集成测试：12/12 PASS，duration 368.526 ms
核心状态机回归：18/18 PASS，duration 97.703 ms
100 并发：100 success，100 unique settlements，elapsed 2.783 ms
PostgreSQL：requests=3，attempts=3，settlements=3，dispatches=3
Redis：3 个 idem 键，1 个 HMAC affinity 键；无 Session 明文
```

实际 HTTP 进程冒烟：

```text
GET  /v1/models            200
POST /v1/chat/completions  200
POST /v1/messages          200
```

## 已证明

1. PostgreSQL 保存 request、逐 Attempt、dispatch 和唯一 settlement；唯一约束防重复结算。
2. Redis 保存请求锁、幂等缓存和 HMAC Session Affinity；Redis 缓存删除后可从 PostgreSQL 恢复结算。
3. JSONL 日志只允许元数据白名单。
4. OpenTelemetry Trace 只记录 request ID、模型、能力、状态、Attempt 数和耗时。
5. 正文 canary、主体明文 Key、Session 明文在 PostgreSQL、Redis、日志、Trace 中均为 0 命中。
6. DeepSeek、智谱、Kimi Secret 只从环境变量注入，序列化强制脱敏。
7. 18 项原状态机能力全部回归，包括双 Attempt、流式提交边界、Affinity、取消、额度、经营调度和正文零留存。

## 边界

- 这是隔离 POC，不是生产部署。
- 上游调用在本轮持久化测试中使用可控 Stub；三厂商可行性沿用 POC-02 既有结论。
- 真实 Provider Adapter、生产级迁移、备份、监控和容量基线属于开发里程碑。

## 判定

Stage 01 要求的 PostgreSQL、Redis、日志、Trace、幂等和正文零留存闭环已完成，**POC-03 PASS**。

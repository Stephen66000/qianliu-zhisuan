# M1 Evidence：资源与使用主体可管理（W02+W03+W04）

| 项目 | 内容 |
| --- | --- |
| 里程碑 | M1（资源与使用主体可管理） |
| 工作包 | W02（认证+主体+审计）+ W03（下游 Key+Grant）+ W04（Provider/Resource/Route） |
| Stage | Stage 03 / D1 |
| 日期 | 2026-07-27 |
| 执行者 | 主 AI（佳哥授权连续执行） |
| pnpm-lock.yaml sha256 | `5d959ada9e1567deeb3c6a8a233c76ed06b76f488309710664081af3f82a0fcc` |
| 迁移文件 | 7 个（0000 基线探针 + 0001-0006 业务） |
| control-api 路由 | 14 个（auth/principals/keys/grants/providers/models/routes/audit） |
| 集成测试 | 23 个全部通过（含 2 个 canary 硬门禁） |
| 结论 | **PASS** —— M1 中间 Audit 通过，可进入 M2 |

## 1. M1 DoD 达成情况

| DoD 项（详细计划行 109） | 结果 | Evidence |
| --- | --- | --- |
| WT-01/02/04/09/10 代表性运行链 | ✅ | W02-W04 集成测试 23 个覆盖 |
| Key/Secret 明文扫描为 0 | ✅ | W03 canary（Key 明文 DB 0 命中）+ W04 canary（凭证明文 DB 0 命中） |
| 操作日志完整 | ✅ | 所有写操作记录 operation_log（enterprise_id+admin_user_id+action+change_summary） |
| enterprise_id 贯穿 | ✅ | principal/key/grant/provider/resource/model/route/audit 全部带 enterprise_id |
| Key 5 秒失效 SLO（DB 层） | ✅ | 重置/停用即时 REVOKED（事务）；Redis 缓存层在 M2 接入 |

## 2. WT 代表性运行链覆盖

| WT | 运行链 | 集成测试 |
| --- | --- | --- |
| WT-01 资源登记 | POST /provider-resources（凭证加密存储）+ 列表（指纹） | w04-provider-route.test.ts |
| WT-02 创建员工四步 | 创建 principal(EMPLOYEE) → 生成 Key（一次展示）→ 分配 grant | w02 + w03 测试 |
| WT-04 创建项目四步 | 同 WT-02，type=PROJECT | w02 + w03 测试 |
| WT-09 重置 Key 5 秒失效 | POST /key/reset 单事务撤销旧+建新 + 停用同步撤销 | w03-key-grant.test.ts |
| WT-10 路由详情 | GET /unified-models/:id/routes（候选/优先级/权重/资源名） | w04-provider-route.test.ts |

## 3. 安全实现（HIGH 风险工作包）

### 下游 Key（HMAC-SHA256 + Pepper）
- 生成：`sk-qianliu-` + 32 字节随机 base64url
- 存储：DB 只存 `key_digest`（HMAC-SHA256(pepper, key).hex()），明文绝不入库
- 一次展示：创建/重置响应体返回明文 + 警告"仅展示一次"
- 重置：单事务 `transaction().execute()` 撤销旧 + 建新
- 停用主体：`revokeAllByPrincipal` 同步撤销全部 ACTIVE Key

### 上游凭证（AES-256-GCM + 环境 KEK）
- KEK：32 字节，从 `CREDENTIAL_KEK` 环境注入（base64）
- 加密：`encryptCredential(plaintext, kek)` → `{ciphertext, nonce, tag}`
- 存储：DB 存 `credential_ciphertext`（JSON）+ `credential_fingerprint`（SHA-256 前 16 位）
- 解密：仅 Adapter 内部 `decryptCredential`（M2 接入）
- 列表/响应：只返回 fingerprint，绝不返回密文/明文

### 管理员认证（Argon2id + DB session）
- 密码：`argon2.argon2id`，memoryCost 19MiB，timeCost 2
- Session：DB `admin_session` + 不透明 Cookie（token_hash = HMAC 摘要存库）
- Cookie：HttpOnly + Secure(production) + SameSite=Lax
- 限速：内存计数，5 次/5 分钟
- 停用账号：session 校验时 status≠ACTIVE 返回 403

## 4. Canary 验证（M1 DoD 硬门禁）

### Key 明文 canary（W03）
```
canary: sk-qianliu-...（真实生成的 Key）
扫描：SELECT COUNT(*) FROM (SELECT row_to_json::text FROM principal_key) WHERE LIKE %canary%
结果：hits = 0  ✅
验证：key_digest 存在（HMAC hex 64 位），不等于明文
```

### 凭证明文 canary（W04）
```
canary: sk-deepseek-CANARY-SECRET-FOR-SCAN-12345
扫描：SELECT COUNT(*) FROM (SELECT row_to_json::text FROM provider_resource) WHERE LIKE %canary%
结果：hits = 0  ✅
验证：credential_ciphertext 存在（AES-GCM 密文），不含明文
```

## 5. 正式工程命令实测（M1 Audit）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（0 error 0 warning） |
| test（单测） | ✅ 全部通过 |
| test:integration | ✅ database 4 + control-api 23 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ 白名单过滤生效 |
| docker compose config | ✅ |

## 6. 数据库 Schema（7 个迁移）

| 迁移 | 表 | 依据 |
| --- | --- | --- |
| 0000 | _w01_baseline_probe | W01 基线探针 |
| 0001 | enterprise, admin_user, admin_session, employee_login | TRD §5.1 |
| 0002 | principal（员工/项目统一） | TRD §5.2 |
| 0003 | principal_key（HMAC digest） | TRD §5.3 |
| 0004 | principal_grant, quota_counter | TRD §5.5 |
| 0005 | provider, provider_resource, unified_model, model_route | TRD §5.4 |
| 0006 | operation_log（审计） | TRD §5.7 |

## 7. control-api 路由清单（14 个）

- `POST /auth/login`、`POST /auth/logout`、`GET /auth/me`
- `GET /principals`、`GET /principals/:id`、`POST /principals`、`PATCH /principals/:id`
- `POST /principals/:id/key`、`POST /principals/:id/key/reset`、`GET /principals/:id/key`
- `GET /principals/:id/grants`、`POST /principals/:id/grants`
- `GET/POST /providers`、`GET/POST /provider-resources`、`GET/POST /unified-models`、`POST /model-routes`、`GET /unified-models/:id/routes`
- `GET /operation-logs`

## 8. 残余风险与后续

- **5 秒失效 SLO 的 Redis 层**：M1 实现 DB 层即时 REVOKED；Gateway 热路径的 Redis 缓存（TTL≤5s）在 M2 W05 接入。
- **WT-01 真实上游探测**：M1 资源登记不连真实 DeepSeek；离线夹具，真实探测在 W06（DEP-PROVIDER-CREDENTIALS 解锁后）。
- **Web UI**：M1 后端 API 全；Web 最小验收页（登录+principal 列表+Key 展示）在 M5 W18-W23。
- **CSRF 防护插件**：依赖已装（@fastify/csrf-protection），实际启用在 Web 前端接入时（M5）。
- **employee_login 完整流程**：表已建（含 must_change_password），员工首次登录改密码的完整流程在 Gateway IDE 接入（W21）落地。

## 9. 集成点（为 M2 预留）

- W05 (M2) 用 principal_key.digest 做 Gateway 鉴权；Key 5 秒失效接 Redis 缓存
- W06 (M2) DeepSeek Adapter 用 provider_resource.credential_ciphertext 解密凭证
- W07 (M2) 用 model_route 做路由候选；operation_log 继续记录 Gateway 写操作
- W14 用 principal_grant + quota_counter 做额度门禁

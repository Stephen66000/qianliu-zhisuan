# 仟流智算首次生产发布候选锁

- 冻结时间：2026-08-01T15:06:33+08:00
- 产品版本：`v0.3.0`
- Git commit：`dd80e975ff6cc88e5dab3967479c299bc778b0ac`
- Git tree：`cf750eae5ed2e701c0c7ccfac51028cb9be244e9`
- 提交时间：`2026-08-01T14:37:20+08:00`
- 发布范围：`Gateway / Control API / Web / Worker / Caddy / 0030 / 0031`
- 生产回滚基线：发布前只读核对的当前 Release，以生产备份和旧 Release 路径为准。

## 关键文件 SHA-256

```text
15ca915091e648996c5fd6eb2bbc8b8c4d7ff972d4db9164a28594bafd839d11  package.json
11cd9d02588a5920946355ff4996f5cea98a6fcb52cfd51381671fdd3c34a636  pnpm-lock.yaml
6ccadd69ee364497617674e739008a5f5ffd5109d0c964496cbbcc73259566c6  deploy/compose.yaml
4ac0c0f85548f695720a1761bfccf77064ab03cc04f876c77379021944fa659e  deploy/caddy/Caddyfile
9955e37eabe8b38330a47741a2af8a8794f0b1577ea939373c38c28fd77474d8  apps/control-api/Dockerfile
9ca2c998ec3e86a5b3a4c0fe18c42bf16e6be1ae55bb487891ae84b5bcf77247  apps/gateway/Dockerfile
d648856513e3f606bdf5f398d9410513763d2ef2ab38223eeb74fef4b0eb16de  apps/web/Dockerfile
cc40df8690f9aee533081ff0b165cc8eb76e01b93d7641fa88926a69c1aebd97  apps/worker/Dockerfile
480612e93b15f1b54ffec11de2d149c2826999488bfc15a4e02954b1bf2feab6  packages/database/migrations/0030_runtime_assurance_foundation.js
9fcb5fade54f6ef0d88a6ffb31c8ca6747e756ba6b9e1dc870820d8996e75cd4  packages/database/migrations/0031_gateway_stream_resilience.js
```

## 发布边界

1. 只发布上述冻结 commit 的已验收内容，不从其他工作树拼补代码。
2. 保留现有生产 `.env`、Secret、PostgreSQL 数据卷、用户工作树和无关未跟踪文件。
3. 生产库必须先备份，再按 `0030_runtime_assurance_foundation` →
   `0031_gateway_stream_resilience` 顺序升级，不得跳号。
4. 回滚点由“发布前 Release 路径 + 发布前数据库备份”组成；具体路径在
   Mac Mini 只读核对后回写，不在客户端猜测。

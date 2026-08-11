# 仟流智算 1.0 代码与版本交付清单

| 项目 | 内容 |
| --- | --- |
| Git 远端 | `git@github.com:qianliu-ai/qianliu-zhisuan.git` |
| Review 分支 | `codex/v1-final-review-20260811` |
| 版本 | `1.0.0` |
| Node／pnpm | `22.17.1`／`11.11.0` |
| 锁文件 | `pnpm-lock.yaml` |
| 数据库迁移 | `0001`～`0044_operating_bill_model_identity` |
| 最终代码 Commit | R16 本地提交后写入 `RELEASE-MANIFEST.yaml` |
| 最终 Tag | Owner 批准后创建；旧 `v1.0.0` 不移动 |

## 交付规则

- Git Commit／annotated tag 是全套代码权威源；
- 本目录在 Owner 决定后补充 `RELEASE-MANIFEST.yaml`、Git Bundle、源码归档和 Hash；
- `.env`、生产凭证、Key 明文和备份数据不进入源码交付；
- 数据库结构由迁移链重建，生产业务数据由受控备份单独管理；
- 最终 tag 创建后，任何产品代码变更必须进入 1.0.x 或 2.0，不能静默改写 1.0 Final。

## 获取与核验

```bash
git clone <repo>
git checkout <final-tag>
corepack pnpm@11.11.0 install --frozen-lockfile
corepack pnpm@11.11.0 run quality
```

离线交付使用本目录生成的 `.bundle`：

```bash
git clone 仟流智算-1.0-final.bundle 仟流智算-1.0
```


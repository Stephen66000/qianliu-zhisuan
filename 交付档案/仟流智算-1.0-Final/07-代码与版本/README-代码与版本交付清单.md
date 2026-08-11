# 仟流智算 1.0 代码与版本交付清单

| 项目 | 内容 |
| --- | --- |
| Git 远端 | `git@github.com:qianliu-ai/qianliu-zhisuan.git` |
| Review 分支 | `codex/v1-final-review-20260811` |
| 版本 | `1.0.0` |
| Node／pnpm | `22.17.1`／`11.11.0` |
| 锁文件 | `pnpm-lock.yaml` |
| 数据库迁移 | `0001`～`0044_operating_bill_model_identity` |
| 已审核代码 Commit | `684b2d5f083282c3d90e703c427d044855036282` |
| 已审核代码 Tree | `a74e522d3addd96d82f29eae13e671c4931c042f` |
| 最终归档 Tag | `v1.0.0-final`（annotated；旧 `v1.0.0` 不移动） |
| 生产部署 Commit | `0dd283e7d9fef97ef4d2af85a60ba240295599aa`；未因本次 Review 重新部署 |
| Manifest | `RELEASE-MANIFEST.yaml` |
| Final 交付根目录 | `/Users/mac/Projects/仟流智算-1.0-Final交付包` |

## 交付规则

- Git Commit／annotated tag 是全套代码权威源；
- 本目录包含 `RELEASE-MANIFEST.yaml`；Tag 创建后生成的 Git Bundle、源码归档、最终锁和 Hash 存入 Final 外部交付包的同名目录；
- `.env`、生产凭证、Key 明文和备份数据不进入源码交付；
- 数据库结构由迁移链重建，生产业务数据由受控备份单独管理；
- 最终 tag 创建后，任何产品代码变更必须进入 1.0.x 或 2.0，不能静默改写 1.0 Final。

## 获取与核验

```bash
git clone <repo>
git checkout v1.0.0-final
corepack pnpm@11.11.0 install --frozen-lockfile
corepack pnpm@11.11.0 run quality
```

离线交付使用本目录生成的 `.bundle`：

```bash
git clone 仟流智算-1.0-final.bundle 仟流智算-1.0
```

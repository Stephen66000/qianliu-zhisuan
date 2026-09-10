# 标准版首页生产兼容候选

2026-09-10。生产基线以用户Mac Mini回执为准：e96e6446d214294ca6b567e7fcd3d4d437c763c4，migration 0073_credential_chat_probe，release qianliu-resource-model-visibility-e96e644-20260910-171331。

从该生产commit隔离建立codex/home-standard-release-20260910，重放934b372首页候选。不是直接部署开发分支。

## 兼容处理

1. provider-finance-repository唯一冲突：保留生产对UNKNOWN_COST使用operatingConsumptionFilter的过滤；将条件随权威缺口函数迁移到provider-finance-gaps，保留历史采购/订阅读取及月初余额能力。
2. 首页上月同期费用复用生产historicalMonthlyFinance，补齐既有历史套餐登记，避免当期与同期来源不一致。金额合计沿用Money定点工具。
3. 增加2项真实PG回归：历史套餐采购进入同期199元；无消耗失败审计行不产生未知费用缺口。

## 验证

- 全工作区typecheck PASS、lint PASS、source-size PASS。
- 首页前端56/56；database首页/桥接/经营历史35/35；control-api首页权限/金融/Chat凭证恢复/资源模型展示27/27，共118项通过。
- web生产build PASS（既有bundle体积warning保留，不是构建失败）。
- release-home-standard-20260910-mac-mini.sh --check-contract PASS，仅语法验证，未执行生产部署。
- 相对生产基线的migrations、gateway、worker、domain、provider-adapters和compose拓扑无改动。

## 部署约束

脚本只在--deploy明确参数下执行；要求生产仍为e96e644、migration仍0073、工作目录干净且无部署锁，检验候选commit/tree和生产祖先。保留.env，备份运行中的应用镜像，构建时不切流，更新应用容器，不运行migration或修改数据库。失败恢复旧镜像/目录并检查健康，无法确认回滚时保留明确失败回执。
本次证据只证明生产兼容候选本地验证，不替代已审核C5结论，也不代表已推送或已部署。远端传送与生产执行待用户授权。

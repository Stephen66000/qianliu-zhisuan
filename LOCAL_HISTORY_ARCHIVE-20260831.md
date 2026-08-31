# 本地历史资料归档说明（2026-08-31）

本分支用于保存此前只存在于 `/Users/mac/Projects/仟流智算` 工作区、尚未进入任何当前可达 Git 引用的历史资料。

## 冻结边界

- 归档基线：`origin/main` / `v2.3` / `bfbcae312b90e0ac98b6ff765645715d3336e60e`
- 来源工作区当时 HEAD：`7e30840`
- 新增资料：106 个文件
- 范围：V3/V4 方案、PoC、Evidence、原型、知识库、设计素材与历史评审资料
- 不包含：源代码工作区中的未提交产品修复

## 排除项

以下三个文件与其正式版本字节完全一致，因此不重复归档：

- `V3/Evidence/Production-Release/20260806-pool033/rollback-to-029030-粘贴版.sh`
- `V3/Evidence/Production-Release/20260806-pool033/run-release-粘贴版.txt`
- `V3/Evidence/Production-Release/20260807-pool031035/run-release-粘贴版.sh`

已在其他 Git 引用出现过的路径也不纳入本次归档，避免用旧副本覆盖当前版本。

## 敏感信息检查

提交前对文本和 XLSX 内容执行了高风险模式检查，包括私钥、AWS/GitHub Token、JWT、API Key 与 Secret 赋值。未发现高置信度真实凭证；命中项均为隔离 PoC 的本地数据库密码、原型演示 Key 或以 `kimi-` 开头的模型名称。

本归档只证明资料被保存，不代表其中的历史方案仍是当前产品合同，也不授权部署其中的历史脚本。

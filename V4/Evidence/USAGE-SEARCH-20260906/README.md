# 用量账本搜索与筛选调整

验证快照：本地实现与验证通过。提交与推送状态以 Git 记录为准；本记录不代表已部署。基线与文件 SHA256 见 source-manifest.json。

## 交互

- 概览补齐输入框/选框样式、字段标题，增加查询按钮与回车确认；唯一完整名称匹配后应用主体，重名/无精确匹配时提示从列表选择。下拉选项附部门，单页候选隐藏翻页按钮。清空关键词并查询恢复全部主体。
- 请求明细改为“用量搜索”，提示“主体、姓名或项目”；输入关键词不立即改变结果，点击查询或回车提交，重置页码。桌面每行四项，窄屏两列/一列。
- 后端搜索增加部门和归属项目名称，沿用现有快照优先、历史项目分配回退口径。旧 URL 的请求 ID 搜索保持兼容，结果表的请求 ID 仍可用于明细定位。
- 页面说明改为查找用量、核对具体消耗的业务描述。

## 验证

- 前端：Usage 9 + UsageOverviewPanel 11 + Dashboard 14 = 34/34；见 web-tests.log。
- PostgreSQL Testcontainers：usage-repository 4 + usage-overview 12 = 16/16，临时隔离容器；包含姓名/部门/项目归属搜索、快照优先、分页总数、SQL 通配符转义和企业隔离。执行结果记录在本任务工具输出，运行时长 16.91 秒。
- Web build（含 TypeScript）、database typecheck、修改文件 ESLint、source-size 与 architecture、git diff --check 均通过。
- 实际生产构建 + Chrome 自动化：查询按钮、回车、清空、主体确认、候选分页和 1440/1024/390 筛选布局通过，见 browser-check.json。截图已人工检查。
- 浏览器使用组件测试夹具拦截 API，仅验证前端行为与布局；截图不是生产数据，也不是线上验收。脚本 browser-check.cjs 可在本地 5187 预览服务运行时复现。

## 截图

- overview-desktop.png：概览筛选区。
- details-desktop.png：请求明细四列筛选。
- details-mobile.png：窄屏单列筛选。

初轮新增前端断言与测试 URL 探针的隐含 status 角色冲突，已按提示文本定位修正。浏览器几何断言初轮遇到搜索提交后输入框重建，已等待元素稳定再检查，最终全部通过。

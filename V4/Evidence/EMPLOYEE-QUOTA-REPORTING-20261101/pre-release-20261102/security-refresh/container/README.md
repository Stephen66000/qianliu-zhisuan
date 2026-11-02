> 最终预览链接已更新为 [团队勾稽一致版](consistent-preview/linux-amd64-company-consistent.png) 与 [个人勾稽一致版](consistent-preview/linux-amd64-personal-consistent.png)。仅外部合成fixture校正：原输入/PNG作initial保留，具体整数校验与输入hash见consistent-preview/README.md。原构建/PG/健康结果不重跑，产品/lock/镜像/context不变。

# 最终实际业务候选 Linux/amd64 容器验收

**工程检查 PASS**：第三lock、Node22.23.4、最终冻结源码实际构建并运行四个 Linux/amd64 镜像。该结果不代表生产部署或T27—T30业务验收。

用户已接受按实际业务路径收口。未用WorkbookReader仅UNCERTIFIED，原失败探针完整保留，不阻断；未patch第三方，也不宣称ExcelJS全部API兼容。

## 身份与实际执行

- sourceSnapshot：`d619248548f227df9d1eddd12ebbf034918326400f22508e6677dd0a93208912`，1322个实际窄context文件，见 `source-snapshot.json`。这是源码快照，**不是Git提交SHA**。
- lock SHA：`3bebc5d88ca86fdfad321e6c74bb144718b1c86a97d4ec82552ea6961e35ef90`。
- 最终token-utilization源 SHA：`8d69dcaf88bbb2fbafb336cd01c5f616d337ead2a0de2ddb99b6de261ed8878f`；包含既有snapshot事务的SET LOCAL work_mem16MB。原SQL、迁移、lock不变，18项受影响回归见 `../../database-full-remediation/resource-memory-fix-regression.log`。
- 四镜像实际linux/amd64，镜像ID/label见 `runtime-result.json`，build命令及exit0见 `build-results.json` 和四份完整build日志。旧Node22.17.1镜像/证据未改标或覆盖。
- Docker Desktop daemon为Linux/arm64，amd64通过跨架构执行；实际子进程明确Linux/x64、Node22.23.4、ICU78.3、tz2026e。不能据此声称生产所有容器架构或版本已经升级。

## 验证结果

| 检查 | 实证 |
|---|---|
| 四镜像构建 | Worker/ControlAPI/Gateway/Web各exit0；Web真实Linux contracts/domain build与tsc/vite→nginx |
| PG/Redis | 本轮全新实例，固定既有digest，实际PG17.10/Redis8.8.1，PONG |
| 0092 | 正式Migrator最新0092；月账表存在，合成三厂商池初始化3；同员工事实1000Token/4模型，历史余额仍待核 |
| 真正0091 | 另一全新_e2e库正式migrateTo0091，月账表确实不存在；新Worker A段1000Token/4模型/历史待核读取成功，initializer返回0；未用删表或0092down假造 |
| 生产入口健康 | ControlAPI/Gateway health200，Worker容器回环health200；Web首页200及/api/health真实nginx反代200 |
| Worker真实tick | 再读health lastSuccessAt非空、lastErrorAt=null；报告delivery状态DISABLED |
| Linux字体/Canvas | Worker镜像内fc-list含WenQuanYi Zen Hei/DejaVu；真实native Canvas渲染，无Mac字体/图片生成替代 |
| 合成1080PNG | `consistent-preview/linux-amd64-company-consistent.png`1080×2168、`consistent-preview/linux-amd64-personal-consistent.png`1080×2294。已实际看两图：中文无缺字、七成员/Flash与非Flash两行/长姓名/厂商单位/超额待核可读，额度块不覆盖表格 |

字体清单、完整SVG、PNG、渲染Node/ICU/tz见同目录。所有报告数字为合成布局夹具，不是生产十月账本复算或实际收到证据。

## 隔离与协调

不读/拷用户.env，不复用用户DB/volume。源码窄context无.env/宿主node_modules/dist；合成密码、KEK、pepper、cookie只在child env；证据无带凭据连接串。唯一私有bridge网络、随机127宿主端口，Worker按原生产合同容器内127.0.0.1:9191。Web构建Gateway URL及WEB_ORIGIN绑定本轮实际随机端口。

配置NODE_ENV=production，finance=DARK、目录同步false、企微通知false、delivery paused；只有合成员工/授权/用量，无外部资源凭据、通道或接收人。HTTP检查仅本机回环/本轮私网，不访问实际模型服务或企微。

构建严格串行。四镜像自然结束后完全停止负载，让B独占执行原百万行/2warmup/20samples/四门槛容量文件：2tests真实PASS、75.10s，**未输出四个精确P95，未重建或编造数值**。容量释放后只做本次一次runtime验证，随后正常停止删除本轮命名容器及其匿名卷/network，已复查无残留，测试镜像保留。没有全局prune或删除用户资源。

本轮实际命令（重放需独立证据目录，以免覆盖冻结记录）：

```sh
python3 V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/pre-release-20261102/security-refresh/container/prepare-context.py
PATH=<project-local-node22.23.4-bin>:$PATH node V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/pre-release-20261102/security-refresh/container/build-images.mjs
PATH=<project-local-node22.23.4-bin>:$PATH node V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/pre-release-20261102/security-refresh/container/run-isolated-runtime.mjs
```

实际冻结context位置保存于 `context-location.json`；构建器在镜像边界支持build-control暂停/恢复，不打断当前构建。未部署、推registry、生产迁移、历史补扣或发送消息；T27—T30继续待真实发布/窗口/回执/接收确认。

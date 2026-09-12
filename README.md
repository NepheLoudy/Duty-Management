# duty-bot · 值日提醒机器人

实验室/战队值日排班与提醒机器人：一张多维表格 + 队员私信闭环。排班轮转、缺勤补偿、
私信提醒与收口、照片凭证写表、值日助手（私信说明/群看板 + 每日看板自动播报）、
对外值日数据接口。

完整规划见工作区 `duty-bot-plan.md`（含隐私信息，仅本地留存，不入 git）。

## 架构位置（铁律合规）

- 独立项目（仓库根目录，与 approval-bot 平级），**纯定时任务 + 被动指令服务**，无自己的长连接；
- 队员私信与群指令：gateway（唯一长连接）→ hub（project-management-robot）→ 本服务
  `POST /api/chat/command`；**不在网关为本项目加消息直连路由**；
- **名册自动读飞书通讯录**：启动/生成排班前/`POST /api/duty/roster/refresh` 时全员同步
  （open_id 直取组织架构，无需逐人绑定；「绑定 姓名」降级为人工纠错兜底，admin 标记按姓名保留）；
  白名单（`config/whitelist.json`）仍为排除名单；定制窗口：`GET /api/duty/roster`、
  `GET|POST /api/duty/whitelist`（规则见顶层 AGENTS「机器人后端定制窗口」）；
  **白名单/名册的权威在 NAS 侧文件**（运维台直写），本地 `config/*.json` 只是种子——
  push.js 上传前会自动备份 NAS 现网版本，本地条目数少于现网时跳过上传（`PUSH_FORCE_PRIVATE=1` 强制覆盖），见顶层 AGENTS「运行时数据保护」；
- **值日域管辖策略（权限管辖范畴/生效范畴）以本项目为单一事实来源**：`.env` 的
  `DUTY_GROUP_CHAT_IDS` 配置管辖群，经 `GET /api/duty/policy` 下发给 hub——看板触发词、
  基础指令关闭、未命中引导语、p2p 指令清单都随策略下发（关键词回答已全群统一，
  不再属于值日策略生效范畴，2026-09-13）；
  hub 群内闸门照此执行，本服务失联时 hub 以其本仓 env 短暂兜底；
- 定时私信提醒/收口为主动发送（Open API，应用身份），不受对话铁律限制；
- 群看板卡片走**群自定义机器人 webhook**（`DUTY_BOARD_WEBHOOK_URL`，非对话型 im API；
  未配置时回退应用身份直发）；**每日 12:00 自动播报同一张值日看板卡（今日 + 昨日战报）**
  （`DUTY_BOARD_BROADCAST_SCHEDULE`，过静默闸门；未配置 webhook 或推送失败时同样回退
  应用身份直发管辖群，无排班记录自动跳过）；
- **M4「昨日值日播报」已于 2026-09-12 落地**：以 duty-bot 自身看板卡扩展实现（昨日战报段），
  原规划「pm-robot 经 webhook 渲染发送」的方案作废，`GET /api/duty/brief` 保留为通用数据接口。

## 数据模型（多维表格 = 单一事实来源）

每日一组 3 条记录（每人一条），按「日期」分组：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| 姓名 | 文本（主键） | 全员照常排班；未绑定成员靠姓名识别 |
| 人员 | 人员 | 已绑定成员写入（可直接取 open_id 私信） |
| 日期 | 日期 | 分组依据 |
| 岗位 | 单选 | 总负责 / 工位区 / 装配区 |
| 凭证-负责 / 凭证-工位 / 凭证-装配 | 附件 ×3 | 照片按本人岗位入列，每人只填自己那列 |
| 完成状态 | 单选 | 已做完 / 已请假 / 未做完（空=待定） |
| 当日总状态 | 单选 | 今日完成值日（三条记录同步写） |

当日总状态判定：三个附件栏各有 ≥1 个附件 **且** 3 条完成状态均为已做完。

> 生产表（2026-09-11 接线）：`机器人项目看板` 库 ·「值日看板」表，列名经 `.env` 的 `DUTY_FIELD_*`
> 映射——姓名 / 人员(人员) / 值日时间(日期) / 负责区域(岗位) / 附件1·附件2·附件3(凭证×3) /
> 完成状态 / 该组总状态(当日总状态；文本列或单选皆可，`npm run table:check` 两者均收)。

> 轮转配额为**三岗均等**：每人每轮 总负责/工位区/装配区 各 1 次（3 班次/轮，一轮恰好 N 天），
> 与「每天三岗位各一人」数学自洽；每天严格一岗一人，同岗两人仅出现在缺勤插入日。
> （2026-09-11 确认：不再要求总负责×2。）

## 排班规则

- **生成**：管理员（名册 `admin:true`）私信「生成排班表」→ 从表格最后一个已排日期的次日
  （空表则明天起）按日历生成 1 个月；轮转跨批次连续（配额从表格既有记录反推，不存双份状态）；
  生成后回执条数、起止日期与每人配额核对表；
- **约束**：同日人员互不相同、三岗位各一人；岗位配额精确（每人每轮三岗各 1）；两次值日间隔
  ≥2 天（软约束，人少放宽）；岗位分配顺序按日期轮换+种子随机（同参数可复现）；
- **缺勤补偿**（可突破轮次上限）：已请假/未做完 → 下周（自然周）插入 +1 次：
  下周已生成就地插入（空位日 + 当周岗位计数最少岗，该日变 4 人）；未生成则排队、生成时优先安置；
  **连续两次**缺勤/请假额外多插 1 次（该缺勤周期共 3 次）；
- **请假当日补位**（2026-09-12 口径：请假必须有补位）：登记请假时立即从「更远的排班」抽调一人
  当日顶上——候选为值日队列中在其后仍有排班者，同岗优先、排班日最远者优先；抽调是**加插**
  而非对调（被抽调者远期班次保留，私信告知补位），请假人仍进下周补偿（总量守恒）。
  找不到可抽调人选时当日空缺、管理员回执可见；未做完（收口才发现）无法当日补位，仍走下周补偿。

## 定时任务（Asia/Shanghai，全部可配，过晚间静默闸门）

| 时刻 | 任务 | 说明 |
| --- | --- | --- |
| D-1 20:00 | 次日提醒 | 私信明日值日队员（岗位+职责+请假引导） |
| D 日 18:30 | 当日询问 | 私信询问，开启监听窗口（打卡/否/照片）；成员有未过期 DDL 逾期确认时额外附冲突提示（查 hub /api/ddl/pending，失联降级不加） |
| D 日 22:00 | 收口 | 未「打卡」置未做完（只传照片没打卡同样置未做完并回执提示）；算当日总状态；生成补偿义务。**写表动作不延迟**，仅回执通知过闸门 |
| 每日 00:30 | 对账 | 重算昨日总状态（兼容手工改表）、核对补偿插入义务、回执管理员 |
| 每日 12:00 | 看板自动播报 | 值日看板卡片（**今日三岗 + 昨日战报，一个面板同时播昨天今天**）经群自定义机器人 webhook 推到值日播报群；未配置 webhook 或推送失败时回退应用身份直发管辖群（两者都不可用才跳过）；无排班记录跳过 |

晚间静默窗口（默认 02:00–09:00）内：提醒/询问/对账登记积压、09:00 整点以最新数据重跑；
收口回执为一次性通知，落盘按序补发；对话回复与 `/api/bot/test-*` 手动触发不受限。

## 值日助手（指令，hub 转发）

- 私信（精确匹配）：`值日助手`（用法说明）、`查询我的下一次值日`、`我要请假`、
  `绑定 姓名`、`打卡` / `打卡了`（**完成打卡主词**，2026-09-13 起）/ `否`、`生成排班表`（仅管理员）；
  「是」与打卡口语变体（`是的`/`好`/`完成了`/`做完了`/`搞定` 等）兼容保留，
  在**有当日活跃询问会话**时等同「打卡」，无会话静默交还 hub（不发未识别提示，不接管闲聊）；
- 群聊（@机器人）：`值日助手` → 今日值日看板卡片（带不带 `/` 均可，hub 群门双形态
  匹配后转发），每群 1 小时限流，命中静默。
  卡片经群自定义机器人 webhook 发送（`DUTY_BOARD_WEBHOOK_URL`，可选
  `DUTY_BOARD_WEBHOOK_SECRET` 签名），限流/管辖按来源群 chatId 计；未配置时回退应用身份直发。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含静默窗口状态） |
| POST | `/api/chat/command` | hub 指令转发：`{command, openId, chatType, chatId?, messageId?, args?}`；图片 `{type:'image', openId, imageKey, messageId}`；返回 `{reply, handled}`，reply 空串=已自行处理（群看板卡片）或未接管（无会话口语变体，hub 落回常规流程） |
| GET | `/api/duty/brief` | 昨日结果+今日名单一次取齐（M4 已由看板卡自身实现；本接口保留为通用数据接口） |
| POST | `/api/bot/test-remind` / `test-ask` / `test-close` / `test-reconcile` / `test-generate` / `test-board` | 手动触发（body `{"dryRun":true}` 只预览不发送/不落表） |
| GET | `/api/bot/cron-status` | 定时任务与静默状态 |

## 配置

`.env` 真值不进 git（本地 .env 是部署源头，push 时覆盖 NAS），键位清单见 `.env.example`：
共用应用凭据、表格 token、字段名映射、五个 cron 时刻、生成跨度/间隔、`DUTY_ADMIN_OPEN_IDS`
（可选覆盖）、看板限流、看板 webhook 通道（`DUTY_BOARD_WEBHOOK_URL/SECRET`）、
`DUTY_STATE_FILE`（**生产必须放项目目录之外**，SFTP 部署会清空
`/opt/duty-bot`）、`QUIET_HOURS_*`、NAS 连接。

### 隐私约定（重要）

- **`config/members.json`（真实名册，含 open_id）与 `config/whitelist.json`（人名白名单）
  已在 .gitignore，永不进 git**；仓库只保留 `*.example.json` 模板；
- push.js 打包与 git 之外，会显式把这两个文件 SFTP 到 NAS（git 路径部署仓库里没有它们）；
- 代码、文档、注释、测试一律不出现真实姓名/open_id/群凭据（用「管理员/队员A」代称）；
- 运行状态 `.duty-state.json`、积压 `.quiet-backlog.json` 同样不入 git。

## 测试与建表脚本

```bash
npm run test:schedule   # 排班引擎单测（纯函数：轮转/插入/配额/复现性）
npm run test:flow       # 私信闭环干跑（内存表格：询问→是/照片→收口→补偿→请假→对账→指令）
npm run test:policy     # 管辖策略（policy 下发/管辖判定/看板拒绝与放行）
npm run test:roster     # 名册同步与定制窗口（通讯录同步/白名单）
npm run test:board      # 看板 webhook 通道（payload/签名/错误路径/通道选择/限流）
npm run table:check     # 校验 .env 配置的表格字段是否符合约定
npm run table:create    # 自动新建 Bitable+排班表（打印 app_token/table_id 供 .env 回填）
```

## 部署

严格照 `.agents/skills/qianli-deploy/SKILL.md`：

1. 唯一入口 `npm run push "提交说明"`（提交 → 推送 → NAS → pm2 重启）；
2. push.js 与 approval-bot 同构，四处差异：`TAR_NAME=duty-bot-deploy.tar.gz`、
   `REMOTE_DIR=/opt/duty-bot`、`GIT_REMOTE=https://github.com/NepheLoudy/duty-bot.git`（建仓前
   git push 失败会自动走 SFTP 直传）、`PM2_NAME=duty-bot`（首启后 `pm2 save`）；
3. `.env` 与真实名册/白名单每次 push 显式 SFTP 到 NAS（不进 git）；
4. 上线验证：pm2 online → `/api/health` 200 → `test-generate` dryRun 预览 → `test-remind`/
   `test-ask` dryRun 预览（手动触发不受静默限制）。

## M0 上线清单

1. 表格：`npm run table:create`（或手动按上表建表）→ `.env` 回填 → `npm run table:check` 通过；
2. 名册：按 `config/members.example.json` 补全 `config/members.json`（姓名必填、openId 未绑定留空、
   管理员加 `"admin": true`）；白名单 `config/whitelist.json` 只写人名；
3. 绑定：成员首次私信「值日助手 → 绑定 姓名」（管理员账号可直接预填 openId）；
4. 权限核对：共用应用需 `im:message`（发私信）、`im:image`（读图片）、bitable 读写、
   `drive:file:upload`（图片转存附件）；机器人「可用范围」需含全体队员；
5. pm-robot `.env`：`DUTY_CHAT_ID` / `DUTY_WEBHOOK_URL` / `DUTY_BROADCAST_SCHEDULE`（M4 预留键——播报已由 duty-bot 自身看板卡实现，键保留未接线）。

## 里程碑状态

- ✅ M0 骨架 + 配置 + 建表脚本（表格 token 回填后跑 `table:check` 收口）
- ✅ M1 排班引擎（纯函数 + 单测 18 项全过）
- ✅ M2 私信闭环（stub 全流程 34 项全过；真机验证待表格与名册就绪）
- ✅ duty-bot 侧 `/api/duty/brief` 与值日助手指令层（hub 转发分支为 M3，与 hub 同批上线）
- ✅ M3 hub 转发（chatService 值日分支 + p2p 图片最小转发 + 群看板，v65/v74 上线）
- ✅ M4 昨日值日播报（2026-09-12 落地：duty-bot 自身看板卡扩展「昨日战报」段；原 pm-robot 方案作废）
- ✅ M5 首次 `npm run push` 上线（2026-09-11，仓库 Duty-Management，NAS pm2 duty-bot）+ 顶层 AGENTS.md/DEVLOG 联动归档
- ⬜ M3 全链路真机验收（代码已上线 v65/v74，待表格/名册就绪后走一遍）

# duty-bot 开发日志（DEVLOG）

> 版本隔离单位 = 一次 `npm run push`（即一次 git 提交 + 一次部署）。
> 每次 push 完成后在文末追加：`## vN · YYYY-MM-DD · <提交哈希> · <类型>`，
> 正文为提交说明原文 + 实际改动要点。vN 只增不复用，历史条目不改写。
> 当前最新：**v42**（2026-09-27，随本提交落地；部署待实验室网段恢复）。上一版 v41（push.js ENOENT 兼容）。上一版 v40（全量审查修复批，`33ab617`）。上一版 v39（deferred spread 时序修复，`60654f0`）。上一版 v38（对账文案+文档批，`7781ee1`）。更早：v37（b8db8a6，09-25 值日全面检修）、v36（7a7a361，09-24 值日公平性批）。



### v1 · 2026-09-11 · 随本提交落地 · feat

**值日机器人首次上线：排班轮转 / 私信闭环 / 值日助手 / 运维接口（M0 骨架 + M1 引擎 + M2 闭环全量落地）**

- 排班引擎（scheduleAlgo 纯函数）：三岗均等轮转（每人每轮 总负责/工位区/装配区 各×1，09-11 确认取消总负责×2）、配额贪心+按天联合最优分配、间隔软约束、种子可复现；缺勤插入就地安置（4 人日、当周岗位计数最少、人名散列错峰）、连续两次缺勤加罚、下周未生成则排队优先安置
- 私信闭环：D-1 20:00 提醒 → 18:30 询问开监听会话 → 是/否/照片写回（照片下载转存挂本人岗位凭证栏）→ 22:00 收口（置未做完/算当日总状态/登记补偿；写表不延迟仅通知过静默闸门）→ 00:30 对账（兼容手工改表+义务核对）
- 值日助手：p2p 精确指令（值日助手/我要请假/查询我的下一次值日/绑定 X/是/否/生成排班表 admin）+ 群看板 1h 限流；`GET /api/duty/brief` 对外数据接口；`/api/bot/test-*` 干跑运维接口
- 基建：express :3006、node-cron 四任务全过静默闸门、多维表格单一事实来源（字段名可配）、push.js（approval-bot 版改四处，远端 Duty-Management；真实名册/白名单不进 git、显式 SFTP 上 NAS）
- 隐私：名册/白名单 gitignore + example 模板；代码/文档/测试零真实姓名；表格 token 待 M0 回填（`npm run table:create`/`table:check`）
- 测试：排班单测 18 项 + 闭环干跑 34 项（scripts/stub-test-*.js），本地联跑稳定

### v2 · 2026-09-11 · 随本提交落地 · fix

**全仓审计 debug 批：两个 P1 逻辑补洞 + 一串 P2 防御**

- P1 对账补收口：错过 22:00 收口（宕机/重启）后，00:30 对账现在会从上次收口水位（lastCloseDate）起逐日回补——空状态置未做完、登记补偿、重算总状态、清残留会话（最多回看 7 天），closeToday 记录收口水位
- P1 placePending 双插入：加罚产生的同人同周两条义务此前必落同一天（陈旧快照 + 确定性散列）；现在每次就地插入后同步内存周快照，义务标记按 id 定向 mutate（不再整包回写旧快照覆盖并发变更）；目标周已过去的义务标记 expired 留人工裁决，不再插出过去的脏班次
- 附件并发锁：凭证追加按记录串行化（飞书附件整列覆盖，并发互丢），appendReceipt 直接返回新计数（省一次全表拉取）
- 会话日期守卫：过期会话（错过收口残留）清理，「是/否/照片」晚到不认旧日期
- 消息幂等：/api/chat/command 按 messageId 10 分钟去重（hub v66 起透传 messageId），webhook 重投的「我要请假」不再双计补偿
- 其它：/api/bot/test-generate 默认 dryRun（带 confirm 才写表）、test-close 回执绕过静默（手动触发不受限口径对齐）、D-1 提醒跳过已请假/已完结、群看板先占限流戳再发卡（失败回滚）、QUIET_BACKLOG_FILE 可配（积压文件可挪出项目目录，部署不再清掉）、启动时确保状态目录存在
- 回归：排班 18 项 + 闭环 40 项全过

### v3 · 2026-09-11 · 随本提交落地 · feat

**缺勤补偿规则确认落地：已请假与未做完全路径进下周队列**

- 用户确认规则：凡标记为「已请假」或「未做完」的值日人员，一律登记下周补偿插入
- 此前空档：管理员在表格里手工标记的 已请假/未做完 不会登记补偿（只有私信请假和收口置未做完两条路径会）——新增 `syncAbsenceObligations`：00:30 对账时按 姓名+值日日期+原因 去重补登记（含旧版无 dutyDate 字段义务的宽松兼容），对账报告带「补登记 N 条」提示
- 义务结构新增 dutyDate 字段（去重键）；group 限制确认：快递申领群即值日播报群（DUTY_CHAT_ID 单键双用，维持现实现）
- 测试：闭环用例新增「admin 手工标记已请假 → 补登记 → 二次对账去重」3 项，40+3 项全过

### v4 · 2026-09-11 · 316756b · feat

**值日域管辖策略下发——权限管辖范畴/生效范畴归位本项目后端**

- 需求：hub 在值日群的权限口径（管辖哪些群、群里放行什么）此前硬编码在 pm-robot，用户要求这类管辖归位到 duty-bot 后端，hub 只做执行闸门。
- 新增 `GET /api/duty/policy`（`src/services/policyService.js`）：下发管辖范畴（`.env` 的 `DUTY_GROUP_CHAT_IDS`，留空=不限制）+ 生效范畴（看板触发词、`closeBasicCommands`、`keywordPassthrough`、未命中引导语）+ p2p 指令清单（含 绑定 前缀）。
- 群看板加管辖校验（防御直调）：非管辖群请求看板静默拒绝（`assistantService`）；看板触发词改为从自身策略取，与下发口径单一来源。
- 配置：`.env`/`.env.example` 新增 `DUTY_GROUP_CHAT_IDS`（生产=快递申领群）；架构铁律不变——仍不消费消息事件，策略只是 HTTP 下发。
- 回归：新增 `npm run test:policy`（10 项断言：策略结构/管辖判定/看板拒绝与放行/HTTP 端点）；test:flow 补 `DUTY_GROUP_CHAT_IDS=''` 隔离（防真实 .env 管辖列表泄漏进测试），flow/schedule 全过。


### v5 · 2026-09-11 · d57aa0f · feat

**表格接线——值日看板表接入（M0 表格项完成）**

- `.env` 回填 `DUTY_BITABLE_APP_TOKEN`（机器人项目看板库）/ `BITABLE_DUTY_TABLE_ID`（值日看板表 tblhws89lrituaks），并按实际列名写全 `DUTY_FIELD_*` 映射：人员(人员类型主键)/姓名/值日时间/负责区域/附件1·2·3/完成状态/该组总状态。
- 表结构补齐（应用身份直接操作）：新建文本「姓名」列（duty-bot 写姓名与名册匹配的 join 键，原表缺失）；「负责区域」「完成状态」预置单选选项（总负责/工位区/装配区、已做完/已请假/未做完）。列名不改动用户原表命名，全部走 env 映射。
- `scripts/init-duty-table.js`：`该组总状态` 类型断言放宽为文本/单选皆收（`types` 数组），选项校验仅对单选生效——生产表该列为文本，运行时写「今日完成值日」不受影响。
- 验证：`npm run table:check` 9 字段全过（5 条空壳记录无日期自动忽略）；test:flow / test:policy 回归全过；NAS 实测 `/api/duty/brief` 读表正常、`/api/bot/test-generate` dryRun 正常、health 200。
- 遗留：名册仅 1 人（已绑定+admin），**排班生成前必须补全 config/members.json 并让队员发「绑定 姓名」**，否则排班会全压到一人。


### v6 · 2026-09-11 · d94c48f/9bbea91 · feat

**名册自动读通讯录 + 名册/白名单定制窗口**

- 需求：排班名册不再手工维护——自动读飞书通讯录纳入所有队员（open_id 直取组织架构，绑定流程降级为人工纠错兜底）。
- `src/feishu/contacts.js`：全租户部门（自根 fetch_child）× 各部门成员拉取，停用成员不入册、多人多部门合并、输出 name/openId/departments。
- `rosterService.syncFromContacts()`：写回 members.json，**admin 标记按姓名保留**；通讯录为空/失败抛错由调用方兜底（不写坏本地名册）。同步时机：启动 + 生成排班前 + `POST /api/duty/roster/refresh`。
- 定制窗口：`GET /api/duty/roster`（全景：绑定/白名单/队列标记）、`GET|POST /api/duty/whitelist`（增删即时生效）。
- 踩坑：`users/find_by_department` 的 page_size 上限 50，写 100 触发 99992402 field validation failed（9bbea91 修复）；本地探测通过 ≠ 参数合法，部署后必须实测同步。
- 测试：新增 `npm run test:roster`（10 项：同步写回/admin 保留/dept 合并/白名单增删/四个窗口）；flow 测试补 contacts stub；schedule/policy 回归全过。
- NAS 实测：同步 63 人（12 部门、全部自带 open_id、admin 保留 1）；四窗口 200。

### v7 · 2026-09-11 · 95f92b6 · feat

**指令风格统一（/别名全等效）+ 管辖策略在线改写**

- 统一指令风格：`assistantService.handleCommand` 统一去 `/` 前缀——「/值日助手」「/我要请假」「/绑定 X」等与裸词完全等效，与各模块 /指令 风格一致；HELP 文案注明「带不带 / 都可以」。
- 管辖策略可写：新增 `POST /api/duty/policy`（`{groupChatIds:[...]}`，空数组=不限制），写 `config/policy-override.json`（gitignore）在线改写管辖范畴，`getPolicy` 优先读 override、回落 env；`getPolicy`/`isManagedGroup` 改为即时读取（hub 消费端 60s 缓存内跟随）。运维台 duty 卡片已内置管辖群编辑框。
- 策略清单同步：p2pCommands 含裸词 + / 变体（hub 的 isDutyCommandText 直接放行斜杠形态）。
- 回归：test:policy 断言更新（12 词 + 双前缀）全过；flow/roster/schedule 全过。NAS 实测 POST 写入口 ok、`/值日助手` 斜杠形态群看板正常。

### v8 · 2026-09-11 · 随本提交落地 · feat

**今日值日看板改走 webhook 机器人 + 每日 12:00 看板自动播报**

- 需求：看板模块是给 webhook 机器人做的，不是对话型；且要求每日定时 12:00 自动播报。
- 通道切换：`handleGroupBoard` 不再默认走应用身份 im API（`sendCardToChat`），改为经群自定义机器人 webhook POST `{msg_type:'interactive', card}`（与 pm-robot DDL 播报同款通道）。新增 `src/feishu/webhook.js`：`sendCardToWebhook(url, secret, card)`，可选签名（HMAC-SHA256，key=`${timestamp}\n${secret}`），兼容旧版 `StatusCode` 应答，15s 超时；webhook 等同群凭据，URL 只落 `.env`。配置 `DUTY_BOARD_WEBHOOK_URL` / `DUTY_BOARD_WEBHOOK_SECRET`（可选），**留空回退 im API 直发**（旧行为不退化）。触发方式、每群 1h 限流、管辖校验、卡片结构均不变；页脚「私信我」改「私信值日对话机器人」。
- 看板自动播报：新增 `assistantService.broadcastTodayBoard` + cron 第 5 任务 `duty_board_broadcast`（`DUTY_BOARD_BROADCAST_SCHEDULE`，默认 12:00）——今日值日看板卡片经 webhook 推值日播报群，**过 quietHours 闸门**（可重扫任务，静默期积压 09:00 补跑）；无排班记录/未配置 webhook 自动跳过；手动触发 `POST /api/bot/test-board`（默认 dryRun，`{"confirm":true}` 实发，不受静默限制）。
- 分工边界更新：今日值日看板自动播报归 duty-bot（AGENTS.md 职能/联动契约已同步）；M4「昨日值日播报」卡片（昨日结果+语录）仍规划在 pm-robot（待实施）。
- 测试：新增 `npm run test:board`（15 项：payload 形状/签名规则/code!=0 与非 JSON 报错/旧版 StatusCode/通道选择/限流/回退/播报 dryRun/播报实发/无记录与未配置跳过），本地 http 服务实测；其余 stub 回归全过。
- 待办：NAS `.env` 回填 `DUTY_BOARD_WEBHOOK_URL`（值日播报群 webhook，duty-bot-plan.md 有记录）后 `npm run push`；上线后 `test-board` dryRun→confirm 验证卡面。

### v8 · 2026-09-11 · 58237b8 · fix

**通讯录同步瞬时失败自动重试**

- 排查用户反馈「手动刷新通讯录没用」：同步整链约 17 次飞书出站调用，任何一次网络抖动即整轮失败（与 ticket-bot 接单回执瞬断同源），面板只弹失败 toast。
- 修复：`syncFromContacts` 失败后 1.5s 自动重试一次，重试仍失败才抛错兜底。
- 配套：运维台代理超时 12s→30s（实测同步 ~6s）、刷新按钮加忙碌态并在成功后自动展示名册全景。

### v9 · 2026-09-12 · `f2220af` · fix

**值日链路全量修复：每日播报静默跳过改回退直发 + 回填群 webhook + 打卡口语变体 + 文案口径（配 hub v74 群门斜杠修复）**

- 群看板「/值日助手」真实链路修复在 hub 侧（见 hub v74）——v7 的 NAS 实测是直 POST 本服务绕过了 hub 门，真实链路从未通过；本仓 policy 注释同步改为「hub 群门双形态匹配 + 本仓 p2p 去前缀双保险」。
- 每日 12:00 播报此前每天静默跳过（`skipped: webhook_not_configured`，本地与 NAS .env 均未配置该键）：`broadcastTodayBoard` 改为无排班记录才跳过；未配置 webhook → 回退应用身份直发管辖群（与群看板回退同款），webhook 推送失败同样回退，播报不因通道故障中断。
- `.env` 回填 v8 待办的 `DUTY_BOARD_WEBHOOK_URL`（值日播报群 webhook，duty-bot-plan.md 交接记录），push 后 NAS 同步生效；NAS 核对结论：线上 .env 键名与本地一致（同样缺 BOARD 键）。
- 打卡确认口语变体：p2pCommands 增补「是的/好/好了/完成/完成了/做完了/搞定/搞定了」，新增 `inquiryService.confirmVariant`——有当日活跃询问会话等同「是」，无会话返回 `handled:false`+空 reply（hub 落回常规流程，闲聊不接管、不发未识别提示）。
- 文案口径：看板 footer 明示「完成后请**私信**回复『是』」（原文案诱导群内回复，群里的「是」只会得到引导语——「关键词和@指令撞了」观感的直接来源之一）；18:30 询问与 HELP 注明「若同时收到 DDL 逾期确认，『是』会先被其占用，打卡未成功请再发一次」。
- 测试：test:policy 断言更新为 20 词清单；test:board 播报段改断言回退语义（未配置/推送失败 → `via:'app'` 直发管辖群）并补 webhook 故障注入；flow/policy/board 补 `DUTY_BOARD_WEBHOOK_URL=''` 环境隔离（测试不再依赖本地 .env 缺键）；五套件全过。

### v10 · 2026-09-12 · 45fb917 · docs

**.env.example 补 QUIET_BACKLOG_FILE + v9 锚点回填**

- `.env.example` 静默段补 `QUIET_BACKLOG_FILE=/home/qianli/duty-bot-data/quiet-backlog.json`：v9 代码已支持该变量、`.env` 已实际配置，模板欠账补齐（qianli-deploy「新增配置同步改 .env.example」约定；同批 bambu/ticket-bot 静默积压挪址收尾联动）。
- v9 条目锚点回填 `f2220af`（原记「随本提交落地」）。

### v11 · 2026-09-12 · ad2e794 · feat

**动态广场事件流接入 + push.js 运行时数据保护（白名单事故整改）**

- 动态广场：新增 `src/services/plaza.js`，值日完成（handleYes）/ 值日请假（requestLeave）事件写机器人项目看板「动态广场」表（`config.plaza` 默认表内置，`PLAZA_BITABLE_TABLE_ID` 可覆盖）；失败仅 warn 不影响主流程。建表脚本 `scripts/create-plaza-tables.js`（幂等：动态广场 + 网关活跃三表，主键改名走 PUT）入库。
- 【运行时数据保护】push.js 上传私有配置（members/whitelist）前：①NAS 现网版本自动备份到 `/home/qianli/duty-bot-data/backup/`；②本地条目数少于现网时跳过上传并自动回填本地（`PUSH_FORCE_PRIVATE=1` 才强制覆盖）。事故背景：v9 推送曾用本地空 `whitelist.json` 覆盖 NAS 侧 18 人排除名单（不可恢复），规则与整改见顶层 AGENTS「运行时数据保护」。
- README 补白名单权威说明；flow/policy 测试补 plaza 禁用隔离（防测试污染生产表），回归全过。

### v12 · 2026-09-12 · 3f86bcb · fix

**tar 打包排除私有配置（堵住 SFTP 兜底路径绕过守卫的漏洞）**

- v11 的备份+守卫只护住了 fastPut 上传步；SFTP 兜底部署是先 `rm -rf` 清目录再解 tar——本地种子会随 tar 在守卫前覆盖 NAS 现网。本版把 `config/members.json`、`config/whitelist.json` 加入 tar 排除，清目录不再波及（文件由 uploadEnv 的守卫路径唯一写入；git fetch 主路径本就保留未跟踪文件）。

### v13 · 2026-09-12 · 1d522cf · fix

**值日群引导语改纯行动指引（删「专用群/彩蛋照常有效」说明性内容）**

- 用户反馈：引导语不该通知「关键词彩蛋照常有效」这类能力范围说明，提示只保留「应该怎么做」。GROUP_GUIDANCE 删去「本群为值日/快递申领专用群」「关键词彩蛋照常有效」，只留两句行动指引：@我 发送「值日助手」查看今日值日；查询排班、请假、打卡确认请私信机器人。
- hub 断联兜底文案（DEFAULT_GUIDANCE，hub v78）同批同步同一句，下发与兜底口径保持一致。
- 回归：policy/flow/board 套件通过（policy 对引导语只断言含「值日助手」，无需改断言）。

### v14 · 2026-09-12 · 5854556 · fix

**全量 debug 批：白名单成员补偿义务不再丢失 + 文档纠偏**

- 修复：生成排表路径对不在值日队列成员（如白名单/排除名单成员）的补偿插入义务原是静默丢弃（scheduleAlgo 直接 `continue` 且不进未安置上报），却因「不在 unplacedInsertions 即视为已安置」被误标 placed——义务凭空消失，违反「白名单成员补偿义务不豁免」口径，且与 00:30 对账路径（placePending 不豁免）行为分裂。现改为进未安置队列：生成回执如实上报「N 条补偿插入保留在队列」，placePending 照常为其就地安置（本就不查排除名单）。
- 纠偏：README 把未实施的 M4「昨日值日播报」写成进行时（pm-robot 消费 brief），改回「规划中、暂无消费方」；里程碑 M3 两条矛盾行合并为已上线（v65/v74）+ 待真机验收。
- 建表脚本补「网关队员活跃」表 `open_id` 字段（gateway v17 起写入该列，脚本此前落后于线上表结构）。
- `.env.example` 删去 QUIET_BACKLOG_FILE 重复两行中的一行。
- DEVLOG 哈希回填：v10（45fb917）/ v11（ad2e794）/ v12（3f86bcb）/ v13（1d522cf）。
- 回归：schedule/policy/flow/board/roster 五套 stub 全过（schedule 套件含插入语义断言）。

### v15 · 2026-09-13 · e5d9c5c · feat

**M4 落地：值日看板卡「昨日战报」+ 请假当日抽调补位（用户口径拍板）**

- M4「昨日值日播报」落地为**值日群一张卡同时播昨天今天**：buildBoardCard 增「昨日战报」段（昨日三岗状态+照片数，无昨日记录自动省略），12:00 自动播报与群内手动看板共用；原 pm-robot 消费 brief 的方案作废，`GET /api/duty/brief` 保留为通用数据接口，hub 的 `DUTY_WEBHOOK_URL`/`DUTY_BROADCAST_SCHEDULE` 降级为预留未接线键（hub .env.example 注释同批更新）。
- **请假当日补位**（口径：有人请假必须有补位，从远一点的排班抽调）：requestLeave 登记请假后调用新增 `scheduleService.arrangeReplacement`——候选=值日队列（名册−白名单）中在请假日之后仍有排班者，同岗优先、排班日最远者优先；抽调为**加插非对调**（被抽调者远期班次保留），私信告知被抽调人（失败仅日志不阻断请假回执）；请假人仍进下周补偿，总量守恒；找不到候选时空缺（回执与对账报告可见）。未做完（收口才发现）无法当日补位，仍走下周补偿。
- 测试：stub-test-flow 新增 3 条补位断言（同岗插记录/回执说明/私信反查验证当日同岗）+ 旧「目标周空位」断言改为**对账前 planInsertion 快照**（修真实日期敏感误报：安置本身会占掉空位日）；stub-test-board-webhook 新增 2 条卡片内容断言（有/无昨日数据）；schedule/flow/policy/board/roster 五套全过。
- README：缺勤补偿节改写（补位语义）、12:00 播报口径、M4 落地说明、里程碑 M4 销项、pm-robot 预留键注记更新。
- DEVLOG 哈希回填：v14（5854556）。

### v16 · 2026-09-13 · 随本提交落地 · feat

**值日打卡主词改「打卡」+ 询问窗口 DDL 冲突提示（用户拍板，配 hub v81）**

- **打卡主词**：assistantService 新增「打卡/打卡了」路由（效果等同「是」，需先绑定），policy `p2pCommands` 与 hub 失联兜底清单同步加词（含斜杠变体）；「是/是的/好了/完成了/做完了/搞定」兼容保留。全量文案「回复是」→「回复打卡」：HELP、D-1 提醒、18:30 询问、看板 footer、「否」补救提示、照片先到提示、22:00 收口 photoOnly 回执、请假补位通知。
- **询问窗口冲突提示**：新增 `ddlConflictClient`（GET hub `/api/ddl/pending`，60s 缓存 + 2s 超时 + 失联静默降级）——成员有未过期 DDL 逾期确认时，18:30 询问追加「⚠️ 回复『是』会确认那个项目（12 小时内有效），不会完成值日打卡——值日请回复『打卡』」。
- 测试：flow 新增 4 断言（无冲突不加提示/有冲突仅冲突成员加提示/打卡主词打卡成功/「是」兼容路由）；policy 套件 p2pCommands 清单断言 20→24 词；schedule/flow/policy/board/roster 五套全过。
- `.env.example`：`HUB_SERVICE_URL`（默认 http://localhost:3000）。

### v17 · 2026-09-13 · a843c5d · chore

**建表脚本移除网关功能使用/队员活跃两表定义（gateway v18 单表化联动；同会话批次）**

> 编号注记：本条提交信息误标 v16，与同文件上一条「打卡主词」v16 撞号（并发会话所致）——按「以提交哈希为准」改记 v17。



**建表脚本移除「网关功能使用/网关队员活跃」两表定义（随 gateway v18 下线联动）**

- create-plaza-tables.js 只保留 动态广场 + 网关日活跃（口径=机器人交互）：用户拍板监听只留机器人交互强相关后，gateway 不再写两张明细表（gateway v18），防多维表格删表后被旧脚本重建。
- 本地提交暂缓部署：仓内另有在途改动（assistantService/inquiryService/policyService/ddlConflictClient），不宜 git add -A 全量 push；本脚本随下次 duty-bot push 自然带上 NAS，在那之前勿在 NAS 跑旧版建表脚本。
- DEVLOG 哈希回填：v15（e5d9c5c）。

### v18 · 2026-09-13 · 随本提交落地 · refactor

**值日策略移除 keywordPassthrough 生效范畴（配 hub v82，用户拍板：未@关键词回答全群统一）**

- hub 关键词回答全群统一后，管辖策略的 `hubEnforcement.keywordPassthrough` 成为死配置：policyService 删除该字段，stub-test-policy 同步去断言。管辖策略继续下发看板触发词/基础指令关闭/引导语/p2p 指令清单。

### v19 · 2026-09-13 · 随本提交落地 · docs

**文档重审订正：README 打卡主词与策略口径同步（全量文档重审批，无代码改动）**

- 管辖策略下发清单删「关键词回答放行（@与未@）」（v18 已从策略移除该生效范畴）；18:30 询问行补 DDL 冲突提示说明（查 hub /api/ddl/pending）；22:00 收口与私信指令清单改「打卡」主词（是/口语变体兼容保留）——v16 改了代码文案但 README 三处未跟，全量文档重审发现订正。

### v20 · 2026-09-13 · 随本提交落地 · fix

**深度代码审查批：duty-bot 九处确认 bug 修复**

1. 收口幂等：同日第二次真实收口（test-close 默认真实执行）重复登记补偿义务并虚增连续缺勤——只对本轮实际置位的记录调 handleAbsence（flow 新增幂等断言）。
2. 18:30 后当日补位者无询问会话，打卡/照片被拒、22:00 反被记未做完——当日补位立即开监听会话。
3. 看板按岗位 find 只取一条，4 人日隐藏第 4 人（可能恰是顶班者）——按岗位聚合渲染全部记录。
4. 排班算法把未来插入日当 lastDuty，成员在插入日前全被排除——间隔检查加 last < date 前置。
5. placePending 可把插入落到目标周已过去的日期（宕机恢复场景造脏班次）——rangeStart 不早于今天。
6. 写表成功但标 placed 前中断 → 次日重复安置——placePending 逐条即时标记。
7. 18:30 询问/D-1 提醒无逐人异常隔离，一人发送失败全员断——逐人 try/catch 进 skipped。
8. 并发请假竞态（读全表→选候选→写补位）——全局请假串行链。
9. 状态文件损坏被空状态静默覆盖——原子写（tmp+rename）+ 损坏文件另存 .corrupt.bak 保留现场。
回归：五套 stub 全过（flow 新增收口幂等断言、补位断言改结局二选一——4 人队全员在班时无可抽调属正确行为）。

### v21 · 2026-09-13 · 随本提交落地 · feat

**管理端点鉴权 + 部署前测试闸门（体系推荐 R2/R4，用户授权先做）**

- 新增 src/auth.js（gateway 同款模板）：/api/duty/policy、/api/duty/whitelist、/api/duty/roster/refresh、/api/bot/test-* 写/触发端点需 X-API-Token（API_TOKEN 全局共享值，fail-closed）。运维台代理自动带头，手动 SSH curl 需自带。
- push.js 加部署前测试闸门（R4）：五套 stub 全过才部署，SKIP_TESTS=1 可跳。

### v22 · 2026-09-14 · fc83d23 · fix

**修复批量写入双层包裹(排班生成首次全线打通) + push.js 适配部署目标迁移(小电脑)**

- src/feishu/bitable.js `batchCreateRecords` 修复双层包裹:chunk 元素已是 `{fields}` 记录形状,原 `map((fields)=>({fields}))` 再包一层,实际发出 `{fields:{fields:{...}}}`,飞书报 FieldNameNotFound(1254045)——**值日表批量写入自上线以来从未成功过**(值日表一直为空的原因;stub 测试 mock 了 bitable,掩盖了线上故障)。修复后排班生成 90 条一次写入成功(2026-09-15~10-14,白名单 13 人生效,含 Siu/汪沛宇 排除)。
- push.js 适配部署目标迁移:远端路径 /opt/duty-bot、/tmp、/home/qianli → /c/qianli/opt/duty-bot、/c/qianli、/c/home/qianli(git-bash 路径,SFTP 用 WIN 变体),随机器人整体迁移小电脑 DESKTOP-FE1MIGI(192.168.31.57)。
- 排障全过程沉淀:新 skill `.agents/skills/qianli-lab-network/SKILL.md`(网络拓扑/断网排查/Windows 远程管理限制/ pm2 环境快照语义)。
- 部署前五套 stub 测试全过。

### v23 · 2026-09-15 · 随本提交落地 · fix

**全项目深度审查修复批：push.js 守卫时序修复（数据保护关键）+ 路径显式化**

- push.js 私有配置守卫时序修复：原实现 SFTP 分支先 `rm -rf` 清空远端目录（config/ 下名册/白名单/策略覆盖全被删）再读现网文件做守卫——现网永远是空，守卫条件永不触发、备份永远跳过，本地种子无条件覆盖，**正是 2026-09-12 v9 白名单覆盖事故的完整复现路径**（git 分支不受影响，SFTP 降级分支必踩，而 GitHub 不通在本环境常见）。改为连接后先盘点（读现网→备份→判定种子是否过期）再替换目录；本地种子过期时跳过覆盖并把现网内容显式回写；PRIVATE_CONFIG_FILES 增补 config/policy-override.json（管辖群在线改写此前不在保护清单，SFTP 替换即静默回退 env 值）。
- restart 步骤补 PATH 导出：小电脑 SSH 非交互 shell 默认 PATH 无 node/pm2，原写法部署收尾三个 pm2 命令 127（代码已传服务未重启）。
- .env 数据路径显式化：DUTY_STATE_FILE/QUIET_BACKLOG_FILE 由 /home/qianli/... 改 C:/home/qianli/...（Node on win32 对 POSIX 绝对路径按「进程 cwd 所在盘」解析，pm2 cwd 一旦换盘状态文件会静默漂移到新盘重建，会话/补偿义务/缺勤计数清零重开）。
- DEVLOG 头部补建「当前最新」指针行（此前缺失，违反全局工程规则），v22 占位哈希回填 fc83d23。
- 五套桩测试（schedule/flow/policy/board/roster）全过。

### v24 · 2026-09-15 · 随本提交落地 · fix

**R10 鉴权收尾（全项目审查推荐落地批）**

- auth.js 废除 ?token= 查询串传参（R10②）：token 会进访问日志/代理日志，X-API-Token 头为唯一通道；工作区无 query token 消费方（运维台代理走头）。写端点鉴权本身 v22 已铺开，本批纯收口。
- 注：本批部署因本机已随用户离站（校园网，家庭 LAN 不可达）暂缓，代码已推 GitHub，回站后 npm run push 补部署。

### v25 · 2026-09-16 · f0609ad7e4ec7e4754931319d6f425130b24279a · feat

**值日私信链补强：21:00 临门提醒 + 收口私信未做完者本人（取证驱动的引导缺口修复）**

- 取证（09-15 全天日志+state+brief）：六个定时任务全部正常触发、无发送失败/未绑定，但 3 名成员全天零响应被收口「未做完」。缺口不在触发在**触达频次**：18:30 询问后到 22:00 收口无任何再触达，忘了就是未做完；收口后未做完者本人无任何私信（只有管理员摘要），补偿安排完全无感知。
- 新增 21:00 临门提醒（DUTY_LASTCALL_SCHEDULE，gateTask 可重扫）：私信当日仍未完结队员，收口倒计时+分态引导（已传照片者「只需打卡」/未传者「照片+打卡」/做不完→请假或告之未做完后果）。
- 收口私信未做完者本人（missNotices，随收口回执走 gatePayload 一次性补发）：有照片→「传了照片没打卡」文案；无照片→未做完+下周补偿预告+值日助手/管理员引导。photoOnly 字段保留兼容。
- cron 任务 5→6（cron-status 同步）；stub-test-flow 新增 8 组断言（临门提醒分态引导/不打扰已完结/missNotices 覆盖/本人私信含补偿与值日助手引导）。
- 附带取证结论：09-15 看板播报（webhook 推送 3 条记录）、询问、提醒、收口、对账均正常；未做完非系统故障，是触达与响应问题，本批从触达侧收敛。

### v26 · 2026-09-16 · 0a221735b4cc654606b74860af1ef356d7539b3d · fix

**全量 debug 回归批：临门提醒会话补建 + 收口私信幂等 + 管理摘要标注**

- sendLastCall 发送成功后补建监听会话（与 askToday 同构，via:lastcall 标记）：18:30 询问失败/成员后才绑定/state 重置的场景下，21:00 提醒是有效触点——不建会话成员回「打卡」会被回「没有进行中的值日确认」并误记未做完（审查发现）。
- missNotices 加 markedNow 幂等守卫：同日手动 test-close + cron 双跑时，收口「未做完」私信不再重发（此前只拦补偿义务，私信会重发）。stub-test-flow 补二次收口断言。
- 管理员收口摘要逐人标注「未绑定未通知」（此前未绑定者收不到私信且无处可见）。
- 新增 POST /api/bot/test-lastcall（dryRun 同款，手动验证用）。

### v27 · 2026-09-16 · edeb720c18f168dcc23beec3d78e56189419a466 · docs

**NAS 残留清扫（docs，无行为变更）**

- .env.example 部署段：旧 NAS 地址占位（10.x.x.x / qianli）→ 小电脑实际值（192.168.31.57 / mechax），注释对齐 wecom 版（NAS_ 为历史命名，语义=部署目标）。
- push.js 头注释「配置进 NAS」等 3 处、init-duty-table 输出「本地与 NAS 同源」→ 部署目标口径。

### v28 · 2026-09-16 · 随本提交落地 · fix

**照片凭证修复：下载换消息资源接口（用户图片此前 100% 失败，功能上线以来零成功）**

- 取证（09-16 21:25 目标机日志）：5 张私聊照片链路前段全通（网关→hub→duty-bot、当日会话校验均过），全部死于下载步 `下载图片失败: 234001`；翻遍历史日志成功记录为 0——「传不上去」属实且必现。
- 根因：`GET /im/v1/images/{image_key}` 按飞书官方语义**只能下载机器人自己上传的图片**，用户发送的图片一律 `234001: Invalid request param`。改用官方指定的消息资源接口 `GET /im/v1/messages/{message_id}/resources/{file_key}?type=image`（`downloadImage` 签名加 `messageId` 前置参数，载荷里本就带）。
- 线上实弹验证（部署前，目标机假参/真凭证）：旧接口假 key 复现 234001 基线；新接口假参报「message_id 格式无效」（形状/鉴权被接受）；顺带确认 `drive:file:upload` 已具备（1×1 测试图 upload_all 成功出 file_token，未写表）——此前 feishu-permissions.txt 是过期清单，无需补授权。
- stub-test-flow：downloadImage 桩记录入参，新增断言「下载走消息资源接口：收到 (messageId, imageKey)」；五套桩测试全过。
- 教训沉淀：接线时只对了「有没有下载图片的接口」，没核对接口的适用范围（机器人上传图 vs 用户消息图）；桩替身把 downloadImage 整个 mock 掉，测试绿≠线上通。

### v29 · 2026-09-17 · 随本提交落地 · feat

**快递助手上线（快递申领群专属）+ quietHours 双格式兼容 + brief 注释口径**

- 新增 `expressService`：@机器人「/快递」开 5 分钟登记窗口（群发引导，窗口内群里直接发取件码文字/快递照片即登记）；窗口内非@消息由 hub 观察转发收集（`type:'express_observe'`，本仓仍不消费消息事件，无窗口静默零打扰）；登记写「机器人项目看板」base 的「快递」表（用户手工建表：发起人=用户主键/快递内容/取件码/是否取件 未取·已取；`create-plaza-tables.js` 幂等补 登记时间/取件时间/消息ID 三列，是否取件由机器人填写）。
- 每小时整点未取播报（`EXPRESS_BROADCAST_SCHEDULE`，取件码+编号清单，无未取不发，过静默闸门冲刷重查）；取件确认「已取n」（多件必带编号，编号以最近播报/查询快照对账、两次播报间稳定、播报/查询时重排）、「已取」（仅一件）、「全部已取」，回写 是否取件=已取+取件时间；「查询当前快递」即时清单。
- policy 新增 `groupCommands`（群内指令子集：值日助手/快递助手/快递/查询当前快递）与 `p2pCommandPatterns`（已取n/全部已取 词形）下发，p2pCommands 并入快递五词；仅快递群（=管辖群）@ 与私聊触发。
- quietHours `QUIET_HOURS_*` 兼容纯小时数字与 HH:mm 两种格式（跨仓同名键不再静默回落默认，分钟非 0 warn 取整点）；getBrief「pm-robot 播报数据源」注释改「通用数据接口」口径（README/index.js 同批）。
- 建表脚本：快递表补列 + TableNameDuplicated 容错（表不在列表但建同名报重名=回收站占名，大声告警跳过——本次发现「动态广场」处于该状态，见顶层记录）。
- 测试：新增 `scripts/stub-test-express.js`（29 项：开窗/重复开窗/文字登记/messageId 去重/图片配对补挂/纯图新建/指令词防御/无窗口静默/关窗摘要编号/查询重排/取件回写/失效编号/全部已取/播报文案），push.js 闸门接入 `test:express`；policy 桩断言更新到 32 词+词形+express 开关；全套 6 套全绿。
- 文档：README「快递助手」节+定时任务表补每小时播报行；.env.example 补 EXPRESS_* 六键。

### v30 · 2026-09-17 · 随本提交落地 · feat

**值日收口 22:00 → 24:00（午夜），临门提醒 21:00 → 23:00（用户口径：大家下班晚）**

- config 默认值 + 本仓 .env：DUTY_DEADLINE_SCHEDULE 0 0 22 → 0 0 0；DUTY_LASTCALL_SCHEDULE 默认 21:00 → 23:00（保住「还剩约 1 小时」文案语义）。
- **跨日归属修复**：24:00（0 点）已跨日，closeToday 默认取「今天」会落空查到新一天空记录——runClose/closeToday 增 `dateStr` 显式归属日期，cron deadline runner 按上海时间回退 30 分钟计算（0:00-0:30 窗口=值日当天 D 日；收口时刻若改回白天则=当天，双向兼容）。
- 用户可见文案全量同步（询问/打卡回执/临门提醒/值日助手帮助/看板卡脚注）：「22:00 收口」→「24:00（午夜）收口」，「22:00 前均可补传」→「收口前均可补传」。
- 文档：README 定时任务表、.env.example、registry、机器人总成指南（MD+HTML）同步。
- 测试：flow 桩断言更新，全套 6 套全绿。

### v31 · 2026-09-17 · 随本提交落地 · fix

**值日照片多图收录 + 收录日志（配合 v28 消息资源接口的首次实弹观察）**

- 两天运行核查结论：9-16 两位队员打卡已正常写入（莫雨衡/陈渝 已做完，收口 22:00 正常触发）；但当晚 21:25/21:45 有 8 次照片上传全部失败（234001，旧 /im/v1/images 接口对用户图片必然失败）——全部发生在 v28 修复部署（23:38）**之前**，v28 换消息资源接口并做过实弹验证，之后尚无新照片样本。
- **多图支持**：富文本/post 一次多张此前只收第一张（hub 仅透传 imageKeys[0]）——hub 三处图片转发全量透传 `imageKeys`，handleImage/快递 observeImage 逐张下载合并收录，回执改为「📸 已收到（共 N 张），写入岗位凭证栏（该岗累计 X 张）」。
- **收录日志**：照片成功收录此前零日志（排障盲区）——新增 `[图片] 已收录 N 张 → 姓名/岗位（累计 X，消息尾号 xxx）`。
- 测试：flow 桩扩多图用例（2 张载荷 → 3 次下载 → 附件 3 张 → 累计回执），全套 6 套全绿。

### v32 · 2026-09-19 · 随本提交落地 · fix

**补偿义务满周顺延 + 请假链路提速 + flow 断言定向（R26 + 杨杨文琦请假事件）**

- **满周顺延**（compensationService `placePending`）：目标周已生成但该队员当周天天有班（小队多条补偿义务同周）时，原实现静默留队直到过期人工裁决——现自动顺延下一周（`weekStart+7`、`deferCount` 计数），对账报告新增「顺延 N 条」与明细行，返回值 additive 新增 `deferred`；新周未生成时下轮自然转回「留队等生成」分支，不死循环。
- **请假链路提速**（inquiryService）：「私信被抽调人」改后台发送不 await——请假链路整串是表读写+私信，串行发完才回执会顶爆 hub 转发超时（09-18 杨杨文琦案：三条补偿义务 20:06 全部登记成功，但 hub 20:07/21:56×3 超时误报「服务不可用」，用户 4 次交互全没等到回执后重试 3 次；hub 侧 15s+超时文案见 hub v100）。
- **flow 断言定向**：「队员D 义务按目标周空位处置」原检查全局 `stillQueued.length`，被同周其它队员义务误伤——09-17 全绿 09-18 红的「日期敏感断言」第三次复发即此因（插桩诊断确认 D 已正确安置、留队的是 C 的满周义务；诊断用临时副本已删）。断言改查 D 义务自身 `placed`，并新增「满周义务顺延不丢（placed 或 weekStart 后移）」断言。
- README：缺勤补偿节补顺延口径、定时任务对账行同步。
- 测试：六套全绿（flow 含定向断言与顺延新断言）。

## v33 · 2026-09-20 · 随本提交落地 · fix

**全量 debug 批：快递表读取限频重试 + cron 状态计数失真修复**

- **快递表读取限频重试**：整点未取播报与看板播报、ticket 整点检查、gateway 30 分钟 upsert 同刻叠加，共享 base 偶发 1254290 TooManyRequest，整点播报曾整轮失败（生产 error 日志实测）。`listExpressRecords` 现对 1254290 做短退避重试（2s/4s 两次；读操作幂等），仍失败按原错误抛出走既有兜底。登记窗口写路径不重试（写非幂等，维持原语义）。
- **cron 状态计数失真**：`getCronStatus` 判 `tasks.length === 6`，快递播报任务加入后实际 7 个任务，`running` 恒为 false——运维台/健康面板运行状态失真。改 `>= 6` 并暴露 `taskCount`。
- 测试：六套桩全过（express 29 项含既有断言不受影响）。

## v34 · 2026-09-20 · 随本提交落地 · chore

**用户拍板：动态广场机器人停写（PLAZA_ENABLED 开关）**

- 2026-09-20 用户拍板：动态广场相关功能由用户自维护，机器人只对各自现有业务看板负责。plaza.js `enabled()` 加 `PLAZA_ENABLED` 开关（默认关，显式设 `1` 才恢复写入）——停写后即使用户把「动态广场」表从回收站恢复/重建，机器人也不会往里灌数据；表在回收站期间的 TableIdNotFound warn 同步终结。
- 值日完成/值日请假两处广场钩子保留代码不动（fire-and-forget 语义不变），仅由开关关断；`.env.example` 补注释。
- 测试：flow/express 套件全过。

### v35 · 2026-09-24 · 7816439 · fix

**复查修复批：快递图片窗口守卫 + 排班补偿义务即时落账（附 09-22 文档回填入库）**

- 提交说明：fix: 快递群图片直调路径补窗口守卫+排班生成补偿义务逐日即时标记placed+新增stub-test-generate-place入闸门
- **快递图片窗口守卫（P2）**：expressService.handleImagePayload（hub group 图片直调入口，不过 observe）缺「窗口活跃」检查——无窗口发图会写「未留码」脏记录，且 win=null 时补图配对条件恒真、可把历史任何无图未取记录补上图。补齐与 observe() 同款守卫（closeWindowIfDue + windowActive + chatId 匹配），注释声称的「无窗口静默」就此名副其实。
- **排班补偿义务 placed 逐日即时标记（P2）**：generate 原在全部写表完成后统一标记 placed——约 30 次 batchCreate 中途抛错时已写日未落账，重试生成会把未标记义务二次安置成双倍插入。改为逐日写表成功即按 isInsertion 定向 mutate（placePending v32 同款防御）。
- **测试**：新增 scripts/stub-test-generate-place.js（可控失败写表桩：中断后 placed 与已写日一致 / 重试只安置一次，4 断言，旧代码必红）；stub-test-express 补图片窗口三断言（29→32）；push 闸门与 package.json 补至全量 7 套；README 测试节补 express/generate-place。
- **文档回填（09-22 遗留批随本提交入库）**：.env.example（LASTCALL 23:00 / DEADLINE 0:00 对齐代码默认 + 状态文件路径勘误）、AGENTS.md（定时链时刻 + 快递域联动契约 + M4 口径）、README（test-* 语义拆行 + 部署路径勘误）。

### v36 · 2026-09-24 · 7a7a361 · feat

**值日公平性修复批：请假不再触发加罚 + 补位按近期密度 + 请假两步确认 + D-7 值日预告**

- 提交说明：feat: 值日公平性批——加罚只计未做完+补位近14天密度选人+请假两步确认+D-7值日预告（pm v111 fallback 词形同批）
- **背景**：排查「某队员被排 7 次（全员第一，中位 2）」发现惩罚雪球：一次请假 12 秒内触发「连续两次缺勤加罚」被翻倍成两条补偿；加罚插入的班次又使其成为补位抽调「远期班次最远」的第一候选（多班=假余量），补位再+1。机器无错账（108 条记录逐条对账+义务账本+日志三边互证），是三条规则叠加的系统性挤压。
- **①加罚只计「未做完」**（compensationService.handleAbsence）：主动请假不计入连续缺勤（合规安排——可提前查班、请假即有补位、补偿总量守恒——不同罪）；连续两次「未做完」仍加罚。请求回执的加罚提示行保留（penalty 恒 false，规则恢复时零改动）。
- **②补位选人改近期密度**（scheduleService.arrangeReplacement）：排序第二键从「远期排班日最远（假余量）」改为「近 14 天（目标日前推）已值次数最少（真负担轻）」；同岗优先与姓名稳定序不变；日志同步改「近14天已值 N 次」。
- **③请假两步确认**（inquiryService + assistantService + policyService + stateStore）：「我要请假」只登记意向（pendingLeaves，10 分钟惰性过期）并点名班次日期，「确认请假」才走原请假链路（按 recordId 精确执行，期间班次已变更则拒绝并指引重新发起），「取消请假」撤销——旧版直取最近班次立即置请假，误触一次就少一个班且牵动补位/补偿不可撤回。新词形 4 个（确认请假/取消请假 + 斜杠变体）进 p2pCommands（hub 直传放行依据）。
- **④D-7 值日预告**（inquiryService.sendWeekAheadRemind + config.schedule.weekRemind + cron duty_week_remind + /api/bot/test-week-remind）：每日 20:05（DUTY_WEEK_REMIND_SCHEDULE 可配）私信一周后的当日值日队员（岗位+职责+请假引导）；可重扫任务过静默闸门；动机=补偿/插入班次往往临近才发现，提前点名留足请假余量。
- **联动**：pm-robot v111 同批同步 dutyPolicyService fallback 词形（duty-bot 失联兜底时新词形可放行）。
- **测试**：stub-test-flow 重构请假场景为两步（第一步意向/表格无变化/取消→确认失效/第二步生效）+ 新增 7.5 小节（加罚口径 6 断言 + 补位密度 2 断言，置于对账后避免污染 brief 断言；target 取生成范围外 today+35 保证候选集确定）+ 新增 D-7 预告 3 断言；stub-test-policy p2p 清单断言 32→36 含新词形 4 词；全量 7 套 + pm duty-branch 全过。
- **文档**：README（排班规则加罚/补位口径、定时任务表 D-7 行、值日助手指令节、API 表 test-week-remind）、dashboard/registry.js（duty commands+定时任务描述）、用户侧《机器人总成使用指南.html》（播报节奏+请假两步+时刻总表）、《机器人总成使用指南.md》（维护者手册同步）。


### v37 · 2026-09-25 · b8db8a6 · feat

**值日体系全面检修：请假当日空缺 + 安置优先级重构 + 周插入容量 + 排班重排端点**

- 提交说明：feat: 值日全面检修——请假当日空缺废补位+补偿安置请假空缺位优先+周插入容量防雪球+/api/bot/rebalance 重排清理存量超员
- **背景**：用户拍板①「请假当日空缺」替代抽人补位；②检修「同一天 3 人以上值日」的存量超员（09-19~09-24 雪球产物：09-27/09-28 各 5 人，未来 20 天几乎天天 4 人）。
- **①请假当日空缺**：废除 arrangeReplacement 补位抽调（函数删除）——被抽调者无准备无意愿烂尾率高（09-24 补位班全员未做完即此因），且抽调是加插推高当日人数。请假回执/HELP_TEXT/文档同步改空缺口径。
- **②安置优先级重构**（scheduleAlgo.planInsertion）：补偿/加罚安置先找目标周内「请假空缺位」（某日某岗仅有已请假记录=实际空缺，同岗回填新记录，实际干活人数不变、不超员）；无请假位才落当周人数最少日（4 记录日，受容量约束）。placePending 快照带上 status 供判定。
- **③周级插入容量**（DUTY_WEEKLY_INSERTION_ALLOWANCE，默认 2）：非请假位插入每周限 K 条，超出顺延下周（deferReason=weekly_allowance）；填请假位不占容量。placePending 与 generateSchedule 的义务安置同受约束——根除「欠账集中安置把一周插成天天 4 人」的雪球机制。
- **④排班重排**（scheduleService.rebalance + POST /api/bot/rebalance）：清理「今天之后未完成」班次→义务重置（placed 落点被删的回退未安置）→从明天起重排（每天严格 3 人）；历史与已定状态（已请假/未做完）保留留痕并计入配额反推（占配额防同人同日重排）；执行前全表原始记录 JSON 自动备份到数据目录 backup/（不备份不删除）；默认 dryRun 预览、confirm=true 才执行。generate 支持显式 startDateStr/extraHistoryRecordIds/weeklyAllowance 覆盖（重排场景专用）。
- **测试**：flow 重构——补位断言改「当日空缺无第 4 条/无补位私信」；新增 7.5 三组（planInsertion 请假位优先/周容量 K=2 第三条留队/rebalance 预览+执行+重排后每周 4 人日≤K）；bitable stub 补 batchDeleteRecords；主流程 env K=10 保旧断言稳定。全量 7 套过。
- **文档**：README（排班规则四节重写+API 表 rebalance+.env.example）、registry、用户侧 HTML/MD。

## v38 · 2026-09-25 · `7781ee1` · fix+docs

**请假口径文案收尾 + 隐私残留清理 + 全量审查文档批（审批对齐）**

- 提交说明：fix: 请假补位文案收尾（D-7 预告/请假确认改同日兼顾口径）+ 对账报告区分容量顺延 + reb_*.json 隐私残留清理 + 全量审查文档批
- **文案收尾（用户可见，v37 漏网）**：inquiryService D-7 值日预告与「我要请假」确认文案仍写「会安排补位/由其他队员补位」，与 v37 废补位口径矛盾（第一步说补位、确认后说空缺）——统一改为「当日该岗由同日队员兼顾，下周自动补插一次值日」。
- **对账报告**：顺延原因区分 deferReason=weekly_allowance（「含当周插入容量已满」）与满周顺延（「当周该队员天天有班」），README 宣称的「对账报告可见」落到原因层面。
- **隐私残留清理**：reb_confirm.json / reb_preview.json（rebalance 一次性运维输出，含全员真实姓名与排班明细，v37 哈希回填提交误入库）已从历史抹除——删除 amend 进原 docs 提交后 force push（b8c1d59 → ceeb77b），远端历史不再含姓名；.gitignore 补 reb_*.json 防再犯。
- **文档批（全量审查对齐）**：AGENTS 补 D-7 20:05 预告/两步确认词形/imageKeys 多图/快递归属信号；README API 表补 policy(POST)/roster/whitelist 四行、图片载荷补 imageKeys、当日总状态口径改「全部记录均已做完」；.env.example 补 DUTY_WEEK_REMIND_SCHEDULE、头注释去「6 段式」、状态文件示例带盘符；bot.js/webhook.js 头注释改值日战报现状。
- **测试**：全量 7 套桩过（schedule/flow/policy/roster/board/express/generate-place）；改动仅文案字符串与报告渲染，无逻辑分支变化。

## v39 · 2026-09-25 · `60654f0` · fix

**复查修复：对账报告 deferReason 时序缺陷（v38 修复自身漏网）+ 旧口径注释清理**

- 提交说明：fix: deferred spread 时序缺陷——容量/满周顺延显式携带 deferReason/deferCount（复查批）+ 旧口径注释清理
- **缺陷（独立复查发现）**：v38 的对账报告按 `deferReason==='weekly_allowance'` 区分顺延原因，但 `deferred.push({ ...o })` 的 `o` 来自独立 `load()` 快照，而 `stateStore.mutate` 是「读盘-改-写盘」语义（写盘副本与局部对象不共享引用）——mutate 里设置的 `deferReason` 不会出现在 spread 出的元素上：首次容量顺延恒误报「天天有班」，反向满周顺延会带入持久化的陈旧 `weekly_allowance` 误报「容量已满」。
- **修复**：两条顺延路径 push 时显式携带 `deferCount`（+1 后值）与 `deferReason`（容量='weekly_allowance'/满周=''），满周路径 mutate 里同步 `delete o2.deferReason` 防持久化层脏读。
- **注释清理**：compensationService:28（请假即有补位→同日兼顾）、inquiryService:77/:402、stateStore:11、assistantService:50 等按 v37 后口径改写。
- **测试**：stub-test-flow 补条件断言「满周顺延报告口径为天天有班」（当前桩日期下 C 的义务被安置未触发顺延分支，断言作为该分支护栏保留）；全量 7 套桩过。

## v40 · 2026-09-26 · `33ab617` · fix

**七仓全量审查修复批（P1×4 + P2×5）**

- 提交说明：fix: 全量审查修复——幂等键/补偿义务回退/请假精确化/静默积压合并等
- **P1×4**：①消息幂等键 messageId→messageId+载荷类型（hub 对图文混合消息拆两次转发带同 messageId，第二次恒被丢——取件码文字+照片同发时照片必丢）；②generate 路径 markPlaced 补写 placedDate（rebalance 义务重置要求 placed&&placedDate，缺失则补偿义务静默丢失）；③confirmLeave 按 pending.recordId 精确请假（原第二参恒 undefined 退化为按姓名取最早班次可错班）；④quietHours gateTask 同名任务积压合并只留最新槽位（快递整点播报静默窗逐小时堆积、09:00 冲刷同一清单连发 7 遍）。
- **P2**：push.js planPrivateConfig 区分 ENOENT 与其他错误（瞬时 SFTP 故障不再绕过守卫）、tar exclude 补 policy-override.json；README 间隔措辞对齐实现（≥3 天口径）；photoOnly 死分支删除（测试载荷同批迁生产形态）；compensationService 对账顺延原因按 deferReason 分列。
- 遗留（另批）：rebalance 保留请假记录与重排同日冲突（排班核心，需生成侧注入保留快照）。
- 测试：七套全绿，flow 套新增 placedDate 与 photos 分支断言。

## v41 · 2026-09-26 · 随本提交落地 · fix

**push.js 私有配置守卫误伤修复：ENOENT 判定兼容 ssh2 数字码 2**

- 提交说明：fix: push.js 私有配置守卫 ENOENT 判定兼容 ssh2 数字码 2（部署中止修复）
- v40 的守卫收紧只比对字符串 `'ENOENT'`，但 ssh2 原生 SFTP 对远端文件不存在抛的是 `{code: 2, message: 'No such file'}`（SSH_FX_NO_SUCH_FILE 数字码）——「远端没有、本地也没有」的正常场景（`config/policy-override.json` 两端均不存在）被误判为「无法确认现网内容」直接中止部署，v39/v40 首次上线即触发（实测两次卡在同一处，代码同步与重启均未执行）。
- 修：`planPrivateConfig` 放行条件补数字码 2；其余读取错误维持中止语义不变（v40 意图保留——非「确定不存在」的失败仍人工确认后再推）。
- 影响面：仅部署工具 push.js，服务端代码与 v40 完全一致，无行为变化。

## v42 · 2026-09-27 · 随本提交落地 · fix

**第二轮全量对抗审查修复批（P1×3 + 管理面收紧）**

- 提交说明：fix: 第二轮对抗审查——rebalance 占位恢复严格3人/绑定防抢占/生成互斥/全部已取两步确认等
- **P1×3**：①test:flow 断言把生成期合法补偿插入误当补位（9-27 起日期敏感误报卡部署闸门）——断言改对比请假前快照；②rebalance 保留记录不进生成器日占用表→该日叠满 3 新排（实测 5 记录日，破坏严格 3 人不变量）——kept 记录按日期/岗位种进 assignments 预置，基排按剩余容量补（两处断言转绿）；③rosterService bindOpenId 不查已绑定→任何队员可抢占他人绑定代打卡——已绑定拒绝并提示找管理员。
- **P2**：3006 改仅回环监听（对齐 approval/ticket）；收口归属日改上海时钟 <06:00 归前一日（防触发延迟把新当天整日置未做完）；「全部已取」两步确认（60 秒内回复「确认全部已取」）+ 已取n 记录确认人（备注列，缺列降级）；members/whitelist 原子写（tmp+rename）；generate/rebalance/placePending 全局 schedule 锁（双管理员同刻生成不再整月双写）；push.js 覆盖前重读二次判定+JSON 损坏中止不回填、tar 补 reb_*.json；inquiryService 死变量删、看板回退逐群 try/catch。
- 测试：七套全绿；roster 增抢占负例、policy 增 gateTask 合并断言、express 增两步确认断言。
- 部署须知：3006 回环后 LAN 探测 ✗ 属预期；快递表建议补「备注」列（记录取件确认人）；「全部已取」两步确认提前告知群员。

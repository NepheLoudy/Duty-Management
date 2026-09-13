# duty-bot 开发日志（DEVLOG）

> 版本隔离单位 = 一次 `npm run push`（即一次 git 提交 + 一次部署）。
> 每次 push 完成后在文末追加：`## vN · YYYY-MM-DD · <提交哈希> · <类型>`，
> 正文为提交说明原文 + 实际改动要点。vN 只增不复用，历史条目不改写。



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

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

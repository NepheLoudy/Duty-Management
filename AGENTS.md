# duty-bot（值日提醒机器人）边界声明

## 职能
值日排班生成与轮转/缺勤补偿、值日私信提醒与收口、照片凭证写表、
值日助手（私信说明/群看板）、对外值日数据接口（/api/duty/brief）、
**值日域管辖策略下发（/api/duty/policy）+ 名册自动读通讯录 + 定制窗口（roster/whitelist）**。

## 归属信号（需求关键词）
值日、排班表、轮岗、值日请假、总负责/工位区/装配区、
值日照片凭证、值日看板、昨日值日播报。

## 不归我管（易混裁定）
- DDL 卡片及其它项目管理播报 → project-management-robot（本项目的对外播报卡片也由它渲染）；
- 工单播报/接单/结单 → ticket-bot；审批/发票/报销 → approval-bot；打印 → bambu；
- 消息事件接收 → 一律 gateway→hub 转发，本项目不收事件、不在网关加直连路由；
- 值日域的"请假"与项目管理逾期确认、工单域无关。

## 联动契约
- hub → duty-bot：POST /api/chat/command
  `{command, openId, chatType:'p2p'|'group', chatId?, imageKey?, messageId?, args?}`
  指令清单（精确匹配）：值日助手 / 我要请假 / 查询我的下一次值日 / 绑定 X / 是 / 否 / 生成排班表(admin)；
  图片载荷：`{type:'image', openId, imageKey, messageId}`（hub 不做下载转存，由本项目处理）。
- duty-bot → pm-robot：GET /api/duty/brief（昨日结果+今日名单）；每日播报卡片由 pm-robot 渲染发送（M4 待实施，播报 cron 归 pm-robot）。
- duty-bot → hub：GET /api/duty/policy（值日域管辖策略，hub 短缓存消费）——管辖群列表
  （`.env` 的 `DUTY_GROUP_CHAT_IDS`）、生效范畴（看板触发词/关键词回答放行/基础指令关闭/引导语）、
  p2p 指令清单。**值日域的权限管辖范畴与生效范畴以本接口为单一事实来源**，hub 断联时以其本仓 env 兜底。
- gateway：默认无登记；如需表格事件即时感知再按消费者登记接入（二期）。

## 铁律
- 不消费消息事件（无 /api/feishu/event，不接长连接）；
- 定时播报一律过 quietHours 闸门（收口等业务写表动作不延迟，仅通知过闸门）；
- 多维表格为排班单一事实来源（轮转状态每次生成时从表格既有记录反推，不单独维护双份状态）；
- 部署一律 `npm run push`（qianli-deploy 链路）；
- **隐私**：真实名册/白名单（config/members.json、whitelist.json）与 .env 永不进 git，
  仓库只保留 *.example.json 模板；代码、文档、注释、测试一律不出现真实姓名/open_id/群凭据。

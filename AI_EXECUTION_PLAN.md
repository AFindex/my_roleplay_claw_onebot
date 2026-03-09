# OneBot/NapCat 功能接入 AI 执行规划

## 文档目的

这份文档用于指导后续 AI 或工程实现者，按统一边界和顺序扩展当前仓库的 OneBot/NapCat 能力。

文档目标只有两个：

- 明确当前插件后续应该接什么
- 明确哪些内容现在禁止继续扩展

## 最重要的硬约束

### 不要规划异步任务能力

`asyncReply` 相关链路目前只是测试用途，设计没有定型，不应继续扩展，不应作为正式功能路线的一部分。

后续 AI 在执行本规划时，必须遵守下面这些限制：

- 不新增任何异步任务功能
- 不新增任何 `asyncReply` 配置项
- 不新增任何 `/async`、`/异步`、异步状态查询、异步记录检索、异步润色相关能力
- 不以异步任务为前提设计群助手、文件处理、总结、管理动作
- 不主动重构或扩展以下文件，除非只是为了避免它们影响本次改动

涉及的排除文件：

- `src/async-ack-ai.ts`
- `src/async-intent-ai.ts`
- `src/async-record-search-ai.ts`
- `src/async-task-records.ts`
- `src/handlers/process-inbound-async.ts`

如果某次实现确实碰到了这些文件，允许做两类最小处理：

- 兼容当前编译和运行
- 降低和新功能的耦合

不允许做的事情：

- 给它们继续加新入口
- 给它们补“正式产品化”
- 围绕它们继续加命令、配置、文档和测试

## 当前项目基线

当前仓库是一个 `TypeScript + Node.js + ws` 的 OpenClaw OneBot v11 渠道插件。

现状可以概括为：

- 已有 WebSocket 正反向连接
- 已有私聊和群聊入站处理
- 群聊支持 `@` 判定
- 已有文本、图片和 `@` 的主动发送
- 已有入群欢迎
- 已有群总结命令
- 已有基础会话记录、媒体暂存和 transcript 镜像

当前核心文件职责：

- `src/service.ts`：WebSocket 连接与事件入口
- `src/connection.ts`：底层 OneBot action 调用和基础查询
- `src/handlers/process-inbound.ts`：主消息链路
- `src/send.ts`：主动发送入口
- `src/message.ts`：入站消息语义提取
- `src/onebot-rich-text.ts`：模型输出标记到 OneBot 消息段的转换
- `src/config.ts`：OneBot 配置读取
- `openclaw.plugin.json`：渠道配置 schema

## 官方文档依据

本规划基于以下官方资料整理：

- NapCat 扩展 API 文档：<https://napneko.github.io/develop/api/doc>
- NapCat 上报事件兼容情况：<https://napneko.github.io/develop/event>
- NapCat 消息格式兼容情况：<https://napneko.github.io/develop/msg>
- NapCat 文件处理指南：<https://napneko.github.io/develop/file>
- OneBot v11 公共 API：<https://github.com/botuniverse/onebot-11/blob/master/api/public.md>

## 实施总原则

### 1. 先标准 OneBot，再 NapCat 扩展

默认优先接标准 OneBot v11 能力。

只有满足下面条件时，才接 NapCat 私有扩展：

- 标准能力无法覆盖需求
- NapCat 官方文档明确提供能力
- 配置中能显式区分 provider

### 2. 先补协议层，再补产品层

先把消息段、事件、查询、文件处理这些协议层补齐，再做群助手命令和管理功能。

### 3. 所有 NapCat 私有能力必须受 provider 开关保护

后续需要引入 `provider` 概念，至少支持：

- `generic`
- `napcat`

在未显式声明 `napcat` 前，不应默认启用 `mface`、表情贴回复、AI 语音、NapCat Stream API 等私有能力。

### 4. 所有新增能力都要有文本兜底

模型或外部调用产出的复杂消息段，必须保留可读文本语义，避免 transcript 中只出现平台码。

### 5. 不改变当前基础聊天链路

扩展能力时，不要破坏下面这些现有行为：

- 私聊正常收发
- 群聊 `@` 判定
- 图片/视频入站暂存
- 群总结命令
- `openclaw message send --channel onebot` 基础可用

## 目标能力范围

本规划纳入范围的能力，按优先级分为五个层级。

### A. 标准消息段增强

优先补齐这些消息段的发收能力：

- `face`
- `record`
- `rps`
- `dice`
- `poke`
- `reply`
- `forward`
- `node`
- `file`

谨慎处理：

- `shake`
- `contact`
- `music`
- `json`

暂不优先：

- `markdown`
- `lightapp`

原因：

- NapCat 文档确认 `face`、`record`、`rps`、`dice`、`reply`、`forward`、`file` 都支持收发
- `poke` 虽然不通过普通消息段上报，但文档确认支持事件和接口调用
- 这些能力最能直接提升 QQ 侧真实使用体验

### B. 事件与请求处理

优先补齐这些上报事件：

- `notice.notify.poke`
- `notice.group_recall`
- `notice.friend_recall`
- `notice.group_upload`
- `notice.group_ban`
- `notice.group_admin`
- `notice.group_card`
- `notice.group_decrease`
- `notice.essence`
- `request.friend`
- `request.group.add`
- `request.group.invite`

### C. 信息查询与群资料

优先补齐这些查询接口：

- `get_login_info`
- `get_friend_list`
- `get_group_list`
- `get_group_member_list`
- `get_group_member_info`
- `get_group_honor_info`
- `get_status`
- `get_version_info`
- `get_record`
- `get_file`

### D. 文件与转发能力

优先补齐这些能力：

- `file` 消息段收发
- `get_forward_msg`
- `send_forward_msg`
- 文件直链和本地落盘处理
- NapCat `upload_file_stream` 的可选支持

### E. NapCat 私有增强

放到最后做：

- `mface`
- `fetch_custom_face`
- `set_msg_emoji_like`
- `group_poke` / `friend_poke` / `send_poke`
- `send_group_ai_record`
- `get_ai_record`
- `get_ai_characters`
- `set_group_sign`
- `mark_private_msg_as_read`
- `mark_group_msg_as_read`

## 不纳入本轮路线的内容

以下内容当前不进入执行范围：

- 异步任务产品化
- 自动定时总结
- 主动播报
- 长消息图片化
- Web UI
- 多账号体系重构
- 线程化会话
- reactions capability 的正式开放

补充说明：

- `reactions` 只有在“贴表情”真正做完后才考虑从 `false` 调整
- 定时总结和主动播报以后可以单独立项，但不应和异步任务链路绑定

## 执行阶段

## 阶段 0：边界固化与基础整理

### 目标

先把后续扩展的边界固定下来，避免 AI 在执行中误把异步线继续做大。

### 必做任务

- 在开发文档和后续实现说明里明确 `asyncReply` 为实验用途
- 后续所有新配置和新命令都不得依赖异步任务
- 新增 `provider` 设计草案，但先不强制落代码
- 梳理统一的事件路由模型，替代 `service.ts` 里继续堆 `if/else`

### 涉及文件

- `README.md`
- `DEV.md`
- `src/service.ts`
- `src/config.ts`
- `openclaw.plugin.json`

### 验收标准

- 后续 AI 读文档时，能明确知道异步是排除项
- 事件扩展的落点不再混杂在单个大函数里

## 阶段 1：标准消息段增强

### 目标

把当前只支持 `text/image/@` 的能力，扩展成更像 QQ 原生机器人的消息表现。

### 必做任务

- 扩展 `src/onebot-rich-text.ts`
- 让模型输出中间标记可以映射到更多标准段
- 扩展 `src/handlers/process-inbound-reply.ts`
- 扩展 `src/message.ts`
- 为复杂消息段保留可读文本语义

### 推荐的中间标记格式

- `[[face:123]]`
- `[[record:file:///tmp/a.mp3]]`
- `[[rps]]`
- `[[dice]]`
- `[[poke:user=123456]]`
- `[[reply:12345]]`

### 建议先做的实现顺序

1. `face`
2. `record`
3. `rps` / `dice`
4. `reply`
5. `file`
6. `forward` / `node`

### 涉及文件

- `src/onebot-rich-text.ts`
- `src/handlers/process-inbound-reply.ts`
- `src/message.ts`
- `src/send.ts`
- `src/types.ts`

### 验收标准

- 主动发送和正常回复都能发 `face`
- 入站 `face` / `record` 不会被直接吞掉
- transcript 中能看到可读语义，而不是只看到平台结构
- 不影响已有文本、图片、@ 的发收

## 阶段 2：事件与请求路由

### 目标

把当前只接 `message` 和 `group_increase` 的事件入口，扩成可维护的 notice/request 路由层。

### 必做任务

- 重构 `src/service.ts` 中的事件分发
- 建立 `notice` 和 `request` 的 handler 目录或统一路由模块
- 接入 `poke`、撤回、群文件上传、群管理变更、好友申请、加群申请
- 为“自动通过/自动拒绝/通知给主人”预留配置位

### 推荐命令与行为

- `poke`：可先做记录和轻提示，不强制回复
- `request.friend` / `request.group.*`：先做保守模式，默认只通知，不默认自动通过
- `group_upload`：先做消息提示和记录，不急着自动处理文件

### 涉及文件

- `src/service.ts`
- `src/connection.ts`
- `src/config.ts`
- `openclaw.plugin.json`
- 新增 `src/handlers/notice-*.ts`
- 新增 `src/handlers/request-*.ts`

### 验收标准

- `service.ts` 不再手写零散事件判断
- 新事件可以按类型独立扩展
- 接到请求事件后，至少可以记录、通知、配置化处理

## 阶段 3：信息查询与群资料能力

### 目标

让插件从“聊天插件”升级成“群助手能力底座”。

### 必做任务

- 在 `src/connection.ts` 增加标准查询 wrapper
- 增加机器人信息、群信息、群成员列表、群荣誉、状态、版本查询
- 增加轻量缓存或快照层，用于群资料和成员资料
- 基于现有命令体系增加人工触发查询命令

### 建议优先接的命令

- `/机器人状态`
- `/群资料`
- `/群成员 关键词`
- `/群荣誉`
- `/最近联系人`

### 数据存储建议

- 不要做重量数据库
- 先做轻量 JSON 快照或基于现有 session store 的独立 sidecar 文件
- 群成员快照要带时间戳和来源

### 涉及文件

- `src/connection.ts`
- `src/config.ts`
- `src/handlers/process-inbound.ts`
- 新增 `src/handlers/process-inbound-admin.ts` 或 `process-inbound-query.ts`
- 新增 `src/group-profile-store.ts`

### 验收标准

- 可以查到群列表、群成员列表、机器人自身状态
- 群资料能被后续命令直接复用
- 不依赖异步链路

## 阶段 4：文件与合并转发

### 目标

让插件具备更完整的媒体和结果投递能力。

### 必做任务

- 支持 `file` 消息段发送和接收
- 接 `get_file`、`get_record`、`get_forward_msg`
- 接 `send_forward_msg`
- 设计文件暂存、过期清理和下载刷新逻辑
- 仅在 `provider=napcat` 时考虑 `upload_file_stream`

### 实现建议

- 小文件优先走普通路径或 URL
- 大文件、跨设备部署场景再接 NapCat Stream API
- 图片、语音、普通文件分别设计获取逻辑，不要混成一个模糊接口

### 涉及文件

- `src/connection.ts`
- `src/send.ts`
- `src/message.ts`
- `src/handlers/process-inbound-shared.ts`
- `src/types.ts`

### 验收标准

- 能稳定发送普通文件
- 接收到文件时能拿到可用引用或落盘路径
- 合并转发消息能发送和读取
- 文件清理不会破坏现有图片缓存机制

## 阶段 5：NapCat 私有增强

### 目标

在标准能力齐备后，再增加 QQ 氛围更强的私有增强。

### 必做任务

- 引入显式 provider 开关
- 接 `mface`
- 接 `fetch_custom_face`
- 接 `set_msg_emoji_like`
- 接 `send_poke`
- 评估 `get_ai_record` / `send_group_ai_record` 的产品价值

### 实现原则

- 私有能力必须全部走显式 provider 判断
- transcript 中仍要保留文字语义
- 没有 provider 确认时，不要默认调用 NapCat 私有 action

### 涉及文件

- `src/config.ts`
- `src/setup.ts`
- `openclaw.plugin.json`
- `src/connection.ts`
- `src/onebot-rich-text.ts`
- `src/handlers/process-inbound-reply.ts`
- `src/channel.ts`

### 验收标准

- `provider=generic` 时，插件仍然稳定可用
- `provider=napcat` 时，私有功能可被单独启用
- 没有把 NapCat 私有能力泄漏到标准路径

## 推荐实施顺序

后续真正动手时，建议严格按下面顺序推进：

1. 阶段 0：先把边界和事件结构定住
2. 阶段 1：先做标准消息段增强
3. 阶段 2：再做事件与请求
4. 阶段 3：再做信息查询和群资料
5. 阶段 4：再做文件与合并转发
6. 阶段 5：最后做 NapCat 私有增强

## 每一阶段都必须补的验证

### 基础验证

- `npm run build`
- 能连接 OneBot WebSocket
- 私聊正常收发
- 群聊 `@` 后正常收发
- 现有图片发送不回归

### 行为验证

- 新消息段至少有一条主动发送验证
- 新事件至少有一条真实或模拟上报验证
- 新查询接口至少有一条成功返回验证
- 新文件能力至少验证一次本地路径和一次 URL 路径

### 回归验证

- 群总结命令仍然可用
- 入群欢迎仍然可用
- 不因为新增 provider 判断而破坏旧配置
- 不新增对异步能力的任何依赖

## 后续 AI 执行时的禁令摘要

后续 AI 如果基于本文档继续工作，必须重复检查下面四条：

- 不做异步任务
- 不围绕 `asyncReply` 做产品化
- 不把 NapCat 私有能力直接混进标准 OneBot 路径
- 不为了赶功能牺牲现有私聊、群聊、图片和总结链路的稳定性

## 一句话路线

先把标准 OneBot 消息段、事件、查询和文件能力补齐，再在显式 provider 开关下接 NapCat 私有增强；异步任务链路明确排除，不纳入正式演进路线。

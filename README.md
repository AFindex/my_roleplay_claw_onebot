# my-claw-onebot

一个精简版的 `OpenClaw OneBot v11` 渠道插件骨架，参考 `openclaw-onebot` 的整体思路实现，先保留最基本可走通的框架与 skill。

## 当前包含

- OneBot 渠道插件注册
- forward / backward WebSocket 连接
- 私聊消息接收与回复
- 群聊消息接收与 `@` 判定
- `openclaw message send --channel onebot` 主动发送
- 文本 / 图片发送
- 群聊主动 `@` 某个人（支持 `[[at:QQ号]]` / `[[at:sender]]` 标记）
- 新成员入群欢迎（文本模板版）
- `openclaw onebot setup` 交互式配置
- repo 内置 `skills/onebot-ops`、`skills/onebot-emoji-style`、`skills/onebot-emoji-actions`
- `templates/roleplay-agent` 人设与绑定模板

## 安装依赖

```bash
npm install
npm run build
```

## 本地调试

当前包已经把 OpenClaw 插件入口指向 `src/index.ts`，默认开发流程直接使用你机器上的默认 Gateway 服务。

推荐工作流：

```bash
# 第一次只需要执行一次，把当前仓库链接到默认 profile
npm run dev:link

# 之后每次改完插件代码，直接重启默认 gateway
openclaw gateway restart
```

常用辅助命令：

```bash
# 查看服务状态
openclaw gateway status

# 探测 gateway 是否可达
npm run dev:probe

# 跟随日志
npm run dev:logs
```

调试时的体验差异：

- 改 `src/**/*.ts`：直接执行 `openclaw gateway restart`
- 改 `skills/**`：通常下一次 agent turn 就会读取到
- 改 `channels.onebot` 配置：通常重启一次 Gateway 最稳
- 发布前：仍然可以执行 `npm run build`

## 配置

推荐直接运行：

```bash
openclaw onebot setup
```

也可以在 `openclaw.json` 中写入：

```json
{
  "channels": {
    "onebot": {
      "type": "forward-websocket",
      "host": "127.0.0.1",
      "port": 3001,
      "accessToken": "",
      "path": "/onebot/v11/ws",
      "requireMention": true,
      "renderMarkdownToPlain": true
    }
  }
}
```

## 主动发送

```bash
openclaw message send --channel onebot --target user:123456789 --message "你好"
openclaw message send --channel onebot --target group:987654321 --message "大家好"
openclaw message send --channel onebot --target group:987654321 --message "[[at:123456789]] 你好呀"
openclaw message send --channel onebot --target group:987654321 --media "file:///tmp/a.png"
```

说明：

- 群聊里可以在文本里写 `[[at:QQ号]]`，发送时会转成 OneBot `at` 消息段
- 在群聊回复链路里也支持 `[[at:sender]]`，会自动 `@` 当前发言人

## 测试连接

```bash
cp .env.example .env
npm run test:connect
```

## 内置 Skill

- `skills/onebot-ops`：OneBot 基础配置、收发、target 规则
- `skills/onebot-emoji-style`：给 QQ / OneBot 角色规划表情风格、密度、占位标记
- `skills/onebot-emoji-actions`：在插件里实现 `face` / `poke` / `mface` / 贴表情等能力

## 群聊记录与上下文

这个插件现在会把群聊消息按 OpenClaw 的 session 机制写入会话记录：

- 每条入站消息都会走 `recordInboundSession`
- agent 的 session transcript 会落到对应的 `sessions/*.jsonl`
- 群聊上下文里会记录基础会话标识，如 `onebot:group:<群号>`
- 群消息正文现在会带发送者标识：`名称 / 群昵称 (QQ号): 消息内容`
- 群聊元数据现在会额外注入群名称、发送者名称、群昵称、QQ号等上下文
- 如果当前消息或引用消息里带图片 / 视频，会尽量把可解析到的媒体文件一并传给 OpenClaw 模型

当前仍然**没有**单独维护一份“群资料数据库”或“群成员快照索引”；也就是说：

- 有逐条会话记录
- 有当前消息级别的群元数据
- 但还没有独立的长期群摘要 / 群画像存储

## 异步任务回复

插件现在支持三层判定顺序：

- 显式触发：`/async 你的任务`
- 显式触发：`/异步 你的任务`
- 显式触发：`异步：你的任务`
- 自动触发：优先走 AI 快速判定；如果 AI 未启用或失败，可回退到关键词判定

行为分两种：

- 当 `asyncReply.spawnTaskSession=false` 时，会直接在原主会话里继续处理，不发送即时确认；不会创建子 session，也不会启用异步任务记录检索
- 当 `asyncReply.spawnTaskSession=true` 时，才会先回一条简短确认
- 当 `asyncReply.spawnTaskSession=true` 时，才会把任务放到一个独立后台会话里处理
- 开启子 session 后，原来的群/私聊主会话不会被这个长任务卡住
- 开启子 session 后，后台拿到原始结果后，还会再结合最近对话上下文做一轮润色
- 开启子 session 后，最后再向原聊天单独发一条更自然的最终回复
- 开启子 session 后，异步任务的用户原话、即时应答、最终结果/失败信息，都会镜像回原主会话 transcript
- 开启子 session 后，还会在 agent 的 sessions 目录下单独维护 `onebot-async-records.json`，记录异步子 session、状态和结果摘要
- 开启子 session 后，当用户在原会话里追问“刚才那个异步任务”时，会先检索这份记录，再把匹配到的状态作为 untrusted context 注入主会话，让角色自然接话

可选配置示例：

```jsonc
{
  "channels": {
    "onebot": {
      "asyncReply": {
        "enabled": true,
        "spawnTaskSession": false,
        "ackText": "收到啦，我先慢慢查一下喔，弄好后再回来认真跟你说。",
        "keywords": ["查一下", "调研", "总结", "分析一下", "写个方案"],
        "recentMessages": 6,
        "contextCharLimit": 1200,
        "rawResultCharLimit": 3200,
        "ai": {
          "enabled": true,
          "baseUrl": "https://api.moonshot.cn/v1",
          "apiKey": "<YOUR_MOONSHOT_API_KEY>",
          "judgeModel": "kimi-k2.5",
          "ackModel": "kimi-k2.5",
          "searchModel": "kimi-k2-turbo-preview",
          "timeoutMs": 3500,
          "maxTokens": 48,
          "temperature": 0.6,
          "fallbackToKeywords": true
        }
      }
    }
  }
}
```

说明：

- 现在默认会优先启用 AI 快速判定；如果没配 API Key 或请求失败，会回退到关键词判定
- `asyncReply.spawnTaskSession` 默认是 `false`；默认不会发即时确认，而是直接在原主会话里继续完成这次回复
- 只有把 `asyncReply.spawnTaskSession=true` 打开后，才会启用完整的异步子 session、结果回填和异步记录检索链路
- 默认会分别读取 `ai.judgeModel`、`ai.ackModel` 和 `ai.searchModel`；若没配，会向后兼容旧的 `ai.model`
- 示例里的长任务判定模型和即时应答模型都使用 `kimi-k2.5`；异步记录检索模型仍是 `kimi-k2-turbo-preview`
- 对 `kimi-k2.5` 作为长任务判定模型或即时应答模型时，请求会按官方文档显式传 `thinking: { "type": "disabled" }`；旧模型仍兼容 `thinking: "off"`
- 温度默认是 `0.6`
- 如果你不想把 key 写进配置，也可以通过环境变量 `ONEBOT_ASYNC_AI_API_KEY` 或 `MOONSHOT_API_KEY` 提供
- 也支持分别用 `ONEBOT_ASYNC_AI_JUDGE_MODEL`、`ONEBOT_ASYNC_AI_ACK_MODEL` 与 `ONEBOT_ASYNC_AI_SEARCH_MODEL` 覆盖这三个模型；旧的 `ONEBOT_ASYNC_AI_MODEL` 仍可作为兼容回退
- `asyncReply.enabled=false` 时会关闭自动判定，但显式 `/async` 仍然可用

## 群总结 AI 配置

插件现在预留了独立的 `groupSummary` 配置，方便后面接群总结、日报、话题归纳这类能力。

可选配置示例：

```jsonc
{
  "channels": {
    "onebot": {
      "groupSummary": {
        "enabled": false,
        "method": "recent-messages",
        "recentMessages": 80,
        "contextCharLimit": 6000,
        "focusKeywords": ["发布", "回滚", "报错"],
        "ai": {
          "enabled": true,
          "baseUrl": "https://api.moonshot.cn/v1",
          "apiKey": "<YOUR_MOONSHOT_API_KEY>",
          "model": "kimi-k2.5",
          "timeoutMs": 30000,
          "maxTokens": 1024,
          "temperature": 0.3
        }
      }
    }
  }
}
```

默认约定：

- 默认模型是 `kimi-k2.5`
- 默认按非思考模式使用；如果后续接 Moonshot 请求，建议显式传 `thinking: { "type": "disabled" }`
- `groupSummary.enabled` 默认是 `false`，避免未接命令/入口前自动生效

推荐的几种 AI 总结方法：

- `recent-messages`：总结最近 N 条消息，适合临时回顾“刚刚群里聊了啥”
- `since-last-reply`：从机器人上次发言后开始总结，适合补看未读
- `focused-keywords`：围绕关键词抽取相关讨论，适合排查事故、整理需求、跟踪某个话题

当前已经支持的群总结指令：

- `/summary`：按 `groupSummary.method` 的默认方式总结
- `/summary recent 50`：总结最近 50 条群聊
- `/summary since-last-reply`：总结机器人上次说话以来的内容
- `/summary topic 发布 回滚`：按关键词做聚焦总结
- `/群总结`：中文别名

当前实现状态：

- 已接入显式命令触发
- 已接入 `groupSummary` 独立 AI 配置
- 还没有接自动定时总结 / 主动播报

## 人设模板

如果你想把 OneBot 接到一个固定人设的 OpenClaw agent，参考：

- `templates/roleplay-agent/README.md`
- `templates/roleplay-agent/IDENTITY.md`
- `templates/roleplay-agent/openclaw.example.jsonc`

## 说明

这个版本优先追求“能走通”，所以先没有加入长消息图片化、合并转发、定时任务、欢迎脚本命令钩子等增强特性。

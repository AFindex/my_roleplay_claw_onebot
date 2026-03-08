# my-claw-onebot

一个精简版的 `OpenClaw OneBot v11` 渠道插件骨架，参考 `openclaw-onebot` 的整体思路实现，先保留最基本可走通的框架与 skill。

## 当前包含

- OneBot 渠道插件注册
- forward / backward WebSocket 连接
- 私聊消息接收与回复
- 群聊消息接收与 `@` 判定
- `openclaw message send --channel onebot` 主动发送
- 文本 / 图片发送
- 新成员入群欢迎（文本模板版）
- `openclaw onebot setup` 交互式配置
- repo 内置 `skills/onebot-ops`
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
- 改 `skills/onebot-ops/**`：通常下一次 agent turn 就会读取到
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
openclaw message send --channel onebot --target group:987654321 --media "file:///tmp/a.png"
```

## 测试连接

```bash
cp .env.example .env
npm run test:connect
```

## 异步任务回复

插件现在支持三层判定顺序：

- 显式触发：`/async 你的任务`
- 显式触发：`/异步 你的任务`
- 显式触发：`异步：你的任务`
- 自动触发：优先走 AI 快速判定；如果 AI 未启用或失败，可回退到关键词判定

行为分两种：

- 无论哪种模式，插件都会先立即回一条简短确认
- 当 `asyncReply.spawnTaskSession=false` 时，会先发送即时确认，再继续在原主会话里完成后续回复；不会创建子 session，也不会启用异步任务记录检索
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
          "judgeModel": "kimi-k2-turbo-preview",
          "ackModel": "kimi-k2-turbo-preview",
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
- `asyncReply.spawnTaskSession` 默认是 `false`；默认会先发即时确认，再在原主会话里继续完成这次回复，但不会拉起后台子 session
- 只有把 `asyncReply.spawnTaskSession=true` 打开后，才会启用完整的异步子 session、结果回填和异步记录检索链路
- 默认会分别读取 `ai.judgeModel`、`ai.ackModel` 和 `ai.searchModel`；若没配，会向后兼容旧的 `ai.model`
- 当前默认判断模型、即时应答模型、异步记录检索模型都是 `kimi-k2-turbo-preview`，温度默认是 `0.6`，并且请求会显式带上 `thinking: "off"`
- 如果你不想把 key 写进配置，也可以通过环境变量 `ONEBOT_ASYNC_AI_API_KEY` 或 `MOONSHOT_API_KEY` 提供
- 也支持分别用 `ONEBOT_ASYNC_AI_JUDGE_MODEL`、`ONEBOT_ASYNC_AI_ACK_MODEL` 与 `ONEBOT_ASYNC_AI_SEARCH_MODEL` 覆盖这三个模型；旧的 `ONEBOT_ASYNC_AI_MODEL` 仍可作为兼容回退
- `asyncReply.enabled=false` 时会关闭自动判定，但显式 `/async` 仍然可用

## 人设模板

如果你想把 OneBot 接到一个固定人设的 OpenClaw agent，参考：

- `templates/roleplay-agent/README.md`
- `templates/roleplay-agent/IDENTITY.md`
- `templates/roleplay-agent/openclaw.example.jsonc`

## 说明

这个版本优先追求“能走通”，所以先没有加入长消息图片化、合并转发、定时任务、欢迎脚本命令钩子等增强特性。

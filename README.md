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

## 人设模板

如果你想把 OneBot 接到一个固定人设的 OpenClaw agent，参考：

- `templates/roleplay-agent/README.md`
- `templates/roleplay-agent/IDENTITY.md`
- `templates/roleplay-agent/openclaw.example.jsonc`

## 说明

这个版本优先追求“能走通”，所以先没有加入长消息图片化、合并转发、定时任务、欢迎脚本命令钩子等增强特性。

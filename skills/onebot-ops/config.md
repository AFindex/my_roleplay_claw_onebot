# 配置

当前最小版本支持这些参数：

| 参数 | 说明 |
| --- | --- |
| `type` | `forward-websocket` 或 `backward-websocket` |
| `host` | OneBot 主机地址 |
| `port` | OneBot 端口 |
| `accessToken` | 访问令牌，可选 |
| `path` | WebSocket 路径，默认 `/onebot/v11/ws` |
| `requireMention` | 群聊是否必须 `@` 机器人 |
| `renderMarkdownToPlain` | 是否把 Markdown 回复转为纯文本 |
| `groupIncrease.enabled` | 是否启用入群欢迎 |
| `groupIncrease.message` | 欢迎语模板 |

## 推荐方式

```bash
openclaw onebot setup
```

## 环境变量

```bash
ONEBOT_WS_TYPE=forward-websocket
ONEBOT_WS_HOST=127.0.0.1
ONEBOT_WS_PORT=3001
ONEBOT_WS_ACCESS_TOKEN=
ONEBOT_WS_PATH=/onebot/v11/ws
```


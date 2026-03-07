# 接收与回复

## 基本规则

- 私聊消息：默认都会进入回复链路
- 群聊消息：默认只有 `@` 机器人时才会进入回复链路

## deliver 行为

当前最小版本会把 Agent 输出的：

- `text` / `body` 作为文本发送
- `mediaUrl` / `mediaUrls[0]` 作为图片发送

## 群欢迎

支持最简单的欢迎语模板：

```json
{
  "channels": {
    "onebot": {
      "groupIncrease": {
        "enabled": true,
        "message": "欢迎 {name} 加入 {groupName}！"
      }
    }
  }
}
```

可用占位符：`{name}`、`{groupName}`、`{userId}`、`{groupId}`、`{avatarUrl}`。


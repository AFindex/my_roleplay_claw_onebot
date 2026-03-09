# NapCat 表情相关扩展

以下内容属于 NapCat 私有扩展，不应当默认视为所有 OneBot v11 实现都支持。

## `mface`

NapCat 文档里提供扩展消息段：

```json
{
  "type": "mface",
  "data": {
    "emoji_package_id": 0,
    "emoji_id": "string",
    "key": "string",
    "summary": "string"
  }
}
```

适合更接近 QQ 原生扩展表情的场景，但要先确认当前后端就是 NapCat。

## 获取自定义表情

接口：`/fetch_custom_face`

请求示例：

```json
{
  "count": 10
}
```

文档示例响应是 URL 列表，可用于“让机器人知道当前账号有哪些收藏表情”。

## 给消息贴表情

接口：`/set_msg_emoji_like`

请求示例：

```json
{
  "message_id": 12345,
  "emoji_id": "123",
  "set": true
}
```

适合给已有消息追加“点赞 / 贴表情”动作，不等同于发送一条新表情消息。

## 查看贴表情结果

- `/get_emoji_likes`：按 `message_id`、`emoji_id` 查看贴表情列表
- `/fetch_emoji_like`：查看某个表情的点赞详情，示例里还带 `emojiType`、`count`、`cookie`

## 接入建议

- 在配置里显式区分 provider，例如 `generic` / `napcat`
- provider 私有能力单独走 `sendOneBotAction(...)`
- UI / prompt 层只描述能力，不要假设 generic OneBot 也能用

# 主动发送

使用 OpenClaw 自带发送链路：

```bash
openclaw message send --channel onebot --target user:123456789 --message "你好"
openclaw message send --channel onebot --target group:987654321 --message "大家好"
openclaw message send --channel onebot --target group:987654321 --media "file:///tmp/a.png"
```

## target 规则

- 私聊：`user:<QQ号>`
- 群聊：`group:<群号>`
- 也兼容 `onebot:group:123`、`qq:user:123`


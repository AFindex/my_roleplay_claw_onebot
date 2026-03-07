---
name: onebot-ops
description: OneBot (QQ/Lagrange) 渠道的最小运维与使用说明，围绕基础收发、配置和 target 规则。
---

# OneBot 基础运维

这个 skill 对应当前仓库里的精简版 OneBot 渠道插件，目标是先让链路走通。

## 快速判断

- 收消息：私聊默认回复，群聊默认只在 `@` 机器人时回复
- 发消息：优先用 `openclaw message send --channel onebot`
- target：群聊用 `group:<群号>`，私聊用 `user:<QQ号>`
- 配置：优先运行 `openclaw onebot setup`

## 文档

- 配置：`config.md`
- 主动发送：`send.md`
- 接收与回复：`receive.md`


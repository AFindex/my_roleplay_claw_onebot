# OneBot 角色助手模板

这套模板用于把“助手人设”放在 OpenClaw 的 agent 层，而不是写死在 OneBot 插件里。

## 文件职责

- `IDENTITY.md`：角色/助手的人设正文，建议放在 agent 工作区根目录
- `openclaw.example.jsonc`：`channels.onebot`、`agents.list`、`bindings` 的最小示例

## 推荐用法

1. 新建一个 agent 工作区，例如 `~/.openclaw/workspace-roleplay`
2. 将本目录下的 `IDENTITY.md` 复制到该工作区根目录
3. 参考 `openclaw.example.jsonc`，把相关字段合并到 `~/.openclaw/openclaw.json`
4. 按需修改 agent 的 `id`、`name`、`workspace`、`model`
5. 执行 `openclaw gateway restart`

## 放置原则

- OneBot 插件负责收消息、发消息、做渠道适配
- OpenClaw agent 负责人设、口吻、边界、记忆和长期行为
- `bindings` 负责把 `onebot/default` 路由到你指定的 agent

## 适用场景

- 你希望 QQ / OneBot 总是由同一个固定人设回复
- 你想调整人设时，不必改插件代码
- 你希望后续还能给这个角色加记忆、技能和专属工作区文件

## 注意

- 这个模板默认把 `onebot` 的 `default` 账号绑定到 `roleplay` agent
- 如果你已经有现成 agent，可以直接把 `agentId` 改成已有的 id
- `agents.list[].identity` 里的 `name` / `emoji` 只适合放简短标识；完整人设仍然建议写在 `IDENTITY.md`

## 现成参考目录

- `isla-plastic-memories/`：基于《Plastic Memories》艾拉整理的研究笔记与定制版 `IDENTITY.md`

# DEV

这个仓库现在按“默认 OpenClaw profile + 默认 Gateway 服务”来调试。

## 一次性初始化

```bash
npm install
npm run build
npm run dev:link
```

`npm run dev:link` 只需要第一次执行一次，用来把当前仓库链接成 OpenClaw 插件。

## 日常开发

改完 `src/**/*.ts` 之后，直接执行：

```bash
openclaw gateway restart
```

这是默认流程，不需要重新安装插件。

## 常用检查命令

```bash
# 看 Gateway 服务状态
openclaw gateway status

# 测试 OneBot 连接
npm run test:connect

# 跟随 OpenClaw 日志
npm run dev:logs
```

## 出问题时优先检查

```bash
# 看 NapCat/QQ 还在不在
napcat status 2932043832
```

如果 `napcat status` 显示没在运行，那么先恢复 OneBot 服务，再执行：

```bash
openclaw gateway restart
npm run test:connect
```

## 最短流程

```bash
openclaw gateway restart
npm run test:connect
```

## 备注

- 插件入口是 `src/index.ts`
- `scripts/test-connect.ts` 会优先读取默认 OpenClaw 配置里的 OneBot 参数
- 如果只是改 `skills/**`，通常下一次 agent turn 就会生效

import {
  cancel as clackCancel,
  confirm as clackConfirm,
  intro as clackIntro,
  isCancel,
  outro as clackOutro,
  select as clackSelect,
  text as clackText
} from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENCLAW_HOME = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_HOME, "openclaw.json");

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    clackCancel("已取消。");
    process.exit(0);
  }
  return value as T;
}

export async function runOneBotSetup(): Promise<void> {
  clackIntro("OneBot 渠道配置");

  const type = guardCancel(await clackSelect({
    message: "连接类型",
    options: [
      { value: "forward-websocket", label: "forward-websocket（主动连 OneBot）" },
      { value: "backward-websocket", label: "backward-websocket（等待 OneBot 连接）" }
    ],
    initialValue: process.env.ONEBOT_WS_TYPE === "backward-websocket" ? "backward-websocket" : "forward-websocket"
  }));

  const host = guardCancel(await clackText({
    message: "主机地址",
    initialValue: process.env.ONEBOT_WS_HOST || "127.0.0.1"
  }));

  const portText = guardCancel(await clackText({
    message: "端口",
    initialValue: process.env.ONEBOT_WS_PORT || "3001"
  }));

  const accessToken = guardCancel(await clackText({
    message: "Access Token（可选）",
    initialValue: process.env.ONEBOT_WS_ACCESS_TOKEN || ""
  }));

  const requireMention = guardCancel(await clackConfirm({
    message: "群聊只在 @ 机器人时回复？",
    initialValue: true
  }));

  const renderMarkdownToPlain = guardCancel(await clackConfirm({
    message: "把 Markdown 回复转成纯文本发送？",
    initialValue: true
  }));

  const port = Number(String(portText).trim());
  if (!Number.isFinite(port)) {
    throw new Error("端口必须是数字");
  }

  let existing: any = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const next = {
    ...existing,
    channels: {
      ...(existing.channels ?? {}),
      onebot: {
        ...(existing.channels?.onebot ?? {}),
        enabled: true,
        type,
        host: String(host).trim(),
        port,
        ...(String(accessToken).trim() ? { accessToken: String(accessToken).trim() } : {}),
        requireMention,
        renderMarkdownToPlain,
        path: "/onebot/v11/ws"
      }
    }
  };

  mkdirSync(OPENCLAW_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  clackOutro(`配置已保存到 ${CONFIG_PATH}`);
}


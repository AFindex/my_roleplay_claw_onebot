import { getRenderMarkdownToPlain } from "./config.js";
import { sendGroupImage, sendGroupMsg, sendPrivateImage, sendPrivateMsg } from "./connection.js";
import { collapseDoubleNewlines, markdownToPlain } from "./markdown.js";
import { resolveTargetForReply } from "./reply-context.js";
import type { OneBotAccountConfig } from "./types.js";

type OneBotConfigGetter = () => OneBotAccountConfig | null;

export interface OneBotSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

function parseTarget(raw: string): { type: "user" | "group"; id: number } | null {
  const value = raw.replace(/^(onebot|qq|lagrange):/i, "").trim();
  if (!value) return null;
  if (value.startsWith("group:")) {
    const id = Number(value.slice(6));
    return Number.isFinite(id) ? { type: "group", id } : null;
  }
  const numeric = value.replace(/^user:/, "");
  const id = Number(numeric);
  if (!Number.isFinite(id)) return null;
  if (value.startsWith("user:")) {
    return { type: "user", id };
  }
  return { type: id > 100000000 ? "user" : "group", id };
}

function normalizeText(text: string, cfg?: any): string {
  const renderPlain = getRenderMarkdownToPlain(cfg);
  const next = renderPlain ? markdownToPlain(text) : text.trim();
  return collapseDoubleNewlines(next);
}

export async function sendTextMessage(to: string, text: string, getConfig?: OneBotConfigGetter, cfg?: any): Promise<OneBotSendResult> {
  const resolved = resolveTargetForReply(to);
  const target = parseTarget(resolved);
  if (!target) {
    return { ok: false, error: `Invalid target: ${to}` };
  }
  const normalizedText = normalizeText(text, cfg);
  if (!normalizedText) {
    return { ok: false, error: "No text provided" };
  }
  try {
    const messageId = target.type === "group"
      ? await sendGroupMsg(target.id, normalizedText, getConfig)
      : await sendPrivateMsg(target.id, normalizedText, getConfig);
    return { ok: true, messageId: messageId != null ? String(messageId) : "" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendMediaMessage(to: string, mediaUrl: string, text?: string, getConfig?: OneBotConfigGetter, cfg?: any): Promise<OneBotSendResult> {
  const resolved = resolveTargetForReply(to);
  const target = parseTarget(resolved);
  if (!target) {
    return { ok: false, error: `Invalid target: ${to}` };
  }
  if (!mediaUrl?.trim()) {
    return { ok: false, error: "No mediaUrl provided" };
  }
  try {
    let messageId: number | undefined;
    const normalizedText = text?.trim() ? normalizeText(text, cfg) : "";
    if (normalizedText) {
      messageId = target.type === "group"
        ? await sendGroupMsg(target.id, normalizedText, getConfig)
        : await sendPrivateMsg(target.id, normalizedText, getConfig);
    }
    const mediaMessageId = target.type === "group"
      ? await sendGroupImage(target.id, mediaUrl, getConfig)
      : await sendPrivateImage(target.id, mediaUrl, getConfig);
    return { ok: true, messageId: String(mediaMessageId ?? messageId ?? "") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}


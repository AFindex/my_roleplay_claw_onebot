import { getRenderMarkdownToPlain } from "./config.js";
import { sendForwardMsg, sendGroupMsg, sendPoke, sendPrivateMsg } from "./connection.js";
import { collapseDoubleNewlines, markdownToPlain } from "./markdown.js";
import { buildOneBotCqMessageFromSegments, buildOneBotSegmentsFromRichParts, parseOneBotRichText, resolveOneBotPokeTarget, type OneBotRichTextPart } from "./onebot-rich-text.js";
import { resolveTargetForReply } from "./reply-context.js";
import type { OneBotMessageSegment } from "./types.js";
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

function buildOutboundSegments(parts: OneBotRichTextPart[], targetType: "user" | "group") {
  const segments = buildOneBotSegmentsFromRichParts(parts, {
    isGroup: targetType === "group"
  });
  return segments;
}

function buildOutboundTextPayload(parts: OneBotRichTextPart[], targetType: "user" | "group") {
  const segments = buildOutboundSegments(parts, targetType);
  const cqMessage = targetType === "group"
    ? buildOneBotCqMessageFromSegments(segments)
    : null;
  if (cqMessage) {
    return cqMessage;
  }
  return segments.length === 1 && segments[0]?.type === "text"
    ? String(segments[0].data?.text ?? "")
    : segments;
}

async function deliverOutboundPayload(target: { type: "group" | "user"; id: number }, payload: string | any[], getConfig?: OneBotConfigGetter): Promise<number | undefined> {
  return target.type === "group"
    ? sendGroupMsg(target.id, payload, getConfig)
    : sendPrivateMsg(target.id, payload, getConfig);
}

async function sendPokeWithFallback(params: {
  getConfig?: OneBotConfigGetter;
  target: { type: "group" | "user"; id: number };
  targetRef: string;
}): Promise<void> {
  const resolvedTarget = resolveOneBotPokeTarget(params.targetRef);
  if (!resolvedTarget || !/^\d+$/.test(resolvedTarget)) {
    await deliverOutboundPayload(params.target, "[戳一戳]", params.getConfig);
    return;
  }

  try {
    await sendPoke({
      getConfig: params.getConfig,
      groupId: params.target.type === "group" ? params.target.id : undefined,
      userId: Number(resolvedTarget)
    });
  } catch {
    await deliverOutboundPayload(params.target, "[戳一戳]", params.getConfig);
  }
}

function buildForwardNodes(messageIds: string[]): OneBotMessageSegment[] {
  return messageIds.map((messageId) => ({
    type: "node",
    data: { id: messageId }
  }));
}

async function sendForwardWithFallback(params: {
  getConfig?: OneBotConfigGetter;
  messageIds: string[];
  target: { type: "group" | "user"; id: number };
}): Promise<number | undefined> {
  if (params.messageIds.length === 0) {
    return deliverOutboundPayload(params.target, "[合并转发]", params.getConfig);
  }

  try {
    const result = await sendForwardMsg({
      getConfig: params.getConfig,
      groupId: params.target.type === "group" ? params.target.id : undefined,
      userId: params.target.type === "user" ? params.target.id : undefined,
      messages: buildForwardNodes(params.messageIds)
    });
    return result.messageId;
  } catch {
    return deliverOutboundPayload(params.target, "[合并转发]", params.getConfig);
  }
}

async function sendRichTextParts(target: { type: "group" | "user"; id: number }, parts: OneBotRichTextPart[], getConfig?: OneBotConfigGetter): Promise<number | undefined> {
  let lastMessageId: number | undefined;
  let buffer: OneBotRichTextPart[] = [];

  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) {
      return;
    }
    const outbound = buildOutboundTextPayload(buffer, target.type);
    lastMessageId = await deliverOutboundPayload(target, outbound, getConfig);
    buffer = [];
  };

  for (const part of parts) {
    if (part.type === "poke") {
      await flushBuffer();
      await sendPokeWithFallback({
        getConfig,
        target,
        targetRef: part.target
      });
      continue;
    }
    if (part.type === "forward") {
      await flushBuffer();
      lastMessageId = await sendForwardWithFallback({
        getConfig,
        messageIds: part.messageIds,
        target
      });
      continue;
    }
    buffer.push(part);
  }

  await flushBuffer();
  return lastMessageId;
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
    const messageId = await sendRichTextParts(target, parseOneBotRichText(normalizedText), getConfig);
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
    const normalizedText = text?.trim() ? normalizeText(text, cfg) : "";
    const parts = [
      ...parseOneBotRichText(normalizedText),
      { type: "image", mediaUrl: mediaUrl.trim() } satisfies OneBotRichTextPart
    ];
    const messageId = await sendRichTextParts(target, parts, getConfig);
    return { ok: true, messageId: String(messageId ?? "") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

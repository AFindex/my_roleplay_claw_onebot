import { getOneBotConfig, getRenderMarkdownToPlain } from "../config.js";
import { isKnownNapCatGroupSendBlockedError, sendForwardMsg, sendGroupMsg, sendPoke, sendPrivateMsg } from "../connection.js";
import { collapseDoubleNewlines, markdownToPlain } from "../markdown.js";
import { buildOneBotCqMessageFromSegments, parseOneBotRichText, resolveOneBotMentionTarget, resolveOneBotPokeTarget } from "../onebot-rich-text.js";
import { withReplyTarget } from "../reply-context.js";
import type { OneBotMessageSegment } from "../types.js";
import type { ReplyTarget } from "./process-inbound-shared.js";

export type ReplyPayload = { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;

type CapturedReplyPart =
  | { type: "dice" }
  | { type: "face"; id: string }
  | { type: "file"; fileUrl: string; name?: string }
  | { type: "forward"; messageIds: string[] }
  | { type: "record"; mediaUrl: string }
  | { type: "poke"; target: string }
  | { type: "reply"; messageId: string }
  | { type: "rps" }
  | { type: "mention"; target: string }
  | { type: "text"; text: string }
  | { type: "image"; mediaUrl: string };

export type CapturedReply = {
  parts: CapturedReplyPart[];
  textParts: string[];
  mediaUrls: string[];
};

function previewTextForLog(text: string, maxChars = 96): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "（空）";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatNestedError(error: unknown): string {
  if (error instanceof AggregateError) {
    const childMessages = Array.from(error.errors ?? []).map((item) => formatNestedError(item)).filter(Boolean);
    if (childMessages.length > 0) {
      return `AggregateError: ${childMessages.join(" | ")}`;
    }
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function normalizeReplyText(api: any, text: string): string {
  let finalText = text.trim();
  if (finalText && getRenderMarkdownToPlain(api)) {
    finalText = markdownToPlain(finalText);
  }
  return finalText ? collapseDoubleNewlines(finalText) : "";
}

function extractOneBotRichParts(text: string): CapturedReplyPart[] {
  return parseOneBotRichText(text).map((part) => {
    if (part.type === "image") {
      return { type: "image", mediaUrl: part.mediaUrl };
    }
    if (part.type === "record") {
      return { type: "record", mediaUrl: part.mediaUrl };
    }
    if (part.type === "file") {
      return { type: "file", fileUrl: part.fileUrl, name: part.name };
    }
    if (part.type === "forward") {
      return { type: "forward", messageIds: part.messageIds };
    }
    if (part.type === "poke") {
      return { type: "poke", target: part.target };
    }
    if (part.type === "reply") {
      return { type: "reply", messageId: part.messageId };
    }
    if (part.type === "face") {
      return { type: "face", id: part.id };
    }
    if (part.type === "rps") {
      return { type: "rps" };
    }
    if (part.type === "dice") {
      return { type: "dice" };
    }
    if (part.type === "mention") {
      return { type: "mention", target: part.target };
    }
    return { type: "text", text: part.text };
  });
}

function pushCapturedTextPart(api: any, capture: CapturedReply, text: string): void {
  const trimmedText = text.trim();
  if (!trimmedText || trimmedText === "NO_REPLY" || trimmedText.endsWith("NO_REPLY")) {
    return;
  }

  const normalizedText = normalizeReplyText(api, trimmedText);
  if (!normalizedText) {
    return;
  }

  capture.textParts.push(normalizedText);
  const lastPart = capture.parts[capture.parts.length - 1];
  if (lastPart?.type === "text") {
    lastPart.text = collapseDoubleNewlines(`${lastPart.text}\n\n${normalizedText}`).trim();
    return;
  }

  capture.parts.push({ type: "text", text: normalizedText });
}

function pushCapturedMediaUrl(capture: CapturedReply, mediaUrl: string): void {
  const normalizedMediaUrl = mediaUrl.trim();
  if (!normalizedMediaUrl || capture.mediaUrls.includes(normalizedMediaUrl)) {
    return;
  }

  capture.mediaUrls.push(normalizedMediaUrl);
  capture.parts.push({ type: "image", mediaUrl: normalizedMediaUrl });
}

function pushCapturedRecordUrl(capture: CapturedReply, mediaUrl: string): void {
  const normalizedMediaUrl = mediaUrl.trim();
  if (!normalizedMediaUrl) {
    return;
  }
  capture.parts.push({ type: "record", mediaUrl: normalizedMediaUrl });
}

function pushCapturedFile(capture: CapturedReply, fileUrl: string, name?: string): void {
  const normalizedFileUrl = fileUrl.trim();
  if (!normalizedFileUrl) {
    return;
  }
  capture.parts.push({
    type: "file",
    fileUrl: normalizedFileUrl,
    name: typeof name === "string" && name.trim() ? name.trim() : undefined
  });
}

function pushCapturedForward(capture: CapturedReply, messageIds: string[]): void {
  const normalizedIds = Array.from(new Set(messageIds.map((item) => item.trim()).filter((item) => /^\d+$/.test(item))));
  if (normalizedIds.length === 0) {
    return;
  }
  capture.parts.push({ type: "forward", messageIds: normalizedIds });
}

function pushCapturedReplyReference(capture: CapturedReply, messageId: string): void {
  const normalizedId = messageId.trim();
  if (!normalizedId) {
    return;
  }
  capture.parts.push({ type: "reply", messageId: normalizedId });
}

function pushCapturedPoke(capture: CapturedReply, target: string): void {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return;
  }
  capture.parts.push({ type: "poke", target: normalizedTarget });
}

function pushCapturedMention(capture: CapturedReply, target: string): void {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return;
  }
  capture.parts.push({ type: "mention", target: normalizedTarget });
}

function pushCapturedFace(capture: CapturedReply, id: string): void {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return;
  }
  capture.parts.push({ type: "face", id: normalizedId });
}

function pushCapturedAction(capture: CapturedReply, type: "rps" | "dice"): void {
  capture.parts.push({ type });
}

function buildCapturedReplySegments(captured: CapturedReply, target: ReplyTarget): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];

  for (const part of captured.parts) {
    if (part.type === "image") {
      segments.push({ type: "image", data: { file: part.mediaUrl } });
      continue;
    }

    if (part.type === "record") {
      segments.push({ type: "record", data: { file: part.mediaUrl } });
      continue;
    }

    if (part.type === "file") {
      segments.push({
        type: "file",
        data: {
          file: part.fileUrl,
          name: part.name
        }
      });
      continue;
    }

    if (part.type === "reply") {
      segments.push({ type: "reply", data: { id: part.messageId } });
      continue;
    }

    if (part.type === "forward") {
      segments.push({ type: "text", data: { text: "[合并转发]" } });
      continue;
    }

    if (part.type === "poke") {
      segments.push({ type: "text", data: { text: "[戳一戳]" } });
      continue;
    }

    if (part.type === "mention") {
      const mentionTarget = target.isGroup
        ? resolveOneBotMentionTarget(part.target, target.userId)
        : null;
      if (mentionTarget) {
        segments.push({ type: "at", data: { qq: mentionTarget } });
      } else {
        segments.push({ type: "text", data: { text: `@${part.target}` } });
      }
      continue;
    }

    if (part.type === "face") {
      segments.push({ type: "face", data: { id: part.id } });
      continue;
    }

    if (part.type === "rps") {
      segments.push({ type: "rps" });
      continue;
    }

    if (part.type === "dice") {
      segments.push({ type: "dice" });
      continue;
    }

    const text = part.text.trim();
    if (text) {
      segments.push({ type: "text", data: { text } });
    }
  }

  return segments;
}

function appendCapturedReplyState(target: CapturedReply, source: CapturedReply): void {
  for (const part of source.parts) {
    if (part.type === "image") {
      const mediaUrl = part.mediaUrl.trim();
      if (mediaUrl && !target.mediaUrls.includes(mediaUrl)) {
        target.mediaUrls.push(mediaUrl);
      }
      target.parts.push({ type: "image", mediaUrl: part.mediaUrl });
      continue;
    }

    if (part.type === "mention") {
      target.parts.push({ type: "mention", target: part.target });
      continue;
    }

    if (part.type === "record") {
      target.parts.push({ type: "record", mediaUrl: part.mediaUrl });
      continue;
    }

    if (part.type === "file") {
      target.parts.push({ type: "file", fileUrl: part.fileUrl, name: part.name });
      continue;
    }

    if (part.type === "forward") {
      target.parts.push({ type: "forward", messageIds: [...part.messageIds] });
      continue;
    }

    if (part.type === "reply") {
      target.parts.push({ type: "reply", messageId: part.messageId });
      continue;
    }

    if (part.type === "poke") {
      target.parts.push({ type: "poke", target: part.target });
      continue;
    }

    if (part.type === "face") {
      target.parts.push({ type: "face", id: part.id });
      continue;
    }

    if (part.type === "rps" || part.type === "dice") {
      target.parts.push({ type: part.type });
      continue;
    }

    target.parts.push({ type: "text", text: part.text });
    if (part.text.trim()) {
      target.textParts.push(part.text.trim());
    }
  }
}

function previewReplyPayloadForLog(payload: ReplyPayload): string {
  if (typeof payload === "string") {
    return `kind=string text=${JSON.stringify(previewTextForLog(payload, 160))}`;
  }

  const parts = [
    typeof payload.text === "string" ? `text=${JSON.stringify(previewTextForLog(payload.text, 120))}` : "",
    typeof payload.body === "string" ? `body=${JSON.stringify(previewTextForLog(payload.body, 120))}` : "",
    typeof payload.mediaUrl === "string" ? `mediaUrl=${JSON.stringify(previewTextForLog(payload.mediaUrl, 120))}` : "",
    Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0 ? `mediaUrls=${payload.mediaUrls.length}` : ""
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "kind=object empty=true";
}

function previewCapturedReplyForLog(captured: CapturedReply): string {
  const text = buildCapturedReplyText(captured);
  const mentionCount = captured.parts.filter((part) => part.type === "mention").length;
  const mediaCount = captured.mediaUrls.length;
  const actionCount = captured.parts.filter((part) => part.type === "face" || part.type === "rps" || part.type === "dice" || part.type === "record" || part.type === "file" || part.type === "forward" || part.type === "reply" || part.type === "poke").length;
  const parts = [
    text ? `text=${JSON.stringify(previewTextForLog(text, 160))}` : "",
    mentionCount > 0 ? `mentions=${mentionCount}` : "",
    actionCount > 0 ? `actions=${actionCount}` : "",
    mediaCount > 0 ? `media=${mediaCount}` : ""
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "empty=true";
}

function previewOutboundMessageForLog(outbound: string | OneBotMessageSegment[]): string {
  if (typeof outbound === "string") {
    return `mode=string text=${JSON.stringify(previewTextForLog(outbound, 180))}`;
  }

  const summarized = outbound.slice(0, 8).map((segment) => {
    if (segment.type === "text") {
      return { type: "text", text: previewTextForLog(String(segment.data?.text ?? ""), 80) };
    }
    if (segment.type === "at") {
      return { type: "at", qq: String(segment.data?.qq ?? "") };
    }
    return { type: segment.type, data: segment.data ?? {} };
  });
  return `mode=segments value=${JSON.stringify(summarized)}`;
}

function isMentionOnlyCapturedReply(captured: CapturedReply): boolean {
  return captured.parts.length > 0 && captured.parts.every((part) => part.type === "mention");
}

export function buildAsyncFailureText(error: unknown, prefix = "刚才那个异步任务失败了"): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${reason.slice(0, 120)}`;
}

export function buildCapturedReplyText(captured: CapturedReply): string {
  return collapseDoubleNewlines(captured.parts.map((part) => {
    if (part.type === "text") {
      return part.text;
    }
    if (part.type === "mention") {
      return `@${part.target}`;
    }
    if (part.type === "record") {
      return "[语音]";
    }
    if (part.type === "file") {
      return part.name?.trim() ? `[文件:${part.name.trim()}]` : "[文件]";
    }
    if (part.type === "forward") {
      return "[合并转发]";
    }
    if (part.type === "reply") {
      return `[回复:${part.messageId}]`;
    }
    if (part.type === "poke") {
      return "[戳一戳]";
    }
    if (part.type === "face") {
      return `[表情:${part.id}]`;
    }
    if (part.type === "rps") {
      return "[猜拳]";
    }
    if (part.type === "dice") {
      return "[骰子]";
    }
    return "";
  }).join("")).trim();
}

export function buildCapturedReplyMirrorText(captured: CapturedReply): string | undefined {
  const finalText = buildCapturedReplyText(captured);
  if (finalText) {
    return finalText;
  }
  if (captured.mediaUrls.length > 0) {
    return captured.mediaUrls.length > 1 ? `（发送了 ${captured.mediaUrls.length} 个媒体）` : "（发送了 1 个媒体）";
  }
  return undefined;
}

export function appendCapturedReply(api: any, capture: CapturedReply, payload: ReplyPayload): void {
  const parsed = payload as { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;
  const rawText = typeof parsed === "string" ? parsed : parsed?.text ?? parsed?.body ?? "";

  for (const part of extractOneBotRichParts(rawText)) {
    if (part.type === "image") {
      pushCapturedMediaUrl(capture, part.mediaUrl);
      continue;
    }
    if (part.type === "record") {
      pushCapturedRecordUrl(capture, part.mediaUrl);
      continue;
    }
    if (part.type === "file") {
      pushCapturedFile(capture, part.fileUrl, part.name);
      continue;
    }
    if (part.type === "forward") {
      pushCapturedForward(capture, part.messageIds);
      continue;
    }
    if (part.type === "reply") {
      pushCapturedReplyReference(capture, part.messageId);
      continue;
    }
    if (part.type === "poke") {
      pushCapturedPoke(capture, part.target);
      continue;
    }
    if (part.type === "face") {
      pushCapturedFace(capture, part.id);
      continue;
    }
    if (part.type === "rps" || part.type === "dice") {
      pushCapturedAction(capture, part.type);
      continue;
    }
    if (part.type === "mention") {
      pushCapturedMention(capture, part.target);
      continue;
    }
    pushCapturedTextPart(api, capture, part.text);
  }

  if (typeof parsed !== "string") {
    for (const mediaUrl of [parsed?.mediaUrl, ...(parsed?.mediaUrls ?? [])]) {
      if (typeof mediaUrl === "string") {
        pushCapturedMediaUrl(capture, mediaUrl);
      }
    }
  }
}

async function sendBufferedReplyParts(api: any, target: ReplyTarget, buffer: CapturedReply): Promise<void> {
  const message = buildCapturedReplySegments(buffer, target);
  if (message.length === 0) {
    return;
  }

  const cqMessage = target.isGroup
    ? buildOneBotCqMessageFromSegments(message)
    : null;
  const outbound = cqMessage
    ?? (message.length === 1 && message[0]?.type === "text"
      ? String(message[0].data?.text ?? "")
      : message);
  api.logger?.info?.(`[onebot] outbound reply target=${target.replyTarget} captured=${previewCapturedReplyForLog(buffer)} ${previewOutboundMessageForLog(outbound)}`);
  if (target.isGroup && target.groupId) {
    await sendGroupMsg(target.groupId, outbound, () => getOneBotConfig(api));
    return;
  }
  await sendPrivateMsg(target.userId, outbound, () => getOneBotConfig(api));
}

async function sendCapturedPoke(api: any, target: ReplyTarget, pokeTarget: string): Promise<void> {
  const resolvedTarget = resolveOneBotPokeTarget(pokeTarget, target.userId);
  if (!resolvedTarget || !/^\d+$/.test(resolvedTarget)) {
    await sendBufferedReplyParts(api, target, {
      mediaUrls: [],
      parts: [{ type: "text", text: "[戳一戳]" }],
      textParts: ["[戳一戳]"]
    });
    return;
  }

  api.logger?.info?.(`[onebot] outbound poke target=${target.replyTarget} user=${resolvedTarget}`);
  try {
    await sendPoke({
      getConfig: () => getOneBotConfig(api),
      groupId: target.groupId,
      userId: Number(resolvedTarget)
    });
  } catch {
    await sendBufferedReplyParts(api, target, {
      mediaUrls: [],
      parts: [{ type: "text", text: "[戳一戳]" }],
      textParts: ["[戳一戳]"]
    });
  }
}

function buildForwardNodes(messageIds: string[]): OneBotMessageSegment[] {
  return messageIds.map((messageId) => ({
    type: "node",
    data: { id: messageId }
  }));
}

async function sendCapturedForward(api: any, target: ReplyTarget, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) {
    await sendBufferedReplyParts(api, target, {
      mediaUrls: [],
      parts: [{ type: "text", text: "[合并转发]" }],
      textParts: ["[合并转发]"]
    });
    return;
  }

  try {
    await sendForwardMsg({
      getConfig: () => getOneBotConfig(api),
      groupId: target.groupId,
      userId: target.isGroup ? undefined : target.userId,
      messages: buildForwardNodes(messageIds)
    });
  } catch {
    await sendBufferedReplyParts(api, target, {
      mediaUrls: [],
      parts: [{ type: "text", text: "[合并转发]" }],
      textParts: ["[合并转发]"]
    });
  }
}

export async function deliverCapturedReply(api: any, target: ReplyTarget, captured: CapturedReply): Promise<void> {
  const buffer: CapturedReply = { parts: [], textParts: [], mediaUrls: [] };

  const flushBuffer = async (): Promise<void> => {
    if (buffer.parts.length === 0) {
      return;
    }
    await sendBufferedReplyParts(api, target, buffer);
    buffer.parts = [];
    buffer.textParts = [];
    buffer.mediaUrls = [];
  };

  for (const part of captured.parts) {
    if (part.type === "poke") {
      await flushBuffer();
      await sendCapturedPoke(api, target, part.target);
      continue;
    }
    if (part.type === "forward") {
      await flushBuffer();
      await sendCapturedForward(api, target, part.messageIds);
      continue;
    }
    appendCapturedReplyState(buffer, {
      mediaUrls: part.type === "image" ? [part.mediaUrl] : [],
      parts: [part],
      textParts: part.type === "text" && part.text.trim() ? [part.text.trim()] : []
    });
  }

  await flushBuffer();
}

export async function sendFailureMessage(api: any, target: ReplyTarget, error: unknown, prefix = "处理失败"): Promise<void> {
  if (target.isGroup && target.groupId && isKnownNapCatGroupSendBlockedError(error)) {
    api.logger?.warn?.(`[onebot] skip failure message for blocked group target=${target.replyTarget}`);
    return;
  }

  const reason = error instanceof Error ? error.message : String(error);
  const failText = `${prefix}: ${reason.slice(0, 120)}`;
  if (target.isGroup && target.groupId) {
    await sendGroupMsg(target.groupId, failText, () => getOneBotConfig(api)).catch(() => undefined);
    return;
  }
  await sendPrivateMsg(target.userId, failText, () => getOneBotConfig(api)).catch(() => undefined);
}

export async function dispatchReply(api: any, runtime: any, params: {
  ctx: Record<string, unknown>;
  target: ReplyTarget;
}): Promise<void> {
  await withReplyTarget(params.target.replyTarget, async () => {
    const pendingMention: CapturedReply = { parts: [], textParts: [], mediaUrls: [] };
    let hasPendingMention = false;

    const flushPendingMention = async (): Promise<void> => {
      if (!hasPendingMention || pendingMention.parts.length === 0) {
        return;
      }
      api.logger?.info?.(`[onebot] reply payload flush pending target=${params.target.replyTarget} pending=${previewCapturedReplyForLog(pendingMention)}`);
      await deliverCapturedReply(api, params.target, pendingMention);
      pendingMention.parts = [];
      pendingMention.textParts = [];
      pendingMention.mediaUrls = [];
      hasPendingMention = false;
    };

    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: params.ctx,
      cfg: api.config,
      dispatcherOptions: {
        deliver: async (payload: unknown) => {
          api.logger?.info?.(`[onebot] reply payload target=${params.target.replyTarget} ${previewReplyPayloadForLog(payload as ReplyPayload)}`);
          const captured: CapturedReply = { parts: [], textParts: [], mediaUrls: [] };
          appendCapturedReply(api, captured, payload as ReplyPayload);
          api.logger?.info?.(`[onebot] reply payload parsed target=${params.target.replyTarget} ${previewCapturedReplyForLog(captured)}`);
          if (captured.parts.length === 0) {
            api.logger?.info?.(`[onebot] reply payload skipped-empty target=${params.target.replyTarget}`);
            return;
          }

          if (isMentionOnlyCapturedReply(captured)) {
            appendCapturedReplyState(pendingMention, captured);
            hasPendingMention = true;
            api.logger?.info?.(`[onebot] reply payload buffered-mention target=${params.target.replyTarget} pending=${previewCapturedReplyForLog(pendingMention)}`);
            return;
          }

          if (hasPendingMention) {
            appendCapturedReplyState(pendingMention, captured);
            api.logger?.info?.(`[onebot] reply payload merged-with-pending target=${params.target.replyTarget} merged=${previewCapturedReplyForLog(pendingMention)}`);
            await deliverCapturedReply(api, params.target, pendingMention);
            pendingMention.parts = [];
            pendingMention.textParts = [];
            pendingMention.mediaUrls = [];
            hasPendingMention = false;
            return;
          }

          await deliverCapturedReply(api, params.target, captured);
        },
        onError: async (error: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[onebot] ${info?.kind ?? "reply"} failed: ${formatNestedError(error)}`);
        }
      },
      replyOptions: {
        disableBlockStreaming: false
      }
    });

    await flushPendingMention();
  });
}

export async function captureReply(api: any, runtime: any, ctx: Record<string, unknown>): Promise<CapturedReply> {
  const captured: CapturedReply = {
    parts: [],
    textParts: [],
    mediaUrls: []
  };

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg: api.config,
    dispatcherOptions: {
      deliver: async (payload: unknown) => {
        appendCapturedReply(api, captured, payload as ReplyPayload);
      },
      onError: async (error: unknown, info: { kind?: string }) => {
        api.logger?.error?.(`[onebot] ${info?.kind ?? "reply"} failed: ${formatNestedError(error)}`);
      }
    },
    replyOptions: {
      disableBlockStreaming: true
    }
  });

  return captured;
}

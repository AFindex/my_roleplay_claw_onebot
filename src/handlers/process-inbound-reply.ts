import { getOneBotConfig, getRenderMarkdownToPlain } from "../config.js";
import { isKnownNapCatGroupSendBlockedError, sendGroupMsg, sendPrivateMsg } from "../connection.js";
import { collapseDoubleNewlines, markdownToPlain } from "../markdown.js";
import { buildOneBotCqMessageFromSegments, parseOneBotRichText, resolveOneBotMentionTarget } from "../onebot-rich-text.js";
import { withReplyTarget } from "../reply-context.js";
import type { OneBotMessageSegment } from "../types.js";
import type { ReplyTarget } from "./process-inbound-shared.js";

export type ReplyPayload = { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;

type CapturedReplyPart =
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

function pushCapturedMention(capture: CapturedReply, target: string): void {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return;
  }
  capture.parts.push({ type: "mention", target: normalizedTarget });
}

function buildCapturedReplySegments(captured: CapturedReply, target: ReplyTarget): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];

  for (const part of captured.parts) {
    if (part.type === "image") {
      segments.push({ type: "image", data: { file: part.mediaUrl } });
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
  const parts = [
    text ? `text=${JSON.stringify(previewTextForLog(text, 160))}` : "",
    mentionCount > 0 ? `mentions=${mentionCount}` : "",
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

export async function deliverCapturedReply(api: any, target: ReplyTarget, captured: CapturedReply): Promise<void> {
  const message = buildCapturedReplySegments(captured, target);
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

  api.logger?.info?.(`[onebot] outbound reply target=${target.replyTarget} captured=${previewCapturedReplyForLog(captured)} ${previewOutboundMessageForLog(outbound)}`);

  if (target.isGroup && target.groupId) {
    await sendGroupMsg(target.groupId, outbound, () => getOneBotConfig(api));
    return;
  }

  await sendPrivateMsg(target.userId, outbound, () => getOneBotConfig(api));
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
        disableBlockStreaming: true
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

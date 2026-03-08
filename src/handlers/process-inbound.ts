import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { buildAgentPersonaContext } from "../agent-persona.js";
import { generateAsyncAckWithAi } from "../async-ack-ai.js";
import { matchAsyncTaskRecordWithAi } from "../async-record-search-ai.js";
import {
  buildAsyncTaskContextBlock,
  createAsyncTaskRecord,
  getAsyncTaskRecordById,
  listAsyncTaskRecordsForSession,
  updateAsyncTaskRecord,
  upsertAsyncTaskRecord,
  type AsyncTaskRecord,
  type AsyncTaskTriggerMeta
} from "../async-task-records.js";
import { getAsyncReplyConfig, getGroupIncreaseConfig, getOneBotConfig, getRenderMarkdownToPlain, getRequireMention, type OneBotAsyncReplyConfig } from "../config.js";
import { classifyAsyncIntentWithAi } from "../async-intent-ai.js";
import { getImage, getMsg, sendGroupImage, sendGroupMsg, sendPrivateImage, sendPrivateMsg, stageInboundImageToLocalPath } from "../connection.js";
import { collapseDoubleNewlines, markdownToPlain } from "../markdown.js";
import { appendSessionAssistantMessage, appendSessionUserMessage } from "../session-transcript-mirror.js";
import { getImageSegments, getRawText, getReplyMessageId, getTextFromMessageContent, getTextFromSegments, isMentioned } from "../message.js";
import { clearActiveReplyTarget, setActiveReplyTarget } from "../reply-context.js";
import type { OneBotMessage } from "../types.js";
import { handleGroupIncrease } from "./group-increase.js";

type ReplyPayload = { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;

type ReplyTarget = {
  chatType: "group" | "direct";
  groupId?: number;
  isGroup: boolean;
  replyTarget: string;
  senderLabel: string;
  userId: number;
};

type InboundImageAttachment = {
  mime: string;
  path: string;
};

type CapturedReply = {
  textParts: string[];
  mediaUrls: string[];
};

type AsyncTrigger = {
  confidence?: number;
  keyword?: string;
  mode: "ai" | "explicit" | "keyword";
  reason?: string;
  taskMessageText: string;
};

const ASYNC_TASK_CONTEXT_CHAR_LIMIT = 6000;
const ASYNC_TASK_CONTEXT_MESSAGES = 20;

const ASYNC_COMMAND_PATTERNS = [
  /^\/async(?:[\s\u3000]+|$)/i,
  /^\/异步(?:[\s\u3000]+|$)/i,
  /^异步(?:[:：\s\u3000]+|$)/i
];

function parseExplicitAsyncCommand(text: string): { matched: boolean; task: string } | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  for (const pattern of ASYNC_COMMAND_PATTERNS) {
    if (!pattern.test(trimmed)) {
      continue;
    }
    return {
      matched: true,
      task: trimmed.replace(pattern, "").trim()
    };
  }

  return null;
}

function spliceTaskIntoMessage(fullMessageText: string, triggerText: string, task: string): string {
  const full = fullMessageText.trim();
  const current = triggerText.trim();
  if (!full || full === current || !current) {
    return task;
  }
  if (!full.endsWith(current)) {
    return task;
  }

  const prefix = full.slice(0, full.length - current.length).trimEnd();
  return prefix ? `${prefix}\n${task}` : task;
}

function findMatchedKeyword(text: string, keywords: string[]): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const keyword of keywords) {
    const candidate = keyword.trim().toLowerCase();
    if (candidate && normalized.includes(candidate)) {
      return keyword;
    }
  }

  return null;
}

function previewTextForLog(text: string, maxChars = 96): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '（空）';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildImagePlaceholder(count: number): string {
  return count > 1 ? `<media:image> (${count} images)` : "<media:image>";
}

function pickFirstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function looksLikeDirectImageReference(value: string): boolean {
  return value.startsWith("base64://") || /^https?:\/\//i.test(value) || value.startsWith("file://") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function inferImageMime(value?: string): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) {
    return normalized;
  }
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".bmp")) return "image/bmp";
  if (normalized.endsWith(".tif") || normalized.endsWith(".tiff")) return "image/tiff";
  return "image/*";
}

async function resolveInboundImageAttachments(api: any, msg: OneBotMessage, getConfig: () => ReturnType<typeof getOneBotConfig>): Promise<InboundImageAttachment[]> {
  const imageSegments = getImageSegments(msg);
  if (imageSegments.length === 0) {
    return [];
  }

  const attachments: InboundImageAttachment[] = [];
  const seen = new Set<string>();
  for (const segment of imageSegments) {
    const data = segment.data ?? {};
    let source = pickFirstString(data.url, data.src, data.path, data.local_path);
    const fileRef = pickFirstString(data.file, data.file_id, data.image);

    if (!source && fileRef) {
      if (looksLikeDirectImageReference(fileRef)) {
        source = fileRef;
      } else {
        const resolved = await getImage(fileRef, getConfig);
        source = pickFirstString(resolved?.file, resolved?.url);
      }
    }

    if (!source) {
      api.logger?.warn?.(`[onebot] inbound image skipped: missing usable source (${JSON.stringify(data)})`);
      continue;
    }

    try {
      const stagedPath = await stageInboundImageToLocalPath(source);
      if (seen.has(stagedPath)) {
        continue;
      }
      seen.add(stagedPath);
      attachments.push({
        mime: inferImageMime(pickFirstString(data.mimetype, data.mime, data.contentType, source)),
        path: stagedPath,
      });
    } catch (error) {
      api.logger?.warn?.(`[onebot] inbound image staging failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return attachments;
}

function formatJudgeMeta(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ")
}

async function resolveAsyncTrigger(params: {
  asyncConfig: OneBotAsyncReplyConfig;
  chatType: "group" | "direct";
  fullMessageText: string;
  logger?: { info?: (value: string) => void; warn?: (value: string) => void };
  triggerText: string;
}): Promise<AsyncTrigger | null> {
  const preview = previewTextForLog(params.triggerText || params.fullMessageText);
  const explicit = parseExplicitAsyncCommand(params.triggerText);
  if (explicit) {
    params.logger?.info?.(`[onebot] async judge matched explicit preview=${JSON.stringify(preview)}`);
    return {
      mode: "explicit",
      taskMessageText: spliceTaskIntoMessage(params.fullMessageText, params.triggerText, explicit.task)
    };
  }

  if (!params.asyncConfig.enabled) {
    params.logger?.info?.(`[onebot] async judge skipped auto-detect disabled preview=${JSON.stringify(preview)}`);
    return null;
  }

  if (params.asyncConfig.ai.enabled) {
    params.logger?.info?.(`[onebot] async judge ai start chatType=${params.chatType} preview=${JSON.stringify(preview)}`);
    const aiDecision = await classifyAsyncIntentWithAi({
      apiConfig: params.asyncConfig.ai,
      chatType: params.chatType,
      fullMessageText: params.fullMessageText,
      logger: params.logger,
      triggerText: params.triggerText
    });

    if (aiDecision) {
      params.logger?.info?.(`[onebot] async judge ai result ${formatJudgeMeta([
        `async=${aiDecision.shouldAsync}`,
        typeof aiDecision.confidence === "number" ? `confidence=${aiDecision.confidence.toFixed(2)}` : "",
        aiDecision.reason ? `reason=${aiDecision.reason}` : "",
        `preview=${JSON.stringify(preview)}`
      ])}`);
    } else {
      params.logger?.info?.(`[onebot] async judge ai result unavailable fallbackToKeywords=${params.asyncConfig.ai.fallbackToKeywords} preview=${JSON.stringify(preview)}`);
    }

    if (aiDecision?.shouldAsync) {
      return {
        confidence: aiDecision.confidence,
        mode: "ai",
        reason: aiDecision.reason,
        taskMessageText: params.fullMessageText.trim()
      };
    }

    if (aiDecision && !aiDecision.shouldAsync && !params.asyncConfig.ai.fallbackToKeywords) {
      params.logger?.info?.(`[onebot] async judge final async=false source=ai-no-fallback preview=${JSON.stringify(preview)}`);
      return null;
    }
  } else {
    params.logger?.info?.(`[onebot] async judge ai disabled fallbackToKeywords=${params.asyncConfig.ai.fallbackToKeywords} preview=${JSON.stringify(preview)}`);
  }

  const matchedKeyword = findMatchedKeyword(params.triggerText, params.asyncConfig.keywords);
  if (!matchedKeyword) {
    params.logger?.info?.(`[onebot] async judge final async=false source=none preview=${JSON.stringify(preview)}`);
    return null;
  }

  params.logger?.info?.(`[onebot] async judge matched keyword=${matchedKeyword} preview=${JSON.stringify(preview)}`);
  return {
    keyword: matchedKeyword,
    mode: "keyword",
    taskMessageText: params.fullMessageText.trim()
  };
}

function buildOneBotSessionKey(target: ReplyTarget): string {
  return target.isGroup ? `onebot:group:${target.groupId}` : `onebot:user:${target.userId}`;
}

function buildCanonicalSessionKey(agentId: string, target: ReplyTarget): string {
  const normalizedAgentId = agentId.trim().toLowerCase() || "main";
  return `agent:${normalizedAgentId}:${buildOneBotSessionKey(target)}`;
}

function migrateLegacySessionStoreKey(params: {
  canonicalKey: string;
  legacyKey: string;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  storePath: string;
}): void {
  const storePath = params.storePath.trim();
  const canonicalKey = params.canonicalKey.trim().toLowerCase();
  const legacyKey = params.legacyKey.trim().toLowerCase();
  if (!storePath || !canonicalKey || !legacyKey || canonicalKey === legacyKey || !existsSync(storePath)) {
    return;
  }

  try {
    const raw = readFileSync(storePath, "utf8").trim();
    if (!raw) {
      return;
    }

    const store = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(store) || !store || typeof store !== "object") {
      return;
    }

    const legacyEntry = store[legacyKey];
    const canonicalEntry = store[canonicalKey];
    if (!legacyEntry || canonicalEntry) {
      return;
    }

    store[canonicalKey] = legacyEntry;
    delete store[legacyKey];
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    params.logger?.info?.(`[onebot] migrated legacy session key ${legacyKey} -> ${canonicalKey}`);
  } catch (error) {
    params.logger?.warn?.(`[onebot] migrate legacy session key failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildAsyncSessionKey(agentId: string, target: ReplyTarget, kind: "task" | "polish"): string {
  const normalizedAgentId = agentId.trim().toLowerCase() || "main";
  const scope = target.isGroup ? `group:${target.groupId}` : `user:${target.userId}`;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `agent:${normalizedAgentId}:onebot:async-${kind}:${scope}:${Date.now()}:${suffix}`;
}

function buildInboundContext(api: any, runtime: any, params: {
  mediaAttachments?: InboundImageAttachment[];
  messageText: string;
  replyTarget: ReplyTarget;
  sessionKey: string;
  untrustedContext?: string[];
}): Record<string, unknown> {
  const { mediaAttachments = [], messageText, replyTarget, sessionKey, untrustedContext } = params;
  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(api.config) ?? {};
  const body = runtime.channel.reply?.formatInboundEnvelope?.({
    channel: "OneBot",
    from: replyTarget.senderLabel,
    timestamp: Date.now(),
    body: messageText,
    chatType: replyTarget.chatType,
    sender: { id: String(replyTarget.userId), name: replyTarget.senderLabel },
    envelope: envelopeOptions
  }) ?? { content: [{ type: "text", text: messageText }] };

  const mediaPaths = mediaAttachments.length > 0 ? mediaAttachments.map((item) => item.path) : undefined;
  const mediaTypes = mediaAttachments.length > 0 ? mediaAttachments.map((item) => item.mime) : undefined;

  return {
    Body: body,
    RawBody: messageText,
    From: replyTarget.isGroup ? `onebot:group:${replyTarget.groupId}` : `onebot:user:${replyTarget.userId}`,
    To: replyTarget.replyTarget,
    SessionKey: sessionKey,
    AccountId: getOneBotConfig(api)?.accountId ?? "default",
    ChatType: replyTarget.chatType,
    ConversationLabel: replyTarget.replyTarget,
    SenderName: replyTarget.senderLabel,
    SenderId: String(replyTarget.userId),
    Provider: "onebot",
    Surface: "onebot",
    MessageSid: `onebot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    Timestamp: Date.now(),
    MediaPath: mediaPaths?.[0],
    MediaType: mediaTypes?.[0],
    MediaUrl: mediaPaths?.[0],
    MediaPaths: mediaPaths,
    MediaUrls: mediaPaths,
    MediaTypes: mediaTypes,
    OriginatingChannel: "onebot",
    OriginatingTo: replyTarget.replyTarget,
    CommandAuthorized: true,
    DeliveryContext: {
      channel: "onebot",
      to: replyTarget.replyTarget,
      accountId: getOneBotConfig(api)?.accountId ?? "default"
    },
    UntrustedContext: Array.isArray(untrustedContext) && untrustedContext.length > 0 ? untrustedContext : undefined,
    _onebot: {
      userId: replyTarget.userId,
      groupId: replyTarget.groupId,
      isGroup: replyTarget.isGroup
    }
  };
}

async function recordInboundSession(api: any, runtime: any, params: {
  ctx: Record<string, unknown>;
  replyTarget: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  if (!runtime.channel.session?.recordInboundSession) {
    return;
  }

  await runtime.channel.session.recordInboundSession({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    ctx: params.ctx,
    updateLastRoute: {
      sessionKey: params.sessionKey,
      channel: "onebot",
      to: params.replyTarget,
      accountId: getOneBotConfig(api)?.accountId ?? "default"
    },
    onRecordError: (error: unknown) => {
      api.logger?.warn?.(`[onebot] recordInboundSession failed: ${String(error)}`);
    }
  });
}

function buildAsyncFailureText(error: unknown, prefix = "刚才那个异步任务失败了"): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${reason.slice(0, 120)}`;
}

function toAsyncTriggerMeta(trigger: AsyncTrigger): AsyncTaskTriggerMeta {
  return {
    confidence: trigger.confidence,
    keyword: trigger.keyword,
    mode: trigger.mode,
    reason: trigger.reason
  };
}

function buildCapturedReplyMirrorText(captured: CapturedReply): string | undefined {
  const finalText = collapseDoubleNewlines(captured.textParts.filter(Boolean).join("\n\n")).trim();
  if (finalText) {
    return finalText;
  }
  if (captured.mediaUrls.length > 0) {
    return captured.mediaUrls.length > 1 ? `（发送了 ${captured.mediaUrls.length} 个媒体）` : "（发送了 1 个媒体）";
  }
  return undefined;
}

function appendOriginalSessionUserMirror(params: {
  body: unknown;
  fallbackText: string;
  logger?: { warn?: (value: string) => void };
  originalSessionKey: string;
  storePath: string;
  timestampMs?: number;
}): { ok: boolean; reason?: string; sessionFile?: string } {
  return appendSessionUserMessage({
    body: params.body,
    fallbackText: params.fallbackText,
    logger: params.logger,
    sessionKey: params.originalSessionKey,
    storePath: params.storePath,
    timestampMs: params.timestampMs
  });
}

function appendOriginalSessionAssistantMirror(params: {
  logger?: { warn?: (value: string) => void };
  mediaUrls?: string[];
  model?: string;
  originalSessionKey: string;
  storePath: string;
  text?: string;
  timestampMs?: number;
}): { ok: boolean; reason?: string; sessionFile?: string } {
  return appendSessionAssistantMessage({
    logger: params.logger,
    mediaUrls: params.mediaUrls,
    model: params.model,
    sessionKey: params.originalSessionKey,
    storePath: params.storePath,
    text: params.text,
    timestampMs: params.timestampMs
  });
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendOriginalSessionUserMirrorWithRetry(params: {
  body: unknown;
  fallbackText: string;
  logger?: { info?: (value: string) => void; warn?: (value: string) => void };
  originalSessionKey: string;
  storePath: string;
  timestampMs?: number;
}): Promise<void> {
  let result = appendOriginalSessionUserMirror(params);
  if (result.ok || result.reason !== "unknown session") {
    return;
  }

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await delayMs(attempt * 40);
    result = appendOriginalSessionUserMirror(params);
    if (result.ok) {
      params.logger?.info?.(`[onebot] session user mirror recovered attempt=${attempt} sessionKey=${params.originalSessionKey}`);
      return;
    }
    if (result.reason !== "unknown session") {
      return;
    }
  }
}

async function appendOriginalSessionAssistantMirrorWithRetry(params: {
  logger?: { info?: (value: string) => void; warn?: (value: string) => void };
  mediaUrls?: string[];
  model?: string;
  originalSessionKey: string;
  storePath: string;
  text?: string;
  timestampMs?: number;
}): Promise<void> {
  let result = appendOriginalSessionAssistantMirror(params);
  if (result.ok || result.reason !== "unknown session") {
    return;
  }

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await delayMs(attempt * 40);
    result = appendOriginalSessionAssistantMirror(params);
    if (result.ok) {
      params.logger?.info?.(`[onebot] session assistant mirror recovered attempt=${attempt} sessionKey=${params.originalSessionKey} model=${params.model ?? "onebot-async-mirror"}`);
      return;
    }
    if (result.reason !== "unknown session") {
      return;
    }
  }
}

async function resolveAsyncTaskUntrustedContext(api: any, params: {
  asyncConfig: ReturnType<typeof getAsyncReplyConfig>;
  messageText: string;
  originalSessionKey: string;
  storePath: string;
}): Promise<string | undefined> {
  if (!params.asyncConfig.spawnTaskSession) {
    return undefined;
  }

  const records = listAsyncTaskRecordsForSession({
    storePath: params.storePath,
    originalSessionKey: params.originalSessionKey,
    limit: 10
  });
  if (records.length === 0) {
    return undefined;
  }

  const match = await matchAsyncTaskRecordWithAi({
    apiConfig: params.asyncConfig.ai,
    logger: api.logger,
    messageText: params.messageText,
    records
  });
  if (!match.matched || !match.recordId) {
    return undefined;
  }

  const record = getAsyncTaskRecordById({
    recordId: match.recordId,
    storePath: params.storePath
  }) ?? records.find((item) => item.id === match.recordId);
  if (!record) {
    return undefined;
  }

  return buildAsyncTaskContextBlock({
    confidence: match.confidence,
    matchReason: match.reason,
    record
  });
}

function normalizeReplyText(api: any, text: string): string {
  let finalText = text.trim();
  if (finalText && getRenderMarkdownToPlain(api)) {
    finalText = markdownToPlain(finalText);
  }
  return finalText ? collapseDoubleNewlines(finalText) : "";
}

function appendCapturedReply(api: any, capture: CapturedReply, payload: ReplyPayload): void {
  const parsed = payload as { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;
  const rawText = typeof parsed === "string" ? parsed : parsed?.text ?? parsed?.body ?? "";
  const mediaUrls = typeof parsed === "string"
    ? []
    : [parsed?.mediaUrl, ...(parsed?.mediaUrls ?? [])].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const trimmedText = rawText.trim();

  if (trimmedText && trimmedText !== "NO_REPLY" && !trimmedText.endsWith("NO_REPLY")) {
    const normalizedText = normalizeReplyText(api, trimmedText);
    if (normalizedText) {
      capture.textParts.push(normalizedText);
    }
  }

  for (const mediaUrl of mediaUrls) {
    if (!capture.mediaUrls.includes(mediaUrl)) {
      capture.mediaUrls.push(mediaUrl);
    }
  }
}

async function deliverCapturedReply(api: any, target: ReplyTarget, captured: CapturedReply): Promise<void> {
  const finalText = collapseDoubleNewlines(captured.textParts.filter(Boolean).join("\n\n")).trim();

  if (target.isGroup && target.groupId) {
    if (finalText) {
      await sendGroupMsg(target.groupId, finalText, () => getOneBotConfig(api));
    }
    for (const mediaUrl of captured.mediaUrls) {
      await sendGroupImage(target.groupId, mediaUrl, () => getOneBotConfig(api));
    }
    return;
  }

  if (finalText) {
    await sendPrivateMsg(target.userId, finalText, () => getOneBotConfig(api));
  }
  for (const mediaUrl of captured.mediaUrls) {
    await sendPrivateImage(target.userId, mediaUrl, () => getOneBotConfig(api));
  }
}

async function sendFailureMessage(api: any, target: ReplyTarget, error: unknown, prefix = "处理失败"): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  const failText = `${prefix}: ${reason.slice(0, 120)}`;
  if (target.isGroup && target.groupId) {
    await sendGroupMsg(target.groupId, failText, () => getOneBotConfig(api)).catch(() => undefined);
    return;
  }
  await sendPrivateMsg(target.userId, failText, () => getOneBotConfig(api)).catch(() => undefined);
}

async function dispatchReply(api: any, runtime: any, params: {
  ctx: Record<string, unknown>;
  target: ReplyTarget;
}): Promise<void> {
  setActiveReplyTarget(params.target.replyTarget);

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: params.ctx,
      cfg: api.config,
      dispatcherOptions: {
        deliver: async (payload: unknown) => {
          const captured: CapturedReply = { textParts: [], mediaUrls: [] };
          appendCapturedReply(api, captured, payload as ReplyPayload);
          await deliverCapturedReply(api, params.target, captured);
        },
        onError: async (error: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[onebot] ${info?.kind ?? "reply"} failed: ${String(error)}`);
        }
      },
      replyOptions: {
        disableBlockStreaming: true
      }
    });
  } finally {
    clearActiveReplyTarget();
  }
}

async function captureReply(api: any, runtime: any, ctx: Record<string, unknown>): Promise<CapturedReply> {
  const captured: CapturedReply = {
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
        api.logger?.error?.(`[onebot] ${info?.kind ?? "reply"} failed: ${String(error)}`);
      }
    },
    replyOptions: {
      disableBlockStreaming: true
    }
  });

  return captured;
}

function clipText(text: string, maxChars: number): string {
  const trimmed = collapseDoubleNewlines(text.trim());
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return collapseDoubleNewlines(content.trim());
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const typed = item as { type?: string; text?: string; value?: string; content?: string };
    const type = String(typed.type ?? "").trim().toLowerCase();
    if (!["text", "input_text", "output_text"].includes(type)) {
      continue;
    }
    const text = typeof typed.text === "string"
      ? typed.text
      : typeof typed.value === "string"
        ? typed.value
        : typeof typed.content === "string"
          ? typed.content
          : "";
    if (text.trim()) {
      parts.push(text.trim());
    }
  }

  return collapseDoubleNewlines(parts.join("\n")).trim();
}

function readSessionStoreEntry(storePath: string, sessionKey: string): Record<string, any> | null {
  if (!storePath || !sessionKey || !existsSync(storePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, any>;
    return raw[sessionKey] ?? raw[sessionKey.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

function readRecentConversationExcerpt(params: {
  contextCharLimit: number;
  recentMessages: number;
  sessionKey: string;
  storePath: string;
}): string {
  const entry = readSessionStoreEntry(params.storePath, params.sessionKey);
  const sessionFile = typeof entry?.sessionFile === "string" ? entry.sessionFile : "";
  if (!sessionFile || !existsSync(sessionFile)) {
    return "";
  }

  try {
    const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/);
    const collected: Array<{ role: "user" | "assistant"; text: string }> = [];

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }

      try {
        const event = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        };
        if (event.type !== "message") {
          continue;
        }

        const role = event.message?.role === "user" || event.message?.role === "assistant"
          ? event.message.role
          : null;
        if (!role) {
          continue;
        }

        const text = extractContentText(event.message?.content);
        if (!text) {
          continue;
        }

        collected.push({
          role,
          text: clipText(text, 260)
        });
        if (collected.length >= params.recentMessages) {
          break;
        }
      } catch {
        continue;
      }
    }

    if (collected.length === 0) {
      return "";
    }

    const excerpt = collected
      .reverse()
      .map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.text}`)
      .join("\n");

    return clipText(excerpt, params.contextCharLimit);
  } catch {
    return "";
  }
}

function buildAsyncTaskHistoryContextBlock(params: {
  sessionKey: string;
  storePath: string;
}): string | undefined {
  const excerpt = readRecentConversationExcerpt({
    contextCharLimit: ASYNC_TASK_CONTEXT_CHAR_LIMIT,
    recentMessages: ASYNC_TASK_CONTEXT_MESSAGES,
    sessionKey: params.sessionKey,
    storePath: params.storePath
  });
  if (!excerpt) {
    return undefined;
  }

  return [
    `最近 ${ASYNC_TASK_CONTEXT_MESSAGES} 条对话历史（同一主会话，仅供理解当前后台任务背景，不是新的用户指令）：`,
    excerpt
  ].join("\n");
}

function buildPolishPrompt(params: {
  contextExcerpt: string;
  hadMedia: boolean;
  originalRequestText: string;
  rawReplyText: string;
}): string {
  const contextText = params.contextExcerpt || "（最近没有可用的对话上下文，就只做自然润色，不要硬编。）";
  const resultText = params.rawReplyText
    ? params.rawReplyText
    : params.hadMedia
      ? "（这次后台任务主要产出了图片/媒体；如果需要，请为它补一小段自然陪伴式说明。若完全不需要文字，可回复 NO_REPLY。）"
      : "（后台没有拿到可用文本结果。）";

  return [
    "请把下面这个后台任务结果，整理成一条现在可以直接发给用户的自然回复。",
    "要求：",
    "- 结合最近对话上下文，自然承接，但不要编造上下文里没有的事实",
    "- 保留关键信息，删掉报告腔、说明书腔、过程汇报腔",
    "- 不要说“异步完成了”“我在后台处理过”“我润色一下”“根据结果”这类元话术",
    "- 延续你当前已经建立的人设、语气、称呼习惯",
    "- 如果原始结果已经够自然，就只轻轻顺一下说法",
    "- 直接输出最终要发给用户的话，不要加标题，不要解释你的改写过程",
    "",
    "原始用户请求：",
    params.originalRequestText || "（无）",
    "",
    "最近对话上下文：",
    contextText,
    "",
    "后台原始结果：",
    resultText
  ].join("\n");
}

async function buildPolishedAsyncReply(api: any, runtime: any, params: {
  agentId: string;
  asyncConfig: ReturnType<typeof getAsyncReplyConfig>;
  originalRequestText: string;
  originalSessionKey: string;
  rawReply: CapturedReply;
  storePath: string;
  target: ReplyTarget;
}): Promise<{ polishSessionKey: string; reply: CapturedReply }> {
  const contextExcerpt = readRecentConversationExcerpt({
    contextCharLimit: params.asyncConfig.contextCharLimit,
    recentMessages: params.asyncConfig.recentMessages,
    sessionKey: params.originalSessionKey,
    storePath: params.storePath
  });

  const rawReplyText = clipText(params.rawReply.textParts.filter(Boolean).join("\n\n"), params.asyncConfig.rawResultCharLimit);
  const polishPrompt = buildPolishPrompt({
    contextExcerpt,
    hadMedia: params.rawReply.mediaUrls.length > 0,
    originalRequestText: clipText(params.originalRequestText, 1000),
    rawReplyText
  });
  const polishSessionKey = buildAsyncSessionKey(params.agentId, params.target, "polish");
  const polishCtx = buildInboundContext(api, runtime, {
    messageText: polishPrompt,
    replyTarget: params.target,
    sessionKey: polishSessionKey
  });

  await recordInboundSession(api, runtime, {
    ctx: polishCtx,
    replyTarget: params.target.replyTarget,
    sessionKey: polishSessionKey,
    storePath: params.storePath
  });

  const polished = await captureReply(api, runtime, polishCtx);
  if (polished.mediaUrls.length === 0) {
    polished.mediaUrls = [...params.rawReply.mediaUrls];
  }

  return {
    polishSessionKey,
    reply: polished.textParts.length > 0 || polished.mediaUrls.length > 0
      ? polished
      : params.rawReply
  };
}

async function sendAsyncAcceptedReply(api: any, params: {
  ackText: string;
  target: ReplyTarget;
}): Promise<void> {
  if (params.target.isGroup && params.target.groupId) {
    await sendGroupMsg(params.target.groupId, params.ackText, () => getOneBotConfig(api)).catch(() => undefined);
    return;
  }
  await sendPrivateMsg(params.target.userId, params.ackText, () => getOneBotConfig(api)).catch(() => undefined);
}

async function buildAsyncAcceptedAck(api: any, params: {
  agentId: string;
  asyncConfig: OneBotAsyncReplyConfig;
  chatType: "group" | "direct";
  trigger: AsyncTrigger;
  userRequestText: string;
}): Promise<string> {
  const persona = buildAgentPersonaContext(api.config, params.agentId);
  const triggerReason = [
    params.trigger.mode,
    params.trigger.keyword ? `关键词：${params.trigger.keyword}` : "",
    params.trigger.reason ? `判定理由：${params.trigger.reason}` : ""
  ].filter(Boolean).join("；");

  return await generateAsyncAckWithAi({
    agentName: persona.agentName,
    apiConfig: params.asyncConfig.ai,
    chatType: params.chatType,
    fallbackText: params.asyncConfig.ackText,
    logger: api.logger,
    personaPrompt: persona.personaPrompt,
    triggerReason,
    userRequestText: params.userRequestText
  });
}

async function handleDetachedAsyncReply(api: any, runtime: any, params: {
  agentId: string;
  asyncConfig: ReturnType<typeof getAsyncReplyConfig>;
  mediaAttachments?: InboundImageAttachment[];
  messageText: string;
  originalRequestText: string;
  originalSessionKey: string;
  originalTaskContext?: string;
  storePath: string;
  target: ReplyTarget;
  taskRecordId: string;
  taskSessionKey: string;
}): Promise<void> {
  const ctxPayload = buildInboundContext(api, runtime, {
    mediaAttachments: params.mediaAttachments,
    messageText: params.messageText,
    replyTarget: params.target,
    sessionKey: params.taskSessionKey,
    untrustedContext: params.originalTaskContext ? [params.originalTaskContext] : undefined
  });

  await recordInboundSession(api, runtime, {
    ctx: ctxPayload,
    replyTarget: params.target.replyTarget,
    sessionKey: params.taskSessionKey,
    storePath: params.storePath
  });

  updateAsyncTaskRecord({
    recordId: params.taskRecordId,
    storePath: params.storePath,
    mutate: (current) => ({
      ...current,
      startedAt: current.startedAt ?? Date.now(),
      status: "running",
      updatedAt: Date.now()
    })
  });

  try {
    const rawReply = await captureReply(api, runtime, ctxPayload);
    if (rawReply.textParts.length === 0 && rawReply.mediaUrls.length === 0) {
      updateAsyncTaskRecord({
        recordId: params.taskRecordId,
        storePath: params.storePath,
        mutate: (current) => ({
          ...current,
          completedAt: Date.now(),
          note: "empty_result",
          status: "completed",
          updatedAt: Date.now()
        })
      });
      return;
    }

    const polished = await buildPolishedAsyncReply(api, runtime, {
      agentId: params.agentId,
      asyncConfig: params.asyncConfig,
      originalRequestText: params.originalRequestText,
      originalSessionKey: params.originalSessionKey,
      rawReply,
      storePath: params.storePath,
      target: params.target
    });

    await deliverCapturedReply(api, params.target, polished.reply);

    const mirroredReplyText = buildCapturedReplyMirrorText(polished.reply);
    await appendOriginalSessionAssistantMirrorWithRetry({
      logger: api.logger,
      mediaUrls: polished.reply.mediaUrls,
      model: "onebot-async-final",
      originalSessionKey: params.originalSessionKey,
      storePath: params.storePath,
      text: mirroredReplyText,
      timestampMs: Date.now()
    });

    updateAsyncTaskRecord({
      recordId: params.taskRecordId,
      storePath: params.storePath,
      mutate: (current) => ({
        ...current,
        completedAt: Date.now(),
        finalReplyText: mirroredReplyText,
        mediaUrls: polished.reply.mediaUrls,
        polishSessionKey: polished.polishSessionKey,
        status: "completed",
        updatedAt: Date.now()
      })
    });
  } catch (error) {
    const failText = buildAsyncFailureText(error);
    api.logger?.error?.(`[onebot] async dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    await sendFailureMessage(api, params.target, error, "刚才那个异步任务失败了");
    await appendOriginalSessionAssistantMirrorWithRetry({
      logger: api.logger,
      model: "onebot-async-failure",
      originalSessionKey: params.originalSessionKey,
      storePath: params.storePath,
      text: failText,
      timestampMs: Date.now()
    });
    updateAsyncTaskRecord({
      recordId: params.taskRecordId,
      storePath: params.storePath,
      mutate: (current) => ({
        ...current,
        errorText: error instanceof Error ? error.message : String(error),
        failedAt: Date.now(),
        status: "failed",
        updatedAt: Date.now()
      })
    });
  }
}

export async function processInboundMessage(api: any, msg: OneBotMessage): Promise<void> {
  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[onebot] runtime.channel.reply not available");
    return;
  }

  const config = getOneBotConfig(api);
  if (!config) {
    api.logger?.warn?.("[onebot] onebot not configured");
    return;
  }

  const selfId = Number(msg.self_id ?? 0);
  if (msg.user_id != null && Number(msg.user_id) === selfId) {
    return;
  }

  const imageSegments = getImageSegments(msg);
  const inboundImages = await resolveInboundImageAttachments(api, msg, () => config);

  const replyId = getReplyMessageId(msg);
  let messageText: string;
  if (replyId != null) {
    const currentText = getTextFromSegments(msg);
    try {
      const quoted = await getMsg(replyId);
      const quotedText = getTextFromMessageContent(quoted?.message);
      const senderLabel = quoted?.sender?.nickname ?? quoted?.sender?.user_id ?? "某人";
      messageText = quotedText
        ? `[引用 ${String(senderLabel)} 的消息：${quotedText}]\n${currentText}`
        : currentText;
    } catch {
      messageText = currentText;
    }
  } else {
    messageText = getRawText(msg);
  }

  if (!messageText.trim() && imageSegments.length > 0) {
    messageText = buildImagePlaceholder(imageSegments.length);
  }

  if (!messageText.trim() || !msg.user_id) {
    return;
  }

  const isGroup = msg.message_type === "group";
  if (isGroup && getRequireMention(api) && !isMentioned(msg, selfId)) {
    return;
  }

  const groupIncreaseConfig = getGroupIncreaseConfig(api);
  const triggerText = getTextFromSegments(msg).trim() || messageText.trim();
  if (isGroup && groupIncreaseConfig.enabled && isMentioned(msg, selfId) && /^\/group-increase\s*$/i.test(triggerText)) {
    await handleGroupIncrease(api, {
      post_type: "notice",
      notice_type: "group_increase",
      group_id: msg.group_id,
      user_id: msg.user_id
    });
    return;
  }

  const userId = Number(msg.user_id);
  const groupId = msg.group_id ? Number(msg.group_id) : undefined;
  const replyTargetValue = isGroup ? `onebot:group:${groupId}` : `onebot:user:${userId}`;
  const replyTarget: ReplyTarget = {
    chatType: isGroup ? "group" : "direct",
    groupId,
    isGroup,
    replyTarget: replyTargetValue,
    senderLabel: String(userId),
    userId
  };
  const legacySessionKey = buildOneBotSessionKey(replyTarget);

  const route = runtime.channel.routing?.resolveAgentRoute?.({
    cfg: api.config,
    channel: "onebot",
    accountId: config.accountId ?? "default",
    peer: {
      kind: isGroup ? "group" : "direct",
      id: String(isGroup ? groupId : userId)
    }
  }) ?? { agentId: "main" };
  const sessionKey = buildCanonicalSessionKey(route.agentId ?? "main", replyTarget);

  const storePath = runtime.channel.session?.resolveStorePath?.(api.config?.session?.store, {
    agentId: route.agentId
  }) ?? "";

  migrateLegacySessionStoreKey({
    canonicalKey: sessionKey,
    legacyKey: legacySessionKey,
    logger: api.logger,
    storePath
  });

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "onebot",
      accountId: config.accountId ?? "default",
      direction: "inbound"
    });
  }

  const asyncConfig = getAsyncReplyConfig(api);
  const asyncTrigger = await resolveAsyncTrigger({
    asyncConfig,
    chatType: replyTarget.chatType,
    fullMessageText: messageText,
    logger: api.logger,
    triggerText
  });

  if (asyncTrigger !== null) {
    if (!asyncTrigger.taskMessageText.trim()) {
      const helpText = "要异步处理的话，发 `/async 你的任务` 或 `/异步 你的任务` 就好。";
      if (isGroup && groupId) {
        await sendGroupMsg(groupId, helpText, () => getOneBotConfig(api)).catch(() => undefined);
      } else {
        await sendPrivateMsg(userId, helpText, () => getOneBotConfig(api)).catch(() => undefined);
      }
      return;
    }

    const originalCtxPayload = buildInboundContext(api, runtime, {
      mediaAttachments: inboundImages,
      messageText,
      replyTarget,
      sessionKey
    });

    await recordInboundSession(api, runtime, {
      ctx: originalCtxPayload,
      replyTarget: replyTarget.replyTarget,
      sessionKey,
      storePath
    });
    await appendOriginalSessionUserMirrorWithRetry({
      body: originalCtxPayload.Body,
      fallbackText: messageText,
      logger: api.logger,
      originalSessionKey: sessionKey,
      storePath,
      timestampMs: Date.now()
    });

    const triggerMeta = [
      asyncTrigger.mode,
      asyncTrigger.keyword ? `keyword=${asyncTrigger.keyword}` : "",
      asyncTrigger.reason ? `reason=${asyncTrigger.reason}` : "",
      typeof asyncTrigger.confidence === "number" ? `confidence=${asyncTrigger.confidence.toFixed(2)}` : ""
    ].filter(Boolean).join(" ");
    api.logger?.info?.(`[onebot] async task accepted (${triggerMeta}) ${sessionKey}`);
    const ackText = await buildAsyncAcceptedAck(api, {
      agentId: route.agentId ?? "main",
      asyncConfig,
      chatType: replyTarget.chatType,
      trigger: asyncTrigger,
      userRequestText: messageText.trim()
    });

    await sendAsyncAcceptedReply(api, {
      ackText,
      target: replyTarget
    });
    await appendOriginalSessionAssistantMirrorWithRetry({
      logger: api.logger,
      model: "onebot-async-ack",
      originalSessionKey: sessionKey,
      storePath,
      text: ackText,
      timestampMs: Date.now()
    });

    if (!asyncConfig.spawnTaskSession) {
      const inlineCtxPayload = buildInboundContext(api, runtime, {
        mediaAttachments: inboundImages,
        messageText: asyncTrigger.taskMessageText,
        replyTarget,
        sessionKey
      });
      api.logger?.info?.(`[onebot] async child session disabled; continue on original session ${sessionKey}`);
      void (async () => {
        try {
          await dispatchReply(api, runtime, {
            ctx: inlineCtxPayload,
            target: replyTarget
          });
        } catch (error) {
          const failText = buildAsyncFailureText(error);
          api.logger?.error?.(`[onebot] async dispatch failed (original session): ${error instanceof Error ? error.message : String(error)}`);
          await sendFailureMessage(api, replyTarget, error, "刚才那个异步任务失败了");
          await appendOriginalSessionAssistantMirrorWithRetry({
            logger: api.logger,
            model: "onebot-async-failure",
            originalSessionKey: sessionKey,
            storePath,
            text: failText,
            timestampMs: Date.now()
          });
        }
      })();
      return;
    }

    const asyncTaskHistoryContext = buildAsyncTaskHistoryContextBlock({
      sessionKey,
      storePath
    });
    const taskSessionKey = buildAsyncSessionKey(route.agentId ?? "main", replyTarget, "task");
    const taskRecord = createAsyncTaskRecord({
      ackText,
      agentId: route.agentId ?? "main",
      chatType: replyTarget.chatType,
      groupId,
      originalRequestText: messageText.trim(),
      originalSessionKey: sessionKey,
      replyTarget: replyTarget.replyTarget,
      targetLabel: replyTarget.senderLabel,
      taskMessageText: asyncTrigger.taskMessageText,
      taskSessionKey,
      trigger: toAsyncTriggerMeta(asyncTrigger),
      userId
    });
    upsertAsyncTaskRecord({
      record: taskRecord,
      storePath
    });

    void handleDetachedAsyncReply(api, runtime, {
      agentId: route.agentId ?? "main",
      asyncConfig,
      mediaAttachments: inboundImages,
      messageText: asyncTrigger.taskMessageText,
      originalRequestText: messageText.trim(),
      originalSessionKey: sessionKey,
      originalTaskContext: asyncTaskHistoryContext,
      storePath,
      target: replyTarget,
      taskRecordId: taskRecord.id,
      taskSessionKey
    });
    return;
  }

  const asyncTaskContext = await resolveAsyncTaskUntrustedContext(api, {
    asyncConfig,
    messageText,
    originalSessionKey: sessionKey,
    storePath
  });

  const ctxPayload = buildInboundContext(api, runtime, {
    mediaAttachments: inboundImages,
    messageText,
    replyTarget,
    sessionKey,
    untrustedContext: asyncTaskContext ? [asyncTaskContext] : undefined
  });

  await recordInboundSession(api, runtime, {
    ctx: ctxPayload,
    replyTarget: replyTarget.replyTarget,
    sessionKey,
    storePath
  });

  try {
    await dispatchReply(api, runtime, {
      ctx: ctxPayload,
      target: replyTarget
    });
  } catch (error) {
    api.logger?.error?.(`[onebot] dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    await sendFailureMessage(api, replyTarget, error);
  }
}

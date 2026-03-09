import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { getOneBotConfig } from "../config.js";
import { getGroupInfo, getGroupMemberInfo, getImage, getStrangerInfo, stageInboundMediaToLocalPath } from "../connection.js";
import { collapseDoubleNewlines } from "../markdown.js";
import { appendSessionAssistantMessage, appendSessionUserMessage } from "../session-transcript-mirror.js";
import { getImageSegments, getVideoSegments } from "../message.js";
import type { OneBotMessage } from "../types.js";

const ASYNC_TASK_CONTEXT_CHAR_LIMIT = 6000;
const ASYNC_TASK_CONTEXT_MESSAGES = 20;
const GROUP_INFO_CACHE_TTL_MS = 10 * 60 * 1000;

const groupNameCache = new Map<number, { expiresAt: number; value: string }>();

export type ReplyTarget = {
  chatType: "group" | "direct";
  groupId?: number;
  groupName?: string;
  isGroup: boolean;
  replyTarget: string;
  senderCard?: string;
  senderLabel: string;
  senderName: string;
  userId: number;
};

export type InboundMediaAttachment = {
  kind: "image" | "video";
  mime: string;
  path: string;
};

type TranscriptExcerptItem = {
  role: "assistant" | "user";
  text: string;
};

function normalizeSenderName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function formatSenderLabel(senderName: string, senderCard: string | undefined, userId: number): string {
  const senderId = String(userId);
  const normalizedCard = senderCard?.trim();
  if (normalizedCard && normalizedCard !== senderName && normalizedCard !== senderId) {
    return `${senderName} / ${normalizedCard} (${senderId})`;
  }
  return senderName === senderId ? senderId : `${senderName} (${senderId})`;
}

function buildGroupSenderContextBlock(replyTarget: ReplyTarget): string | undefined {
  if (!replyTarget.isGroup) {
    return undefined;
  }

  return [
    "OneBot group sender (untrusted metadata):",
    "```json",
    JSON.stringify({
      qq: String(replyTarget.userId),
      name: replyTarget.senderName,
      group_nickname: replyTarget.senderCard,
      label: replyTarget.senderLabel,
    }, null, 2),
    "```",
  ].join("\n");
}

function buildGroupInfoContextBlock(replyTarget: ReplyTarget): string | undefined {
  if (!replyTarget.isGroup || !replyTarget.groupId) {
    return undefined;
  }

  return [
    "OneBot group info (untrusted metadata):",
    "```json",
    JSON.stringify({
      group_id: String(replyTarget.groupId),
      group_name: replyTarget.groupName,
      conversation_label: replyTarget.replyTarget,
    }, null, 2),
    "```",
  ].join("\n");
}

function pickFirstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function looksLikeDirectMediaReference(value: string): boolean {
  return value.startsWith("base64://")
    || /^https?:\/\//i.test(value)
    || value.startsWith("file://")
    || value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value);
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

function inferVideoMime(value?: string): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("video/")) {
    return normalized;
  }
  if (normalized.endsWith(".mp4")) return "video/mp4";
  if (normalized.endsWith(".webm")) return "video/webm";
  if (normalized.endsWith(".mov")) return "video/quicktime";
  if (normalized.endsWith(".m4v")) return "video/x-m4v";
  if (normalized.endsWith(".avi")) return "video/x-msvideo";
  if (normalized.endsWith(".mkv")) return "video/x-matroska";
  return "video/*";
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

function buildConversationExcerptText(items: TranscriptExcerptItem[], contextCharLimit: number): string {
  if (items.length === 0) {
    return "";
  }

  const excerpt = items
    .map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.text}`)
    .join("\n");

  return clipText(excerpt, contextCharLimit);
}

export function clipText(text: string, maxChars: number): string {
  const trimmed = collapseDoubleNewlines(text.trim());
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export async function resolveSenderIdentity(msg: OneBotMessage): Promise<{ senderCard?: string; senderLabel: string; senderName: string }> {
  const userId = Number(msg.user_id ?? 0);
  const groupId = msg.group_id ? Number(msg.group_id) : undefined;

  let senderName = normalizeSenderName(msg.sender?.nickname);
  let senderCard = groupId ? normalizeSenderName(msg.sender?.card) : undefined;

  if (!senderName && userId > 0) {
    if (groupId) {
      const memberInfo = await getGroupMemberInfo(groupId, userId);
      senderName = normalizeSenderName(memberInfo?.nickname) ?? normalizeSenderName(memberInfo?.card);
      senderCard = senderCard ?? normalizeSenderName(memberInfo?.card);
    } else {
      const strangerInfo = await getStrangerInfo(userId);
      senderName = normalizeSenderName(strangerInfo?.nickname);
    }
  }

  const finalSenderName = senderName ?? senderCard ?? String(userId || "未知用户");
  const finalSenderCard = senderCard && senderCard !== finalSenderName ? senderCard : undefined;
  return {
    senderCard: finalSenderCard,
    senderLabel: formatSenderLabel(finalSenderName, finalSenderCard, userId),
    senderName: finalSenderName,
  };
}

export async function resolveGroupName(groupId: number | undefined): Promise<string | undefined> {
  if (!groupId) {
    return undefined;
  }

  const cached = groupNameCache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const groupInfo = await getGroupInfo(groupId);
  const groupName = normalizeSenderName(groupInfo?.group_name);
  if (groupName) {
    groupNameCache.set(groupId, {
      expiresAt: Date.now() + GROUP_INFO_CACHE_TTL_MS,
      value: groupName,
    });
  }
  return groupName;
}

export function buildMediaPlaceholder(params: { imageCount?: number; videoCount?: number }): string {
  const parts: string[] = [];
  if ((params.imageCount ?? 0) > 0) {
    parts.push(params.imageCount === 1 ? "<media:image>" : `<media:image> (${params.imageCount} images)`);
  }
  if ((params.videoCount ?? 0) > 0) {
    parts.push(params.videoCount === 1 ? "<media:video>" : `<media:video> (${params.videoCount} videos)`);
  }
  return parts.join("\n");
}

export function dedupeInboundMediaAttachments(lists: InboundMediaAttachment[][]): InboundMediaAttachment[] {
  const merged: InboundMediaAttachment[] = [];
  const seen = new Set<string>();

  for (const list of lists) {
    for (const attachment of list) {
      const key = `${attachment.kind}:${attachment.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(attachment);
    }
  }

  return merged;
}

export async function resolveInboundMediaAttachments(
  api: any,
  msg: OneBotMessage,
  getConfig: () => ReturnType<typeof getOneBotConfig>
): Promise<InboundMediaAttachment[]> {
  const mediaSegments = [
    ...getImageSegments(msg).map((segment) => ({ kind: "image" as const, segment })),
    ...getVideoSegments(msg).map((segment) => ({ kind: "video" as const, segment }))
  ];
  if (mediaSegments.length === 0) {
    return [];
  }

  const attachments: InboundMediaAttachment[] = [];
  const seen = new Set<string>();

  for (const item of mediaSegments) {
    const { kind, segment } = item;
    const data = segment.data ?? {};
    let source = pickFirstString(data.url, data.src, data.path, data.local_path, data.file_url, data.fileUrl);
    const fileRef = pickFirstString(data.file, data.file_id, data.image, data.video);

    if (!source && fileRef) {
      if (looksLikeDirectMediaReference(fileRef)) {
        source = fileRef;
      } else if (kind === "image") {
        const resolved = await getImage(fileRef, getConfig);
        source = pickFirstString(resolved?.file, resolved?.url);
      }
    }

    if (!source) {
      api.logger?.warn?.(`[onebot] inbound ${kind} skipped: missing usable source (${JSON.stringify(data)})`);
      continue;
    }

    try {
      const stagedPath = await stageInboundMediaToLocalPath(source, kind === "image" ? "png" : "mp4");
      if (seen.has(stagedPath)) {
        continue;
      }
      seen.add(stagedPath);
      attachments.push({
        kind,
        mime: kind === "image"
          ? inferImageMime(pickFirstString(data.mimetype, data.mime, data.contentType, source))
          : inferVideoMime(pickFirstString(data.mimetype, data.mime, data.contentType, source)),
        path: stagedPath,
      });
    } catch (error) {
      api.logger?.warn?.(`[onebot] inbound ${kind} staging failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return attachments;
}

export function buildOneBotSessionKey(target: ReplyTarget): string {
  return target.isGroup ? `onebot:group:${target.groupId}` : `onebot:user:${target.userId}`;
}

export function buildCanonicalSessionKey(agentId: string, target: ReplyTarget): string {
  const normalizedAgentId = agentId.trim().toLowerCase() || "main";
  return `agent:${normalizedAgentId}:${buildOneBotSessionKey(target)}`;
}

export function migrateLegacySessionStoreKey(params: {
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

export function buildAsyncSessionKey(agentId: string, target: ReplyTarget, kind: "task" | "polish"): string {
  const normalizedAgentId = agentId.trim().toLowerCase() || "main";
  const scope = target.isGroup ? `group:${target.groupId}` : `user:${target.userId}`;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `agent:${normalizedAgentId}:onebot:async-${kind}:${scope}:${Date.now()}:${suffix}`;
}

export function buildInboundContext(api: any, runtime: any, params: {
  commandText?: string;
  mediaAttachments?: InboundMediaAttachment[];
  messageText: string;
  replyTarget: ReplyTarget;
  sessionKey: string;
  untrustedContext?: string[];
  wasMentioned?: boolean;
}): Record<string, unknown> {
  const { commandText, mediaAttachments = [], messageText, replyTarget, sessionKey, untrustedContext, wasMentioned } = params;
  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(api.config) ?? {};
  const agentBody = replyTarget.isGroup ? `${replyTarget.senderLabel}: ${messageText}` : messageText;
  const groupContextBlocks = [
    buildGroupInfoContextBlock(replyTarget),
    buildGroupSenderContextBlock(replyTarget),
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const mergedUntrustedContext = [
    ...groupContextBlocks,
    ...(Array.isArray(untrustedContext) ? untrustedContext : []),
  ];
  const body = runtime.channel.reply?.formatInboundEnvelope?.({
    channel: "OneBot",
    from: replyTarget.senderLabel,
    timestamp: Date.now(),
    body: messageText,
    chatType: replyTarget.chatType,
    sender: { id: String(replyTarget.userId), name: replyTarget.senderLabel },
    envelope: envelopeOptions
  }) ?? messageText;

  const mediaPaths = mediaAttachments.length > 0 ? mediaAttachments.map((item) => item.path) : undefined;
  const mediaTypes = mediaAttachments.length > 0 ? mediaAttachments.map((item) => item.mime) : undefined;

  const ctxPayload = {
    Body: body,
    BodyForAgent: agentBody,
    CommandBody: commandText ?? messageText,
    RawBody: messageText,
    From: replyTarget.isGroup ? `onebot:group:${replyTarget.groupId}` : `onebot:user:${replyTarget.userId}`,
    To: replyTarget.replyTarget,
    SessionKey: sessionKey,
    AccountId: getOneBotConfig(api)?.accountId ?? "default",
    ChatType: replyTarget.chatType,
    ConversationLabel: replyTarget.replyTarget,
    GroupChannel: replyTarget.isGroup ? replyTarget.replyTarget : undefined,
    GroupSubject: replyTarget.groupName,
    SenderName: replyTarget.senderName,
    SenderId: String(replyTarget.userId),
    Provider: "onebot",
    Surface: "onebot",
    MessageSid: `onebot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    Timestamp: Date.now(),
    WasMentioned: replyTarget.isGroup ? wasMentioned === true : undefined,
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
    UntrustedContext: mergedUntrustedContext.length > 0 ? mergedUntrustedContext : undefined,
    _onebot: {
      userId: replyTarget.userId,
      groupId: replyTarget.groupId,
      groupName: replyTarget.groupName,
      isGroup: replyTarget.isGroup,
      sender: {
        card: replyTarget.senderCard,
        label: replyTarget.senderLabel,
        name: replyTarget.senderName,
      }
    }
  };

  return runtime.channel.reply?.finalizeInboundContext?.(ctxPayload) ?? ctxPayload;
}

export async function recordInboundSession(api: any, runtime: any, params: {
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

export async function appendOriginalSessionUserMirrorWithRetry(params: {
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

export async function appendOriginalSessionAssistantMirrorWithRetry(params: {
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

export function readTranscriptExcerptItems(params: {
  recentMessages: number;
  sessionKey: string;
  stopAtLastAssistant?: boolean;
  storePath: string;
}): Array<{ role: "assistant" | "user"; text: string }> {
  const entry = readSessionStoreEntry(params.storePath, params.sessionKey);
  const sessionFile = typeof entry?.sessionFile === "string" ? entry.sessionFile : "";
  if (!sessionFile || !existsSync(sessionFile)) {
    return [];
  }

  try {
    const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/);
    const collected: TranscriptExcerptItem[] = [];

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

        if (params.stopAtLastAssistant && role === "assistant") {
          break;
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

    return collected.reverse();
  } catch {
    return [];
  }
}

export function readRecentConversationExcerpt(params: {
  contextCharLimit: number;
  recentMessages: number;
  sessionKey: string;
  storePath: string;
}): string {
  return buildConversationExcerptText(
    readTranscriptExcerptItems({
      recentMessages: params.recentMessages,
      sessionKey: params.sessionKey,
      storePath: params.storePath
    }),
    params.contextCharLimit
  );
}

export function buildAsyncTaskHistoryContextBlock(params: {
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

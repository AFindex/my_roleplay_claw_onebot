import { getOneBotConfig, getRequestHandlingConfig } from "../config.js";
import { getMsg, setFriendAddRequest, setGroupAddRequest } from "../connection.js";
import { getReadableTextFromMessageContent } from "../message.js";
import { handleGroupIncrease } from "./group-increase.js";
import { processInboundMessage } from "./process-inbound.js";
import {
  buildInboundContext,
  recordInboundSession,
  resolveInboundFileAttachmentFromData,
  resolveGroupName,
  resolveInboundSessionRoute,
  resolveSenderIdentity,
  type InboundFileAttachment,
  type ReplyTarget
} from "./process-inbound-shared.js";
import type { OneBotMessage } from "../types.js";

type RecordedNotice = {
  eventType: string;
  fileAttachments?: InboundFileAttachment[];
  messageText: string;
  replyTarget: ReplyTarget;
  untrustedContext?: string[];
};

export async function processOneBotEvent(api: any, payload: OneBotMessage): Promise<void> {
  if (payload.post_type === "message" && (payload.message_type === "private" || payload.message_type === "group")) {
    await processInboundMessage(api, payload);
    return;
  }

  if (payload.post_type === "notice") {
    await processOneBotNotice(api, payload);
    return;
  }

  if (payload.post_type === "request") {
    await processOneBotRequest(api, payload);
  }
}

async function processOneBotNotice(api: any, payload: OneBotMessage): Promise<void> {
  if (isPokeNotice(payload)) {
    await handlePokeNotice(api, payload);
    return;
  }

  const recorded = await buildRecordedNotice(api, payload);
  if (recorded) {
    await recordNoticeEvent(api, payload, recorded);
    return;
  }

  switch (payload.notice_type) {
    case "group_increase":
      await handleGroupIncrease(api, payload);
      return;
    case "group_ban":
    case "group_admin":
    case "group_card":
    case "group_decrease":
    case "essence":
      api.logger?.info?.(`[onebot] notice event ${summarizeNotice(payload)}`);
      return;
    default:
      return;
  }
}

function isPokeNotice(payload: OneBotMessage): boolean {
  return payload.notice_type === "poke" || (payload.notice_type === "notify" && payload.sub_type === "poke");
}

function summarizeNotice(payload: OneBotMessage): string {
  const parts = [
    `type=${payload.notice_type ?? "unknown"}`,
    payload.sub_type ? `subType=${payload.sub_type}` : "",
    payload.group_id != null ? `group=${payload.group_id}` : "",
    payload.user_id != null ? `user=${payload.user_id}` : "",
    payload.operator_id != null ? `operator=${payload.operator_id}` : "",
    payload.message_id != null ? `message=${payload.message_id}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function clipNoticeText(text: string, maxChars = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.trunc(numeric);
}

function pickFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function formatFileSize(size: unknown): string {
  const bytes = normalizePositiveNumber(size);
  if (!bytes) {
    return "";
  }

  if (bytes < 1024) {
    return ` (${bytes} B)`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return ` (${rounded} ${units[unitIndex]})`;
}

function buildNoticeContextBlock(payload: OneBotMessage): string {
  return [
    "OneBot notice event (untrusted metadata):",
    "```json",
    JSON.stringify({
      notice_type: payload.notice_type,
      sub_type: payload.sub_type,
      group_id: payload.group_id,
      user_id: payload.user_id,
      operator_id: payload.operator_id,
      target_id: payload.target_id,
      message_id: payload.message_id,
      duration: payload.duration,
      file: payload.file
    }, null, 2),
    "```"
  ].join("\n");
}

async function buildNoticeReplyTarget(payload: OneBotMessage, actorUserId: number): Promise<ReplyTarget | null> {
  if (!Number.isFinite(actorUserId) || actorUserId <= 0) {
    return null;
  }

  const isGroup = payload.group_id != null;
  const groupId = isGroup ? Number(payload.group_id) : undefined;
  const syntheticSenderPayload: OneBotMessage = {
    ...payload,
    group_id: groupId,
    user_id: actorUserId,
    sender: undefined
  };
  const [senderIdentity, groupName] = await Promise.all([
    resolveSenderIdentity(syntheticSenderPayload),
    isGroup ? resolveGroupName(groupId) : Promise.resolve(undefined)
  ]);

  return {
    chatType: isGroup ? "group" : "direct",
    groupId,
    groupName,
    isGroup,
    replyTarget: isGroup ? `onebot:group:${groupId}` : `onebot:user:${actorUserId}`,
    senderCard: senderIdentity.senderCard,
    senderLabel: senderIdentity.senderLabel,
    senderName: senderIdentity.senderName,
    userId: actorUserId
  };
}

async function resolveRecalledMessageSummary(payload: OneBotMessage): Promise<string | undefined> {
  const messageId = normalizePositiveNumber(payload.message_id);
  if (!messageId) {
    return undefined;
  }

  const recalled = await getMsg(messageId);
  const summary = getReadableTextFromMessageContent(recalled?.message, {
    selfId: normalizePositiveNumber(payload.self_id)
  });
  return summary ? clipNoticeText(summary, 120) : undefined;
}

async function buildGroupRecallNotice(payload: OneBotMessage): Promise<RecordedNotice | null> {
  const recalledUserId = normalizePositiveNumber(payload.user_id);
  const operatorId = normalizePositiveNumber(payload.operator_id);
  const selfId = normalizePositiveNumber(payload.self_id);
  if (!recalledUserId || payload.group_id == null) {
    return null;
  }
  const actorUserId = operatorId ?? recalledUserId;
  if (selfId && recalledUserId === selfId && operatorId === selfId) {
    return null;
  }

  const [actorTarget, recalledTarget, recalledSummary] = await Promise.all([
    buildNoticeReplyTarget(payload, actorUserId),
    operatorId && operatorId !== recalledUserId ? buildNoticeReplyTarget(payload, recalledUserId) : Promise.resolve(null),
    resolveRecalledMessageSummary(payload)
  ]);
  if (!actorTarget) {
    return null;
  }

  const actionText = recalledTarget
    ? `${actorTarget.senderName} 撤回了 ${recalledTarget.senderName} 的一条消息`
    : `${actorTarget.senderName} 撤回了一条消息`;
  return {
    eventType: "group_recall",
    messageText: `${actionText}${recalledSummary ? `：${recalledSummary}` : ""}`,
    replyTarget: actorTarget,
    untrustedContext: [buildNoticeContextBlock(payload)]
  };
}

async function buildFriendRecallNotice(payload: OneBotMessage): Promise<RecordedNotice | null> {
  const userId = normalizePositiveNumber(payload.user_id);
  const selfId = normalizePositiveNumber(payload.self_id);
  if (!userId) {
    return null;
  }
  if (selfId && userId === selfId) {
    return null;
  }

  const [replyTarget, recalledSummary] = await Promise.all([
    buildNoticeReplyTarget(payload, userId),
    resolveRecalledMessageSummary(payload)
  ]);
  if (!replyTarget) {
    return null;
  }

  return {
    eventType: "friend_recall",
    messageText: `${replyTarget.senderName} 撤回了一条消息${recalledSummary ? `：${recalledSummary}` : ""}`,
    replyTarget,
    untrustedContext: [buildNoticeContextBlock(payload)]
  };
}

async function buildGroupUploadNotice(api: any, payload: OneBotMessage): Promise<RecordedNotice | null> {
  const userId = normalizePositiveNumber(payload.user_id);
  const selfId = normalizePositiveNumber(payload.self_id);
  if (!userId || payload.group_id == null) {
    return null;
  }
  if (selfId && userId === selfId) {
    return null;
  }

  const replyTarget = await buildNoticeReplyTarget(payload, userId);
  if (!replyTarget) {
    return null;
  }

  const file = payload.file ?? {};
  const fileAttachment = await resolveInboundFileAttachmentFromData(
    api,
    file as Record<string, unknown>,
    () => getOneBotConfig(api)
  );
  const fileName = pickFirstString(
    file.name,
    file.file_name,
    file.filename,
    file.fileName,
    file.id
  );
  const fileSize = formatFileSize(
    (file as { size?: unknown }).size
    ?? (file as { file_size?: unknown }).file_size
  );
  const messageText = fileName
    ? `${replyTarget.senderName} 上传了群文件《${clipNoticeText(fileName, 80)}》${fileSize}`
    : `${replyTarget.senderName} 上传了一个群文件${fileSize}`;

  return {
    eventType: "group_upload",
    fileAttachments: fileAttachment ? [fileAttachment] : undefined,
    messageText,
    replyTarget,
    untrustedContext: [buildNoticeContextBlock(payload)]
  };
}

async function buildRecordedNotice(api: any, payload: OneBotMessage): Promise<RecordedNotice | null> {
  const config = getOneBotConfig(api);
  if (!config) {
    return null;
  }

  switch (payload.notice_type) {
    case "group_recall":
      return buildGroupRecallNotice(payload);
    case "friend_recall":
      return buildFriendRecallNotice(payload);
    case "group_upload":
      return buildGroupUploadNotice(api, payload);
    default:
      return null;
  }
}

async function recordNoticeEvent(api: any, payload: OneBotMessage, recorded: RecordedNotice): Promise<void> {
  const runtime = api.runtime;
  const config = getOneBotConfig(api);
  if (!runtime?.channel?.session?.recordInboundSession || !config) {
    api.logger?.info?.(`[onebot] notice skipped session-recording ${summarizeNotice(payload)}`);
    return;
  }

  const { sessionKey, storePath } = resolveInboundSessionRoute(api, runtime, {
    accountId: config.accountId ?? "default",
    replyTarget: recorded.replyTarget
  });

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "onebot",
      accountId: config.accountId ?? "default",
      direction: "inbound"
    });
  }

  const ctx = buildInboundContext(api, runtime, {
    fileAttachments: recorded.fileAttachments,
    messageText: recorded.messageText,
    replyTarget: recorded.replyTarget,
    sessionKey,
    untrustedContext: recorded.untrustedContext
  }) as Record<string, unknown>;
  const originalOneBotContext = ctx._onebot && typeof ctx._onebot === "object"
    ? ctx._onebot as Record<string, unknown>
    : {};

  ctx.EventType = recorded.eventType;
  ctx._onebot = {
    ...originalOneBotContext,
    notice: {
      duration: payload.duration,
      file: payload.file,
      messageId: payload.message_id,
      operatorId: payload.operator_id,
      subType: payload.sub_type,
      targetId: payload.target_id,
      type: payload.notice_type
    }
  };

  await recordInboundSession(api, runtime, {
    ctx,
    replyTarget: recorded.replyTarget.replyTarget,
    sessionKey,
    storePath
  });
  api.logger?.info?.(`[onebot] notice recorded ${summarizeNotice(payload)} session=${sessionKey}`);
}

async function handlePokeNotice(api: any, payload: OneBotMessage): Promise<void> {
  const selfId = Number(payload.self_id ?? 0);
  const targetId = Number(payload.target_id ?? 0);
  if (selfId > 0 && targetId > 0 && selfId !== targetId) {
    return;
  }

  const isGroup = payload.group_id != null;
  const syntheticText = "戳了戳你";
  const syntheticMessage: OneBotMessage = {
    ...payload,
    post_type: "message",
    message: isGroup && selfId > 0
      ? [
        { type: "at", data: { qq: String(selfId) } },
        { type: "text", data: { text: ` ${syntheticText}` } }
      ]
      : [
        { type: "text", data: { text: syntheticText } }
      ],
    message_type: isGroup ? "group" : "private",
    raw_message: isGroup && selfId > 0
      ? `[CQ:at,qq=${selfId}] ${syntheticText}`
      : syntheticText,
    sub_type: isGroup ? "normal" : "friend"
  };

  api.logger?.info?.(`[onebot] notice poke routed-as-message group=${payload.group_id ?? ""} user=${payload.user_id ?? ""}`);
  await processInboundMessage(api, syntheticMessage);
}

async function processOneBotRequest(api: any, payload: OneBotMessage): Promise<void> {
  const requestConfig = getRequestHandlingConfig(api);
  const requestType = payload.request_type ?? "unknown";
  const flag = typeof payload.flag === "string" ? payload.flag.trim() : "";
  const subType = (payload.sub_type ?? "").trim().toLowerCase();

  api.logger?.info?.(`[onebot] request event type=${requestType} subType=${subType || "unknown"} user=${payload.user_id ?? ""} group=${payload.group_id ?? ""} comment=${JSON.stringify(payload.comment ?? "")}`);

  if (!flag) {
    return;
  }

  if (requestType === "friend" && requestConfig.autoApproveFriend) {
    await setFriendAddRequest({
      approve: true,
      flag,
      getConfig: () => getOneBotConfig(api)
    });
    api.logger?.info?.(`[onebot] request auto-approved type=friend user=${payload.user_id ?? ""}`);
    return;
  }

  if (requestType === "group" && (subType === "add" || subType === "invite")) {
    const shouldApprove = subType === "add"
      ? requestConfig.autoApproveGroupAdd
      : requestConfig.autoApproveGroupInvite;
    if (!shouldApprove) {
      return;
    }

    await setGroupAddRequest({
      approve: true,
      flag,
      getConfig: () => getOneBotConfig(api),
      subType
    });
    api.logger?.info?.(`[onebot] request auto-approved type=group subType=${subType} group=${payload.group_id ?? ""} user=${payload.user_id ?? ""}`);
  }
}

import { getAsyncReplyConfig, getGroupIncreaseConfig, getOneBotConfig, getRequireMention } from "../config.js";
import { getForwardMsg, getMsg, isKnownNapCatGroupSendBlockedError } from "../connection.js";
import { getForwardSegmentIds, getImageSegments, getReadableRawText, getReadableTextFromMessageContent, getReplyMessageId, getTextFromSegments, getVideoSegments, isMentioned } from "../message.js";
import type { OneBotMessage } from "../types.js";
import { handleAsyncTrigger, resolveAsyncTaskUntrustedContext, resolveAsyncTrigger } from "./process-inbound-async.js";
import { handleGroupIncrease } from "./group-increase.js";
import { dispatchReply, sendFailureMessage } from "./process-inbound-reply.js";
import {
  buildInboundContext,
  dedupeInboundFileAttachments,
  buildMediaPlaceholder,
  dedupeInboundMediaAttachments,
  recordInboundSession,
  resolveInboundSessionRoute,
  resolveInboundFileAttachments,
  resolveGroupName,
  resolveInboundMediaAttachments,
  resolveSenderIdentity,
  type InboundFileAttachment,
  type InboundMediaAttachment,
  type ReplyTarget
} from "./process-inbound-shared.js";
import { handleGroupSummaryCommand } from "./process-inbound-summary.js";

const FORWARD_PREVIEW_CHAR_LIMIT = 800;
const FORWARD_PREVIEW_MAX_ITEMS = 2;

function clipForwardPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= FORWARD_PREVIEW_CHAR_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, FORWARD_PREVIEW_CHAR_LIMIT - 1)).trimEnd()}…`;
}

function appendForwardPreview(baseText: string, previewText: string): string {
  const normalizedBase = baseText.trim();
  const normalizedPreview = previewText.trim();
  if (!normalizedPreview) {
    return normalizedBase;
  }
  if (!normalizedBase) {
    return normalizedPreview;
  }
  return `${normalizedBase}\n[合并转发内容]\n${normalizedPreview}`;
}

function buildFilePlaceholder(fileAttachments: InboundFileAttachment[]): string {
  if (fileAttachments.length === 0) {
    return "";
  }
  if (fileAttachments.length === 1) {
    return fileAttachments[0]?.name?.trim()
      ? `[文件:${fileAttachments[0].name.trim()}]`
      : "[文件]";
  }
  return `（发送了 ${fileAttachments.length} 个文件）`;
}

function buildForwardNodePreview(node: {
  message?: OneBotMessage["message"];
  raw_message?: string;
  sender?: { card?: string; nickname?: string; user_id?: number };
  user_id?: number;
}, selfId: number): string {
  const sender = node.sender?.card?.trim()
    || node.sender?.nickname?.trim()
    || (node.sender?.user_id != null ? String(node.sender.user_id) : "")
    || (node.user_id != null ? String(node.user_id) : "");
  const readable = getReadableTextFromMessageContent(
    node.message ?? node.raw_message,
    { selfId }
  ).trim();
  if (!readable) {
    return "";
  }
  return sender ? `${sender}：${readable}` : readable;
}

async function resolveForwardPreview(content: OneBotMessage["message"], selfId: number): Promise<string> {
  const syntheticMessage: OneBotMessage = {
    post_type: "message",
    message: content,
    raw_message: typeof content === "string" ? content : undefined
  };
  const forwardIds = getForwardSegmentIds(syntheticMessage).slice(0, FORWARD_PREVIEW_MAX_ITEMS);
  if (forwardIds.length === 0) {
    return "";
  }

  const previews: string[] = [];
  for (const forwardId of forwardIds) {
    const forwarded = await getForwardMsg(forwardId);
    for (const node of forwarded?.messages ?? []) {
      const readable = buildForwardNodePreview(node, selfId);
      if (readable) {
        previews.push(readable);
      }
    }
  }

  if (previews.length === 0) {
    return "";
  }

  return clipForwardPreview(
    previews.slice(0, FORWARD_PREVIEW_MAX_ITEMS * 4).join("\n")
  );
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
  const videoSegments = getVideoSegments(msg);
  const [currentInboundMedia, currentInboundFiles] = await Promise.all([
    resolveInboundMediaAttachments(api, msg, () => config),
    resolveInboundFileAttachments(api, msg, () => config)
  ]);
  const wasMentioned = isMentioned(msg, selfId);

  const replyId = getReplyMessageId(msg);
  let quotedInboundMedia: InboundMediaAttachment[] = [];
  let quotedInboundFiles: InboundFileAttachment[] = [];
  let messageText: string;
  if (replyId != null) {
    const currentText = appendForwardPreview(
      getReadableRawText(msg, { selfId }),
      await resolveForwardPreview(msg.message, selfId)
    );
    try {
      const quoted = await getMsg(replyId);
      if (quoted?.message) {
        [quotedInboundMedia, quotedInboundFiles] = await Promise.all([
          resolveInboundMediaAttachments(api, {
            post_type: "message",
            message: quoted.message,
            raw_message: typeof quoted.message === "string" ? quoted.message : undefined
          }, () => config),
          resolveInboundFileAttachments(api, {
            post_type: "message",
            message: quoted.message,
            raw_message: typeof quoted.message === "string" ? quoted.message : undefined
          }, () => config)
        ]);
      }
      const quotedText = appendForwardPreview(
        getReadableTextFromMessageContent(quoted?.message, { selfId }),
        await resolveForwardPreview(quoted?.message, selfId)
      );
      const senderLabel = quoted?.sender?.nickname ?? quoted?.sender?.user_id ?? "某人";
      messageText = quotedText
        ? `[引用 ${String(senderLabel)} 的消息：${quotedText}]\n${currentText}`
        : currentText;
    } catch {
      messageText = currentText;
    }
  } else {
    messageText = appendForwardPreview(
      getReadableRawText(msg, { selfId }),
      await resolveForwardPreview(msg.message, selfId)
    );
  }

  const inboundMedia = dedupeInboundMediaAttachments([currentInboundMedia, quotedInboundMedia]);
  const inboundFiles = dedupeInboundFileAttachments([currentInboundFiles, quotedInboundFiles]);

  if (!messageText.trim() && (imageSegments.length > 0 || videoSegments.length > 0)) {
    messageText = buildMediaPlaceholder({
      imageCount: imageSegments.length,
      videoCount: videoSegments.length
    });
  }

  if (!messageText.trim() && inboundFiles.length > 0) {
    messageText = buildFilePlaceholder(inboundFiles);
  }

  if (!messageText.trim() || !msg.user_id) {
    return;
  }

  const isGroup = msg.message_type === "group";
  if (isGroup && getRequireMention(api) && !wasMentioned) {
    return;
  }

  const groupIncreaseConfig = getGroupIncreaseConfig(api);
  const triggerText = getTextFromSegments(msg).trim() || messageText.trim();
  if (isGroup && groupIncreaseConfig.enabled && wasMentioned && /^\/group-increase\s*$/i.test(triggerText)) {
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
  const [senderIdentity, groupName] = await Promise.all([
    resolveSenderIdentity(msg),
    isGroup ? resolveGroupName(groupId) : Promise.resolve(undefined),
  ]);
  const replyTargetValue = isGroup ? `onebot:group:${groupId}` : `onebot:user:${userId}`;
  const replyTarget: ReplyTarget = {
    chatType: isGroup ? "group" : "direct",
    groupId,
    groupName,
    isGroup,
    replyTarget: replyTargetValue,
    senderCard: senderIdentity.senderCard,
    senderLabel: senderIdentity.senderLabel,
    senderName: senderIdentity.senderName,
    userId
  };
  const { agentId, sessionKey, storePath } = resolveInboundSessionRoute(api, runtime, {
    accountId: config.accountId ?? "default",
    replyTarget
  });

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "onebot",
      accountId: config.accountId ?? "default",
      direction: "inbound"
    });
  }

  if (await handleGroupSummaryCommand(api, runtime, {
    messageText,
    replyTarget,
    sessionKey,
    storePath,
    triggerText,
    wasMentioned
  })) {
    return;
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
    await handleAsyncTrigger(api, runtime, {
      agentId,
      asyncConfig,
      asyncTrigger,
      inboundMedia,
      messageText,
      replyTarget,
      sessionKey,
      storePath,
      triggerText,
      wasMentioned
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
    commandText: triggerText,
    fileAttachments: inboundFiles,
    mediaAttachments: inboundMedia,
    messageText,
    replyTarget,
    sessionKey,
    untrustedContext: asyncTaskContext ? [asyncTaskContext] : undefined,
    wasMentioned
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
    if (isKnownNapCatGroupSendBlockedError(error)) {
      api.logger?.warn?.(`[onebot] dispatch blocked target=${replyTarget.replyTarget}: ${error instanceof Error ? error.message : String(error)}`);
    } else {
      api.logger?.error?.(`[onebot] dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sendFailureMessage(api, replyTarget, error);
  }
}

import { getAsyncReplyConfig, getGroupIncreaseConfig, getOneBotConfig, getRequireMention } from "../config.js";
import { getMsg, isKnownNapCatGroupSendBlockedError } from "../connection.js";
import { getImageSegments, getReadableRawText, getReadableTextFromMessageContent, getReplyMessageId, getTextFromSegments, getVideoSegments, isMentioned } from "../message.js";
import type { OneBotMessage } from "../types.js";
import { handleAsyncTrigger, resolveAsyncTaskUntrustedContext, resolveAsyncTrigger } from "./process-inbound-async.js";
import { handleGroupIncrease } from "./group-increase.js";
import { dispatchReply, sendFailureMessage } from "./process-inbound-reply.js";
import {
  buildCanonicalSessionKey,
  buildInboundContext,
  buildMediaPlaceholder,
  buildOneBotSessionKey,
  dedupeInboundMediaAttachments,
  migrateLegacySessionStoreKey,
  recordInboundSession,
  resolveGroupName,
  resolveInboundMediaAttachments,
  resolveSenderIdentity,
  type InboundMediaAttachment,
  type ReplyTarget
} from "./process-inbound-shared.js";
import { handleGroupSummaryCommand } from "./process-inbound-summary.js";

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
  const currentInboundMedia = await resolveInboundMediaAttachments(api, msg, () => config);
  const wasMentioned = isMentioned(msg, selfId);

  const replyId = getReplyMessageId(msg);
  let quotedInboundMedia: InboundMediaAttachment[] = [];
  let messageText: string;
  if (replyId != null) {
    const currentText = getReadableRawText(msg, { selfId });
    try {
      const quoted = await getMsg(replyId);
      if (quoted?.message) {
        quotedInboundMedia = await resolveInboundMediaAttachments(api, {
          post_type: "message",
          message: quoted.message,
          raw_message: typeof quoted.message === "string" ? quoted.message : undefined
        }, () => config);
      }
      const quotedText = getReadableTextFromMessageContent(quoted?.message, { selfId });
      const senderLabel = quoted?.sender?.nickname ?? quoted?.sender?.user_id ?? "某人";
      messageText = quotedText
        ? `[引用 ${String(senderLabel)} 的消息：${quotedText}]\n${currentText}`
        : currentText;
    } catch {
      messageText = currentText;
    }
  } else {
    messageText = getReadableRawText(msg, { selfId });
  }

  const inboundMedia = dedupeInboundMediaAttachments([currentInboundMedia, quotedInboundMedia]);

  if (!messageText.trim() && (imageSegments.length > 0 || videoSegments.length > 0)) {
    messageText = buildMediaPlaceholder({
      imageCount: imageSegments.length,
      videoCount: videoSegments.length
    });
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
  const agentId = route.agentId ?? "main";
  const sessionKey = buildCanonicalSessionKey(agentId, replyTarget);

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

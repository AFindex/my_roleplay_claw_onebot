import { getOneBotConfig, getRenderMarkdownToPlain, getRequireMention, getGroupIncreaseConfig } from "../config.js";
import { getMsg, sendGroupImage, sendGroupMsg, sendPrivateImage, sendPrivateMsg } from "../connection.js";
import { collapseDoubleNewlines, markdownToPlain } from "../markdown.js";
import { getRawText, getReplyMessageId, getTextFromMessageContent, getTextFromSegments, isMentioned } from "../message.js";
import { clearActiveReplyTarget, setActiveReplyTarget } from "../reply-context.js";
import type { OneBotMessage } from "../types.js";
import { handleGroupIncrease } from "./group-increase.js";

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
  const sessionId = isGroup ? `onebot:group:${groupId}` : `onebot:user:${userId}`;
  const replyTarget = isGroup ? `onebot:group:${groupId}` : `onebot:user:${userId}`;

  const route = runtime.channel.routing?.resolveAgentRoute?.({
    cfg: api.config,
    sessionKey: sessionId,
    channel: "onebot",
    accountId: config.accountId ?? "default"
  }) ?? { agentId: "main" };

  const storePath = runtime.channel.session?.resolveStorePath?.(api.config?.session?.store, {
    agentId: route.agentId
  }) ?? "";

  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(api.config) ?? {};
  const chatType = isGroup ? "group" : "direct";
  const senderLabel = String(userId);
  const body = runtime.channel.reply?.formatInboundEnvelope?.({
    channel: "OneBot",
    from: senderLabel,
    timestamp: Date.now(),
    body: messageText,
    chatType,
    sender: { id: String(userId), name: senderLabel },
    envelope: envelopeOptions
  }) ?? { content: [{ type: "text", text: messageText }] };

  const ctxPayload = {
    Body: body,
    RawBody: messageText,
    From: isGroup ? `onebot:group:${groupId}` : `onebot:user:${userId}`,
    To: replyTarget,
    SessionKey: sessionId,
    AccountId: config.accountId ?? "default",
    ChatType: chatType,
    ConversationLabel: replyTarget,
    SenderName: senderLabel,
    SenderId: String(userId),
    Provider: "onebot",
    Surface: "onebot",
    MessageSid: `onebot-${Date.now()}`,
    Timestamp: Date.now(),
    OriginatingChannel: "onebot",
    OriginatingTo: replyTarget,
    CommandAuthorized: true,
    DeliveryContext: {
      channel: "onebot",
      to: replyTarget,
      accountId: config.accountId ?? "default"
    },
    _onebot: {
      userId,
      groupId,
      isGroup
    }
  };

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: sessionId,
        channel: "onebot",
        to: replyTarget,
        accountId: config.accountId ?? "default"
      },
      onRecordError: (error: unknown) => {
        api.logger?.warn?.(`[onebot] recordInboundSession failed: ${String(error)}`);
      }
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "onebot",
      accountId: config.accountId ?? "default",
      direction: "inbound"
    });
  }

  setActiveReplyTarget(replyTarget);

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: api.config,
      dispatcherOptions: {
        deliver: async (payload: unknown) => {
          const parsed = payload as { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;
          const rawText = typeof parsed === "string" ? parsed : parsed?.text ?? parsed?.body ?? "";
          const mediaUrl = typeof parsed === "string" ? undefined : parsed?.mediaUrl ?? parsed?.mediaUrls?.[0];
          const trimmedText = rawText.trim();

          if ((!trimmedText || trimmedText === "NO_REPLY" || trimmedText.endsWith("NO_REPLY")) && !mediaUrl) {
            return;
          }

          let finalText = trimmedText;
          if (finalText && getRenderMarkdownToPlain(api)) {
            finalText = markdownToPlain(finalText);
          }
          if (finalText) {
            finalText = collapseDoubleNewlines(finalText);
          }

          if (isGroup && groupId) {
            if (finalText) {
              await sendGroupMsg(groupId, finalText, () => getOneBotConfig(api));
            }
            if (mediaUrl) {
              await sendGroupImage(groupId, mediaUrl, () => getOneBotConfig(api));
            }
          } else {
            if (finalText) {
              await sendPrivateMsg(userId, finalText, () => getOneBotConfig(api));
            }
            if (mediaUrl) {
              await sendPrivateImage(userId, mediaUrl, () => getOneBotConfig(api));
            }
          }
        },
        onError: async (error: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[onebot] ${info?.kind ?? "reply"} failed: ${String(error)}`);
        }
      },
      replyOptions: {
        disableBlockStreaming: true
      }
    });
  } catch (error) {
    api.logger?.error?.(`[onebot] dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    const failText = `处理失败: ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`;
    if (isGroup && groupId) {
      await sendGroupMsg(groupId, failText, () => getOneBotConfig(api)).catch(() => undefined);
    } else {
      await sendPrivateMsg(userId, failText, () => getOneBotConfig(api)).catch(() => undefined);
    }
  } finally {
    clearActiveReplyTarget();
  }
}


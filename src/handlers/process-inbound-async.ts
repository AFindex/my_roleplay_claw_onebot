import { buildAgentPersonaContext } from "../agent-persona.js";
import { generateAsyncAckWithAi } from "../async-ack-ai.js";
import { classifyAsyncIntentWithAi } from "../async-intent-ai.js";
import { matchAsyncTaskRecordWithAi } from "../async-record-search-ai.js";
import {
  buildAsyncTaskContextBlock,
  createAsyncTaskRecord,
  getAsyncTaskRecordById,
  listAsyncTaskRecordsForSession,
  updateAsyncTaskRecord,
  upsertAsyncTaskRecord,
  type AsyncTaskTriggerMeta
} from "../async-task-records.js";
import { getOneBotConfig, type OneBotAsyncReplyConfig } from "../config.js";
import { sendGroupMsg, sendPrivateMsg } from "../connection.js";
import {
  appendOriginalSessionAssistantMirrorWithRetry,
  appendOriginalSessionUserMirrorWithRetry,
  buildAsyncSessionKey,
  buildAsyncTaskHistoryContextBlock,
  buildInboundContext,
  clipText,
  readRecentConversationExcerpt,
  recordInboundSession,
  type InboundMediaAttachment,
  type ReplyTarget
} from "./process-inbound-shared.js";
import {
  buildAsyncFailureText,
  buildCapturedReplyMirrorText,
  buildCapturedReplyText,
  captureReply,
  deliverCapturedReply,
  dispatchReply,
  sendFailureMessage,
  type CapturedReply
} from "./process-inbound-reply.js";

export type AsyncTrigger = {
  confidence?: number;
  keyword?: string;
  mode: "ai" | "explicit" | "keyword";
  reason?: string;
  taskMessageText: string;
};

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
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "（空）";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatJudgeMeta(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
}

function toAsyncTriggerMeta(trigger: AsyncTrigger): AsyncTaskTriggerMeta {
  return {
    confidence: trigger.confidence,
    keyword: trigger.keyword,
    mode: trigger.mode,
    reason: trigger.reason
  };
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
  asyncConfig: OneBotAsyncReplyConfig;
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

  const rawReplyText = clipText(buildCapturedReplyText(params.rawReply), params.asyncConfig.rawResultCharLimit);
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
    reply: buildCapturedReplyText(polished) || polished.mediaUrls.length > 0
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
  asyncConfig: OneBotAsyncReplyConfig;
  mediaAttachments?: InboundMediaAttachment[];
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
    if (!buildCapturedReplyText(rawReply) && rawReply.mediaUrls.length === 0) {
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

export async function resolveAsyncTrigger(params: {
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

export async function resolveAsyncTaskUntrustedContext(api: any, params: {
  asyncConfig: OneBotAsyncReplyConfig;
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

export async function handleAsyncTrigger(api: any, runtime: any, params: {
  agentId: string;
  asyncConfig: OneBotAsyncReplyConfig;
  asyncTrigger: AsyncTrigger;
  inboundMedia: InboundMediaAttachment[];
  messageText: string;
  replyTarget: ReplyTarget;
  sessionKey: string;
  storePath: string;
  triggerText: string;
  wasMentioned: boolean;
}): Promise<void> {
  if (!params.asyncTrigger.taskMessageText.trim()) {
    const helpText = "要异步处理的话，发 `/async 你的任务` 或 `/异步 你的任务` 就好。";
    if (params.replyTarget.isGroup && params.replyTarget.groupId) {
      await sendGroupMsg(params.replyTarget.groupId, helpText, () => getOneBotConfig(api)).catch(() => undefined);
    } else {
      await sendPrivateMsg(params.replyTarget.userId, helpText, () => getOneBotConfig(api)).catch(() => undefined);
    }
    return;
  }

  const originalCtxPayload = buildInboundContext(api, runtime, {
    commandText: params.triggerText,
    mediaAttachments: params.inboundMedia,
    messageText: params.messageText,
    replyTarget: params.replyTarget,
    sessionKey: params.sessionKey,
    wasMentioned: params.wasMentioned
  });

  await recordInboundSession(api, runtime, {
    ctx: originalCtxPayload,
    replyTarget: params.replyTarget.replyTarget,
    sessionKey: params.sessionKey,
    storePath: params.storePath
  });

  if (params.asyncConfig.spawnTaskSession) {
    await appendOriginalSessionUserMirrorWithRetry({
      body: originalCtxPayload.Body,
      fallbackText: params.messageText,
      logger: api.logger,
      originalSessionKey: params.sessionKey,
      storePath: params.storePath,
      timestampMs: Date.now()
    });
  }

  const triggerMeta = [
    params.asyncTrigger.mode,
    params.asyncTrigger.keyword ? `keyword=${params.asyncTrigger.keyword}` : "",
    params.asyncTrigger.reason ? `reason=${params.asyncTrigger.reason}` : "",
    typeof params.asyncTrigger.confidence === "number" ? `confidence=${params.asyncTrigger.confidence.toFixed(2)}` : ""
  ].filter(Boolean).join(" ");
  api.logger?.info?.(`[onebot] async task accepted (${triggerMeta}) ${params.sessionKey}`);

  if (!params.asyncConfig.spawnTaskSession) {
    const inlineCtxPayload = buildInboundContext(api, runtime, {
      mediaAttachments: params.inboundMedia,
      messageText: params.asyncTrigger.taskMessageText,
      replyTarget: params.replyTarget,
      sessionKey: params.sessionKey,
      wasMentioned: params.wasMentioned
    });
    api.logger?.info?.(`[onebot] async child session disabled; continue on original session without ack ${params.sessionKey}`);
    void (async () => {
      try {
        await dispatchReply(api, runtime, {
          ctx: inlineCtxPayload,
          target: params.replyTarget
        });
      } catch (error) {
        const failText = buildAsyncFailureText(error);
        api.logger?.error?.(`[onebot] async dispatch failed (original session): ${error instanceof Error ? error.message : String(error)}`);
        await sendFailureMessage(api, params.replyTarget, error, "刚才那个异步任务失败了");
        await appendOriginalSessionAssistantMirrorWithRetry({
          logger: api.logger,
          model: "onebot-async-failure",
          originalSessionKey: params.sessionKey,
          storePath: params.storePath,
          text: failText,
          timestampMs: Date.now()
        });
      }
    })();
    return;
  }

  const ackText = await buildAsyncAcceptedAck(api, {
    agentId: params.agentId,
    asyncConfig: params.asyncConfig,
    chatType: params.replyTarget.chatType,
    trigger: params.asyncTrigger,
    userRequestText: params.messageText.trim()
  });

  await sendAsyncAcceptedReply(api, {
    ackText,
    target: params.replyTarget
  });
  await appendOriginalSessionAssistantMirrorWithRetry({
    logger: api.logger,
    model: "onebot-async-ack",
    originalSessionKey: params.sessionKey,
    storePath: params.storePath,
    text: ackText,
    timestampMs: Date.now()
  });

  const asyncTaskHistoryContext = buildAsyncTaskHistoryContextBlock({
    sessionKey: params.sessionKey,
    storePath: params.storePath
  });
  const taskSessionKey = buildAsyncSessionKey(params.agentId, params.replyTarget, "task");
  const taskRecord = createAsyncTaskRecord({
    ackText,
    agentId: params.agentId,
    chatType: params.replyTarget.chatType,
    groupId: params.replyTarget.groupId,
    originalRequestText: params.messageText.trim(),
    originalSessionKey: params.sessionKey,
    replyTarget: params.replyTarget.replyTarget,
    targetLabel: params.replyTarget.senderLabel,
    taskMessageText: params.asyncTrigger.taskMessageText,
    taskSessionKey,
    trigger: toAsyncTriggerMeta(params.asyncTrigger),
    userId: params.replyTarget.userId
  });
  upsertAsyncTaskRecord({
    record: taskRecord,
    storePath: params.storePath
  });

  void handleDetachedAsyncReply(api, runtime, {
    agentId: params.agentId,
    asyncConfig: params.asyncConfig,
    mediaAttachments: params.inboundMedia,
    messageText: params.asyncTrigger.taskMessageText,
    originalRequestText: params.messageText.trim(),
    originalSessionKey: params.sessionKey,
    originalTaskContext: asyncTaskHistoryContext,
    storePath: params.storePath,
    target: params.replyTarget,
    taskRecordId: taskRecord.id,
    taskSessionKey
  });
}

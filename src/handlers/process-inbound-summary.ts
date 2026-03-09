import { getGroupSummaryConfig, getOneBotConfig, type OneBotGroupSummaryConfig, type OneBotGroupSummaryMethod } from "../config.js";
import { sendGroupMsg } from "../connection.js";
import { canUseGroupSummaryAi, generateGroupSummaryWithAi } from "../group-summary-ai.js";
import {
  appendOriginalSessionAssistantMirrorWithRetry,
  buildInboundContext,
  clipText,
  readTranscriptExcerptItems,
  recordInboundSession,
  type ReplyTarget
} from "./process-inbound-shared.js";

type GroupSummaryCommand = {
  keywords: string[];
  messageLimit?: number;
  method: OneBotGroupSummaryMethod;
  showHelp?: boolean;
};

const GROUP_SUMMARY_OUTPUT_CHAR_LIMIT = 1800;

const SUMMARY_COMMAND_PATTERNS = [
  /^\/summary(?:[\s\u3000]+([\s\S]+))?$/i,
  /^\/群总结(?:[\s\u3000]+([\s\S]+))?$/i,
  /^\/总结(?:[\s\u3000]+([\s\S]+))?$/i
];

function buildConversationExcerptText(items: Array<{ role: "assistant" | "user"; text: string }>, contextCharLimit: number): string {
  if (items.length === 0) {
    return "";
  }

  const excerpt = items
    .map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.text}`)
    .join("\n");

  return clipText(excerpt, contextCharLimit);
}

function parseSummaryMessageLimit(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const match = raw.trim().match(/^(\d{1,4})$/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(500, Math.trunc(parsed));
}

function splitSummaryKeywords(raw: string): string[] {
  return raw
    .split(/[\s,，、；;|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseGroupSummaryCommand(text: string, defaultMethod: OneBotGroupSummaryMethod): GroupSummaryCommand | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  let args = "";
  let matched = false;
  for (const pattern of SUMMARY_COMMAND_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) {
      continue;
    }
    args = (match[1] ?? "").trim();
    matched = true;
    break;
  }

  if (!matched) {
    return null;
  }

  if (!args) {
    return { keywords: [], method: defaultMethod };
  }

  if (/^(help|帮助|说明)$/i.test(args)) {
    return { keywords: [], method: defaultMethod, showHelp: true };
  }

  const recentMatch = args.match(/^(?:recent|recent-messages|最近)(?:[\s　]+(\d{1,4}))?$/i);
  if (recentMatch) {
    return {
      keywords: [],
      messageLimit: parseSummaryMessageLimit(recentMatch[1]),
      method: "recent-messages"
    };
  }

  if (/^(?:since|since-last-reply|未读|自上次回复(?:以来)?|上次回复以来)$/i.test(args)) {
    return { keywords: [], method: "since-last-reply" };
  }

  const topicMatch = args.match(/^(?:topic|关键词|聚焦)(?:[:：\s　]+)([\s\S]+)$/i);
  if (topicMatch) {
    return {
      keywords: splitSummaryKeywords(topicMatch[1] ?? ""),
      method: "focused-keywords"
    };
  }

  const messageLimit = parseSummaryMessageLimit(args);
  if (messageLimit) {
    return {
      keywords: [],
      messageLimit,
      method: "recent-messages"
    };
  }

  return {
    keywords: splitSummaryKeywords(args),
    method: "focused-keywords"
  };
}

function buildGroupSummaryHelpText(): string {
  return [
    "群总结命令用法：",
    "- /summary",
    "- /summary recent 50",
    "- /summary since-last-reply",
    "- /summary topic 发布 回滚",
    "- /群总结",
    "- /群总结 帮助"
  ].join("\n");
}

function buildGroupSummaryDisabledText(): string {
  return "群总结功能还没启用。先在 channels.onebot.groupSummary 里开启并配置 AI 吧。";
}

function buildGroupSummaryConfigMissingText(): string {
  return "群总结 AI 还没配好：请检查 channels.onebot.groupSummary.ai.apiKey / model / enabled。";
}

function matchesSummaryKeyword(text: string, keywords: string[]): boolean {
  const normalizedText = text.trim().toLowerCase();
  if (!normalizedText) {
    return false;
  }
  return keywords.some((keyword) => normalizedText.includes(keyword.trim().toLowerCase()));
}

function selectGroupSummarySource(params: {
  command: GroupSummaryCommand;
  config: OneBotGroupSummaryConfig;
  sessionKey: string;
  storePath: string;
}): { emptyReason?: string; focusKeywords: string[]; scopeLabel: string; transcriptText: string } {
  const messageLimit = params.command.messageLimit ?? params.config.recentMessages;

  if (params.command.method === "since-last-reply") {
    const items = readTranscriptExcerptItems({
      recentMessages: Math.max(messageLimit * 3, messageLimit),
      sessionKey: params.sessionKey,
      stopAtLastAssistant: true,
      storePath: params.storePath
    });
    const transcriptText = buildConversationExcerptText(items.slice(-messageLimit), params.config.contextCharLimit);
    return transcriptText
      ? { focusKeywords: [], scopeLabel: "自上次回复以来", transcriptText }
      : { emptyReason: "从我上次说话到现在，暂时还没有新的群聊内容可总结。", focusKeywords: [], scopeLabel: "自上次回复以来", transcriptText: "" };
  }

  if (params.command.method === "focused-keywords") {
    const focusKeywords = params.command.keywords.length > 0 ? params.command.keywords : params.config.focusKeywords;
    if (focusKeywords.length === 0) {
      return {
        emptyReason: "关键词总结需要给我关键词，比如 `/summary topic 发布 回滚`。",
        focusKeywords: [],
        scopeLabel: "关键词聚焦",
        transcriptText: ""
      };
    }

    const scannedItems = readTranscriptExcerptItems({
      recentMessages: Math.max(messageLimit * 4, messageLimit),
      sessionKey: params.sessionKey,
      storePath: params.storePath
    });
    const filteredItems = scannedItems.filter((item) => matchesSummaryKeyword(item.text, focusKeywords));
    const transcriptText = buildConversationExcerptText(filteredItems.slice(-messageLimit), params.config.contextCharLimit);
    return transcriptText
      ? { focusKeywords, scopeLabel: `关键词：${focusKeywords.join("、")}`, transcriptText }
      : { emptyReason: `最近没有找到和关键词「${focusKeywords.join("、")}」直接相关的群聊记录。`, focusKeywords, scopeLabel: `关键词：${focusKeywords.join("、")}`, transcriptText: "" };
  }

  const items = readTranscriptExcerptItems({
    recentMessages: messageLimit,
    sessionKey: params.sessionKey,
    storePath: params.storePath
  });
  const transcriptText = buildConversationExcerptText(items, params.config.contextCharLimit);
  return transcriptText
    ? { focusKeywords: [], scopeLabel: `最近 ${messageLimit} 条消息`, transcriptText }
    : { emptyReason: "当前会话里还没有足够的群聊记录可总结。", focusKeywords: [], scopeLabel: `最近 ${messageLimit} 条消息`, transcriptText: "" };
}

export async function handleGroupSummaryCommand(api: any, runtime: any, params: {
  messageText: string;
  replyTarget: ReplyTarget;
  sessionKey: string;
  storePath: string;
  triggerText: string;
  wasMentioned: boolean;
}): Promise<boolean> {
  if (!params.replyTarget.isGroup || !params.replyTarget.groupId) {
    return false;
  }

  const summaryConfig = getGroupSummaryConfig(api);
  const command = parseGroupSummaryCommand(params.triggerText, summaryConfig.method);
  if (!command) {
    return false;
  }

  let selection: ReturnType<typeof selectGroupSummarySource> | null = null;
  if (!command.showHelp && summaryConfig.enabled && canUseGroupSummaryAi(summaryConfig.ai)) {
    selection = selectGroupSummarySource({
      command,
      config: summaryConfig,
      sessionKey: params.sessionKey,
      storePath: params.storePath
    });
  }

  const ctxPayload = buildInboundContext(api, runtime, {
    commandText: params.triggerText,
    messageText: params.messageText,
    replyTarget: params.replyTarget,
    sessionKey: params.sessionKey,
    wasMentioned: params.wasMentioned
  });
  await recordInboundSession(api, runtime, {
    ctx: ctxPayload,
    replyTarget: params.replyTarget.replyTarget,
    sessionKey: params.sessionKey,
    storePath: params.storePath
  });

  let replyText = "";
  if (command.showHelp) {
    replyText = buildGroupSummaryHelpText();
  } else if (!summaryConfig.enabled) {
    replyText = buildGroupSummaryDisabledText();
  } else if (!canUseGroupSummaryAi(summaryConfig.ai)) {
    replyText = buildGroupSummaryConfigMissingText();
  } else if (!selection || !selection.transcriptText) {
    replyText = selection?.emptyReason ?? "当前没有可用于总结的群聊内容。";
  } else {
    try {
      replyText = await generateGroupSummaryWithAi({
        apiConfig: summaryConfig.ai,
        commandText: params.triggerText,
        focusKeywords: selection.focusKeywords,
        groupName: params.replyTarget.groupName,
        logger: api.logger,
        method: command.method,
        requesterLabel: params.replyTarget.senderLabel,
        scopeLabel: selection.scopeLabel,
        transcriptText: selection.transcriptText
      });
    } catch (error) {
      api.logger?.error?.(`[onebot] group summary failed: ${error instanceof Error ? error.message : String(error)}`);
      replyText = `群总结失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const finalReply = clipText(replyText || "群总结失败：没有拿到可用结果。", GROUP_SUMMARY_OUTPUT_CHAR_LIMIT);
  await sendGroupMsg(params.replyTarget.groupId, finalReply, () => getOneBotConfig(api)).catch(() => undefined);
  await appendOriginalSessionAssistantMirrorWithRetry({
    logger: api.logger,
    model: "onebot-group-summary",
    originalSessionKey: params.sessionKey,
    storePath: params.storePath,
    text: finalReply,
    timestampMs: Date.now()
  });
  return true;
}

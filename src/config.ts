import type { OneBotAccountConfig } from "./types.js";

const DEFAULT_ASYNC_REPLY_KEYWORDS = [
  "查一下",
  "查一查",
  "帮我查",
  "搜一下",
  "搜一搜",
  "搜索",
  "调研",
  "调查",
  "总结",
  "汇总",
  "整理一下",
  "整理下",
  "梳理一下",
  "梳理下",
  "分析一下",
  "分析下",
  "对比一下",
  "对比下",
  "比较一下",
  "比较下",
  "排查",
  "定位一下",
  "定位下",
  "诊断一下",
  "诊断下",
  "研究一下",
  "研究下",
  "归纳一下",
  "归纳下",
  "列出",
  "写个方案",
  "做个方案",
  "给我个方案",
  "写份方案",
  "写个报告",
  "写份报告",
  "写个总结",
  "写份总结",
  "写个文档",
  "写份文档",
  "写代码",
  "写个脚本",
  "生成代码",
  "生成脚本",
  "翻译一下",
  "翻译下",
  "润色一下",
  "润色下"
] as const;

export interface OneBotAsyncReplyAiConfig {
  apiKey?: string;
  ackModel: string;
  baseUrl: string;
  enabled: boolean;
  fallbackToKeywords: boolean;
  judgeModel: string;
  maxTokens: number;
  model?: string;
  searchModel: string;
  temperature: number;
  timeoutMs: number;
}

export interface OneBotAsyncReplyConfig {
  ackText: string;
  ai: OneBotAsyncReplyAiConfig;
  contextCharLimit: number;
  enabled: boolean;
  keywords: string[];
  rawResultCharLimit: number;
  recentMessages: number;
}

function getRootConfig(apiOrCfg?: any): any {
  return apiOrCfg?.config ?? apiOrCfg ?? (globalThis as any).__onebotGatewayConfig ?? {};
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function resolvePositiveInteger(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(input));
}

function resolveNumber(input: unknown, fallback: number, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, input));
}

function resolveOptionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function getOneBotChannelConfig(apiOrCfg?: any): Record<string, any> {
  const cfg = getRootConfig(apiOrCfg);
  return cfg?.channels?.onebot ?? {};
}

export function getOneBotConfig(apiOrCfg?: any): OneBotAccountConfig | null {
  const channel = getOneBotChannelConfig(apiOrCfg);
  if (channel?.host && channel?.port) {
    return {
      accountId: "default",
      enabled: channel.enabled !== false,
      type: channel.type === "backward-websocket" ? "backward-websocket" : "forward-websocket",
      host: String(channel.host),
      port: Number(channel.port),
      accessToken: channel.accessToken ? String(channel.accessToken) : undefined,
      path: channel.path ? String(channel.path) : "/onebot/v11/ws"
    };
  }

  const host = process.env.ONEBOT_WS_HOST;
  const port = Number(process.env.ONEBOT_WS_PORT);
  if (host && Number.isFinite(port)) {
    return {
      accountId: "default",
      type: process.env.ONEBOT_WS_TYPE === "backward-websocket" ? "backward-websocket" : "forward-websocket",
      host,
      port,
      accessToken: process.env.ONEBOT_WS_ACCESS_TOKEN || undefined,
      path: process.env.ONEBOT_WS_PATH || "/onebot/v11/ws"
    };
  }

  return null;
}

export function listAccountIds(apiOrCfg?: any): string[] {
  return getOneBotConfig(apiOrCfg) ? ["default"] : [];
}

export function getRequireMention(apiOrCfg?: any): boolean {
  const channel = getOneBotChannelConfig(apiOrCfg);
  return channel.requireMention === undefined ? true : Boolean(channel.requireMention);
}

export function getRenderMarkdownToPlain(apiOrCfg?: any): boolean {
  const channel = getOneBotChannelConfig(apiOrCfg);
  return channel.renderMarkdownToPlain === undefined ? true : Boolean(channel.renderMarkdownToPlain);
}

export function getGroupIncreaseConfig(apiOrCfg?: any): {
  enabled: boolean;
  message?: string;
} {
  const channel = getOneBotChannelConfig(apiOrCfg);
  const groupIncrease = channel.groupIncrease ?? {};
  return {
    enabled: Boolean(groupIncrease.enabled),
    message: typeof groupIncrease.message === "string" ? groupIncrease.message : undefined
  };
}

export function getAsyncReplyConfig(apiOrCfg?: any): OneBotAsyncReplyConfig {
  const channel = getOneBotChannelConfig(apiOrCfg);
  const asyncReply = channel.asyncReply ?? {};
  const keywords = normalizeStringArray(asyncReply.keywords);
  const ai = asyncReply.ai ?? {};
  const apiKey = resolveOptionalString(
    ai.apiKey,
    process.env.ONEBOT_ASYNC_AI_API_KEY,
    process.env.MOONSHOT_API_KEY
  );
  const legacyModel = resolveOptionalString(ai.model, process.env.ONEBOT_ASYNC_AI_MODEL);

  return {
    enabled: asyncReply.enabled === undefined ? true : Boolean(asyncReply.enabled),
    keywords: keywords.length > 0 ? keywords : [...DEFAULT_ASYNC_REPLY_KEYWORDS],
    ackText: typeof asyncReply.ackText === "string" && asyncReply.ackText.trim()
      ? asyncReply.ackText.trim()
      : "收到啦，我先慢慢查一下喔，弄好后再回来认真跟你说。",
    recentMessages: resolvePositiveInteger(asyncReply.recentMessages, 6),
    contextCharLimit: resolvePositiveInteger(asyncReply.contextCharLimit, 1200),
    rawResultCharLimit: resolvePositiveInteger(asyncReply.rawResultCharLimit, 3200),
    ai: {
      enabled: ai.enabled === undefined ? true : Boolean(ai.enabled),
      apiKey,
      baseUrl: resolveOptionalString(ai.baseUrl, process.env.ONEBOT_ASYNC_AI_BASE_URL) ?? "https://api.moonshot.cn/v1",
      model: legacyModel,
      judgeModel: resolveOptionalString(
        ai.judgeModel,
        process.env.ONEBOT_ASYNC_AI_JUDGE_MODEL,
        legacyModel
      ) ?? "kimi-k2-turbo-preview",
      ackModel: resolveOptionalString(
        ai.ackModel,
        process.env.ONEBOT_ASYNC_AI_ACK_MODEL,
        legacyModel
      ) ?? "kimi-k2-turbo-preview",
      searchModel: resolveOptionalString(
        ai.searchModel,
        process.env.ONEBOT_ASYNC_AI_SEARCH_MODEL,
        legacyModel
      ) ?? "kimi-k2-turbo-preview",
      timeoutMs: resolvePositiveInteger(ai.timeoutMs, 3500),
      maxTokens: resolvePositiveInteger(ai.maxTokens, 48),
      temperature: resolveNumber(ai.temperature, 0.6, 0, 2),
      fallbackToKeywords: ai.fallbackToKeywords === undefined ? true : Boolean(ai.fallbackToKeywords)
    }
  };
}

import type { OneBotGroupSummaryAiConfig, OneBotGroupSummaryMethod } from "./config.js";

const SUMMARY_TIMEOUT_CAP_MS = 60000;
const SUMMARY_MAX_CHARS = 2000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveApiPath(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

function clipText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
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

function extractAssistantContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const value = item as { text?: string; type?: string };
    if ((value.type === undefined || value.type === "text") && typeof value.text === "string" && value.text.trim()) {
      parts.push(value.text.trim());
    }
  }
  return parts.join("\n").trim();
}

function shouldRetryWithoutThinking(status: number, responseText: string): boolean {
  if (status !== 400) {
    return false;
  }

  const normalized = responseText.toLowerCase();
  if (!normalized.includes("thinking")) {
    return false;
  }

  return ["unknown", "unsupported", "invalid", "unexpected", "not allowed", "not supported", "invalid_request_error"]
    .some((keyword) => normalized.includes(keyword));
}

function usesKimi25ThinkingConfig(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "kimi-k2.5" || normalized.startsWith("kimi-k2.5-");
}

function buildThinkingPayload(model: string, includeThinkingOff: boolean): Record<string, unknown> {
  if (!includeThinkingOff) {
    return {};
  }
  if (usesKimi25ThinkingConfig(model)) {
    return { thinking: { type: "disabled" } };
  }
  return { thinking: "off" };
}

function describeThinkingPayload(model: string, includeThinkingOff: boolean): string {
  if (!includeThinkingOff) {
    return "omitted";
  }
  return usesKimi25ThinkingConfig(model) ? "disabled-object" : "off-string";
}

function resolveMethodLabel(method: OneBotGroupSummaryMethod): string {
  switch (method) {
    case "focused-keywords":
      return "关键词聚焦总结";
    case "since-last-reply":
      return "自上次回复以来总结";
    default:
      return "最近消息总结";
  }
}

function buildSummarySystemPrompt(params: { groupName?: string; method: OneBotGroupSummaryMethod }): string {
  return [
    `你现在是一个中文群聊总结助手，正在处理${params.groupName ? `「${params.groupName}」` : "当前群聊"}的消息片段。`,
    `当前任务类型：${resolveMethodLabel(params.method)}。`,
    "",
    "请严格基于给定聊天记录输出总结，不要补充记录里没有的事实。",
    "要求：",
    "- 优先提炼核心话题、结论、待办、分歧、风险或决定",
    "- 能区分说话人时就保留名字/群昵称/QQ号信息",
    "- 如果是关键词聚焦模式，只总结与关键词直接相关的内容",
    "- 尽量写成紧凑的项目符号或短段落，便于直接发回群里",
    "- 不要解释你的推理过程，不要输出标题前缀如“总结如下”",
    `- 总长度尽量控制在 ${SUMMARY_MAX_CHARS} 字以内`
  ].join("\n");
}

function buildSummaryUserPrompt(params: {
  commandText: string;
  focusKeywords?: string[];
  requesterLabel: string;
  scopeLabel: string;
  transcriptText: string;
}): string {
  return [
    `请求者：${params.requesterLabel}`,
    `总结范围：${params.scopeLabel}`,
    `触发命令：${params.commandText}`,
    params.focusKeywords && params.focusKeywords.length > 0 ? `关注关键词：${params.focusKeywords.join("、")}` : "",
    "",
    "需要总结的群聊记录：",
    clipText(params.transcriptText, 12000) || "（空）",
    "",
    "请直接输出最终可发送的总结内容。"
  ].filter(Boolean).join("\n");
}

function buildRequestBody(params: {
  apiConfig: OneBotGroupSummaryAiConfig;
  commandText: string;
  focusKeywords?: string[];
  groupName?: string;
  includeThinkingOff: boolean;
  method: OneBotGroupSummaryMethod;
  requesterLabel: string;
  scopeLabel: string;
  transcriptText: string;
}): Record<string, unknown> {
  return {
    model: params.apiConfig.model,
    ...buildThinkingPayload(params.apiConfig.model, params.includeThinkingOff),
    temperature: params.apiConfig.temperature,
    max_tokens: params.apiConfig.maxTokens,
    messages: [
      {
        role: "system",
        content: buildSummarySystemPrompt({
          groupName: params.groupName,
          method: params.method,
        })
      },
      {
        role: "user",
        content: buildSummaryUserPrompt({
          commandText: params.commandText,
          focusKeywords: params.focusKeywords,
          requesterLabel: params.requesterLabel,
          scopeLabel: params.scopeLabel,
          transcriptText: params.transcriptText,
        })
      }
    ]
  };
}

async function requestSummaryText(params: {
  apiConfig: OneBotGroupSummaryAiConfig;
  commandText: string;
  focusKeywords?: string[];
  groupName?: string;
  includeThinkingOff: boolean;
  method: OneBotGroupSummaryMethod;
  requesterLabel: string;
  scopeLabel: string;
  signal: AbortSignal;
  transcriptText: string;
}): Promise<{ retryWithoutThinking?: boolean; text?: string; data?: { choices?: Array<{ message?: { content?: unknown } }> } }> {
  const response = await fetch(resolveApiPath(params.apiConfig.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiConfig.apiKey}`
    },
    body: JSON.stringify(buildRequestBody(params)),
    signal: params.signal
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      retryWithoutThinking: params.includeThinkingOff
        && !usesKimi25ThinkingConfig(params.apiConfig.model)
        && shouldRetryWithoutThinking(response.status, text),
      text: `HTTP ${response.status} ${text.slice(0, 180)}`
    };
  }

  return {
    data: await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
  };
}

export function canUseGroupSummaryAi(config: OneBotGroupSummaryAiConfig): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!config.apiKey?.trim()) {
    return false;
  }
  if (!config.model.trim()) {
    return false;
  }
  if (/thinking/i.test(config.model)) {
    return false;
  }
  return true;
}

export async function generateGroupSummaryWithAi(params: {
  apiConfig: OneBotGroupSummaryAiConfig;
  commandText: string;
  focusKeywords?: string[];
  groupName?: string;
  logger?: { info?: (value: string) => void; warn?: (value: string) => void };
  method: OneBotGroupSummaryMethod;
  requesterLabel: string;
  scopeLabel: string;
  transcriptText: string;
}): Promise<string> {
  const preview = previewTextForLog(params.transcriptText);
  if (!canUseGroupSummaryAi(params.apiConfig)) {
    throw new Error("群总结 AI 未启用或缺少有效配置");
  }

  const timeoutMs = Math.min(params.apiConfig.timeoutMs, SUMMARY_TIMEOUT_CAP_MS);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  timer.unref?.();

  try {
    const thinkingMode = describeThinkingPayload(params.apiConfig.model, true);
    params.logger?.info?.(`[onebot] group summary ai request model=${params.apiConfig.model} timeoutMs=${timeoutMs} thinking=${thinkingMode} preview=${JSON.stringify(preview)}`);

    let result = await requestSummaryText({
      ...params,
      includeThinkingOff: true,
      signal: abortController.signal
    });

    if (result.retryWithoutThinking) {
      params.logger?.warn?.(`[onebot] group summary ai rejected thinking=${thinkingMode}; retrying without thinking field`);
      result = await requestSummaryText({
        ...params,
        includeThinkingOff: false,
        signal: abortController.signal
      });
    }

    if (!result.data) {
      throw new Error(result.text || "群总结 AI 请求失败");
    }

    const rawText = extractAssistantContent(result.data.choices?.[0]?.message?.content);
    const normalized = clipText(rawText.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/, "").trim(), SUMMARY_MAX_CHARS);
    if (!normalized) {
      throw new Error("群总结 AI 返回了空结果");
    }

    params.logger?.info?.(`[onebot] group summary ai generated text=${JSON.stringify(previewTextForLog(normalized, 72))}`);
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}

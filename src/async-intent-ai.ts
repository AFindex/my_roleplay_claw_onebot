import type { OneBotAsyncReplyAiConfig } from "./config.js";

export interface AsyncIntentAiDecision {
  confidence?: number;
  reason?: string;
  shouldAsync: boolean;
}

function clampConfidence(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, input));
}

function clipText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch?.[1]?.trim() || trimmed;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function buildClassifierSystemPrompt(): string {
  return [
    "你是一个对话路由分类器。",
    "你的唯一任务是判断：这条用户消息，是否更适合交给后台异步任务处理。",
    "",
    "判定为 true 的常见情况：",
    "- 明显需要搜索、查资料、调研、总结、归纳、对比、分析",
    "- 明显需要写方案、写文档、写代码、生成较长内容",
    "- 明显是多步骤、耗时更长、结果不适合立刻一句话答完的请求",
    "",
    "判定为 false 的常见情况：",
    "- 打招呼、闲聊、情绪回应、简单陪伴式对话",
    "- 短问短答、简单解释、简单角色扮演回复",
    "- 预计可以直接自然回复、不需要后台慢慢处理的内容",
    "",
    "如果拿不准，倾向返回 false。",
    "只输出严格 JSON，不要输出任何额外文字。",
    "格式：{\"async\":true|false,\"confidence\":0到1之间的小数,\"reason\":\"不超过18字\"}"
  ].join("\n");
}

function buildClassifierUserPrompt(params: {
  chatType: "group" | "direct";
  fullMessageText: string;
  triggerText: string;
}): string {
  return [
    `聊天类型：${params.chatType === "group" ? "群聊" : "私聊"}`,
    "",
    "用户消息（原始整理后全文）：",
    clipText(params.fullMessageText, 1800) || "（空）",
    "",
    "用户当前输入主体：",
    clipText(params.triggerText, 1000) || "（空）"
  ].join("\n");
}

function resolveApiPath(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
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

function buildRequestBody(params: {
  apiConfig: OneBotAsyncReplyAiConfig;
  chatType: "group" | "direct";
  fullMessageText: string;
  includeThinkingOff: boolean;
  triggerText: string;
}): Record<string, unknown> {
  return {
    model: params.apiConfig.judgeModel,
    ...(params.includeThinkingOff ? { thinking: "off" } : {}),
    temperature: params.apiConfig.temperature,
    max_tokens: params.apiConfig.maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildClassifierSystemPrompt() },
      {
        role: "user",
        content: buildClassifierUserPrompt({
          chatType: params.chatType,
          fullMessageText: params.fullMessageText,
          triggerText: params.triggerText
        })
      }
    ]
  };
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

async function requestClassifier(params: {
  apiConfig: OneBotAsyncReplyAiConfig;
  chatType: "group" | "direct";
  fullMessageText: string;
  includeThinkingOff: boolean;
  signal: AbortSignal;
  triggerText: string;
}): Promise<{ data?: { choices?: Array<{ message?: { content?: unknown } }> }; retryWithoutThinking?: boolean; text?: string; }> {
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
      retryWithoutThinking: params.includeThinkingOff && shouldRetryWithoutThinking(response.status, text),
      text: `HTTP ${response.status} ${text.slice(0, 180)}`
    };
  }

  return {
    data: await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
  };
}

export function canUseAsyncIntentAi(config: OneBotAsyncReplyAiConfig): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!config.apiKey?.trim()) {
    return false;
  }
  if (!config.judgeModel.trim()) {
    return false;
  }
  if (/thinking/i.test(config.judgeModel)) {
    return false;
  }
  return true;
}

export async function classifyAsyncIntentWithAi(params: {
  apiConfig: OneBotAsyncReplyAiConfig;
  chatType: "group" | "direct";
  fullMessageText: string;
  logger?: { info?: (value: string) => void; warn?: (value: string) => void };
  triggerText: string;
}): Promise<AsyncIntentAiDecision | null> {
  const preview = previewTextForLog(params.triggerText || params.fullMessageText);
  if (!canUseAsyncIntentAi(params.apiConfig)) {
    if (!params.apiConfig.enabled) {
      params.logger?.info?.(`[onebot] async ai classifier skipped enabled=false preview=${JSON.stringify(preview)}`);
    } else if (!params.apiConfig.apiKey?.trim()) {
      params.logger?.warn?.(`[onebot] async ai classifier skipped missing apiKey preview=${JSON.stringify(preview)}`);
    } else if (!params.apiConfig.judgeModel.trim()) {
      params.logger?.warn?.(`[onebot] async ai classifier skipped missing judgeModel preview=${JSON.stringify(preview)}`);
    } else if (/thinking/i.test(params.apiConfig.judgeModel)) {
      params.logger?.warn?.(`[onebot] async ai classifier model should be non-thinking; falling back judgeModel=${params.apiConfig.judgeModel} preview=${JSON.stringify(preview)}`);
    }
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.apiConfig.timeoutMs);

  try {
    params.logger?.info?.(`[onebot] async ai classifier request judgeModel=${params.apiConfig.judgeModel} timeoutMs=${params.apiConfig.timeoutMs} thinking=off preview=${JSON.stringify(preview)}`);
    let result = await requestClassifier({
      apiConfig: params.apiConfig,
      chatType: params.chatType,
      fullMessageText: params.fullMessageText,
      includeThinkingOff: true,
      signal: controller.signal,
      triggerText: params.triggerText
    });

    if (result.retryWithoutThinking) {
      params.logger?.warn?.("[onebot] async ai classifier rejected `thinking: off`; retrying without thinking field");
      result = await requestClassifier({
        apiConfig: params.apiConfig,
        chatType: params.chatType,
        fullMessageText: params.fullMessageText,
        includeThinkingOff: false,
        signal: controller.signal,
        triggerText: params.triggerText
      });
    }

    if (!result.data) {
      params.logger?.warn?.(`[onebot] async ai classifier failed: ${result.text ?? "unknown error"} preview=${JSON.stringify(preview)}`);
      return null;
    }

    const rawContent = extractAssistantContent(result.data.choices?.[0]?.message?.content);
    const parsed = parseJsonObject(rawContent);
    if (!parsed) {
      params.logger?.warn?.(`[onebot] async ai classifier returned non-json content preview=${JSON.stringify(preview)}`);
      return null;
    }

    const decision = {
      shouldAsync: Boolean(parsed.async),
      confidence: clampConfidence(parsed.confidence),
      reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 32) : undefined
    };
    params.logger?.info?.(`[onebot] async ai classifier decision async=${decision.shouldAsync}${typeof decision.confidence === "number" ? ` confidence=${decision.confidence.toFixed(2)}` : ""}${decision.reason ? ` reason=${decision.reason}` : ""} preview=${JSON.stringify(preview)}`);
    return decision;
  } catch (error) {
    params.logger?.warn?.(`[onebot] async ai classifier error: ${error instanceof Error ? error.message : String(error)} preview=${JSON.stringify(preview)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

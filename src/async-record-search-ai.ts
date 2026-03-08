import type { AsyncTaskRecord } from "./async-task-records.js";
import type { OneBotAsyncReplyAiConfig } from "./config.js";

export interface AsyncTaskRecordMatchDecision {
  confidence?: number;
  matched: boolean;
  reason?: string;
  recordId?: string;
}

const SEARCH_FALLBACK_PATTERN = /(异步|任务|刚才|之前|那个|这次|进度|结果|完成|好了没|好了么|查得|查好|回来了|搞定|失败|报错|状态)/i;
const SEARCH_MAX_RECORDS = 10;
const SEARCH_MAX_RECORD_PREVIEW = 220;

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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveApiPath(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
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

function clampConfidence(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, input));
}

function buildSearchSystemPrompt(): string {
  return [
    "你是一个异步任务记录匹配器。",
    "你的唯一任务是：判断当前用户这句话，是否在追问同一会话里某个历史异步任务。",
    "",
    "如果匹配：返回最合适的一个 recordId。",
    "如果不匹配或拿不准：返回 matched=false。",
    "",
    "优先匹配这些情况：",
    "- 用户在问‘刚才/之前/那个/这次’异步任务的进度、结果、状态",
    "- 用户在追问某个已经受理、进行中、已完成或失败的后台任务",
    "",
    "不要误匹配普通闲聊、全新问题、或与候选任务明显无关的话。",
    "如果拿不准，宁可返回 matched=false。",
    "只输出严格 JSON，不要输出任何额外文字。",
    "格式：{\"matched\":true|false,\"recordId\":\"候选id或空字符串\",\"confidence\":0到1之间的小数,\"reason\":\"不超过18字\"}"
  ].join("\n");
}

function simplifyRecord(record: AsyncTaskRecord): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    originalRequest: clipText(record.originalRequestText, SEARCH_MAX_RECORD_PREVIEW),
    taskBody: clipText(record.taskMessageText, SEARCH_MAX_RECORD_PREVIEW),
    ackText: record.ackText ? clipText(record.ackText, 120) : undefined,
    finalReplyText: record.finalReplyText ? clipText(record.finalReplyText, SEARCH_MAX_RECORD_PREVIEW) : undefined,
    errorText: record.errorText ? clipText(record.errorText, 160) : undefined,
    note: record.note
  };
}

function buildSearchUserPrompt(params: {
  messageText: string;
  records: AsyncTaskRecord[];
}): string {
  const candidates = params.records.slice(0, SEARCH_MAX_RECORDS).map(simplifyRecord);
  return [
    "当前用户消息：",
    clipText(params.messageText, 1200) || "（空）",
    "",
    "候选异步任务记录：",
    "```json",
    JSON.stringify(candidates, null, 2),
    "```",
    "",
    "请只返回 JSON。"
  ].join("\n");
}

function buildRequestBody(params: {
  apiConfig: OneBotAsyncReplyAiConfig;
  includeThinkingOff: boolean;
  messageText: string;
  records: AsyncTaskRecord[];
}): Record<string, unknown> {
  return {
    model: params.apiConfig.searchModel,
    ...(params.includeThinkingOff ? { thinking: "off" } : {}),
    temperature: params.apiConfig.temperature,
    max_tokens: Math.max(64, Math.min(180, params.apiConfig.maxTokens)),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSearchSystemPrompt() },
      {
        role: "user",
        content: buildSearchUserPrompt({
          messageText: params.messageText,
          records: params.records
        })
      }
    ]
  };
}

async function requestMatcher(params: {
  apiConfig: OneBotAsyncReplyAiConfig;
  includeThinkingOff: boolean;
  messageText: string;
  records: AsyncTaskRecord[];
  signal: AbortSignal;
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

function fallbackMatch(messageText: string, records: AsyncTaskRecord[]): AsyncTaskRecordMatchDecision {
  if (records.length === 0) {
    return { matched: false, reason: "no_records" };
  }

  const normalizedMessage = messageText.trim().toLowerCase();
  if (!normalizedMessage) {
    return { matched: false, reason: "empty_message" };
  }

  const activeRecords = records.filter((item) => item.status === "accepted" || item.status === "running");
  if (activeRecords.length === 1 && SEARCH_FALLBACK_PATTERN.test(normalizedMessage)) {
    return {
      matched: true,
      recordId: activeRecords[0].id,
      confidence: 0.58,
      reason: "single_active_fallback"
    };
  }

  return { matched: false, reason: "fallback_none" };
}

export async function matchAsyncTaskRecordWithAi(params: {
  apiConfig: OneBotAsyncReplyAiConfig;
  logger?: { info?: (value: string) => void; warn?: (value: string) => void };
  messageText: string;
  records: AsyncTaskRecord[];
}): Promise<AsyncTaskRecordMatchDecision> {
  const preview = previewTextForLog(params.messageText);
  const records = params.records.slice(0, SEARCH_MAX_RECORDS);
  if (records.length === 0) {
    return { matched: false, reason: "no_records" };
  }

  if (!params.apiConfig.enabled || !params.apiConfig.apiKey?.trim() || !params.apiConfig.searchModel.trim()) {
    const fallback = fallbackMatch(params.messageText, records);
    params.logger?.info?.(`[onebot] async record search fallback matched=${String(fallback.matched)} preview=${JSON.stringify(preview)}`);
    return fallback;
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(params.apiConfig.timeoutMs, 3500);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    params.logger?.info?.(`[onebot] async record search request searchModel=${params.apiConfig.searchModel} candidates=${records.length} timeoutMs=${timeoutMs} thinking=off preview=${JSON.stringify(preview)}`);
    let result = await requestMatcher({
      apiConfig: params.apiConfig,
      includeThinkingOff: true,
      messageText: params.messageText,
      records,
      signal: controller.signal
    });

    if (result.retryWithoutThinking) {
      params.logger?.warn?.("[onebot] async record search rejected `thinking: off`; retrying without thinking field");
      result = await requestMatcher({
        apiConfig: params.apiConfig,
        includeThinkingOff: false,
        messageText: params.messageText,
        records,
        signal: controller.signal
      });
    }

    const raw = extractAssistantContent(result.data?.choices?.[0]?.message?.content);
    const parsed = parseJsonObject(raw);
    const matched = parsed?.matched === true;
    const recordId = typeof parsed?.recordId === "string" ? parsed.recordId.trim() : "";
    const confidence = clampConfidence(parsed?.confidence);
    const reason = typeof parsed?.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined;

    if (!matched) {
      params.logger?.info?.(`[onebot] async record search matched=false reason=${reason ?? "none"} preview=${JSON.stringify(preview)}`);
      return { matched: false, confidence, reason };
    }

    if (!recordId || !records.some((item) => item.id === recordId)) {
      const fallback = fallbackMatch(params.messageText, records);
      params.logger?.warn?.(`[onebot] async record search invalid recordId=${JSON.stringify(recordId)} fallbackMatched=${String(fallback.matched)} preview=${JSON.stringify(preview)}`);
      return fallback;
    }

    params.logger?.info?.(`[onebot] async record search matched=true recordId=${recordId} confidence=${typeof confidence === "number" ? confidence.toFixed(2) : "n/a"} reason=${reason ?? "none"} preview=${JSON.stringify(preview)}`);
    return {
      matched: true,
      recordId,
      confidence,
      reason
    };
  } catch (error) {
    params.logger?.warn?.(`[onebot] async record search error: ${error instanceof Error ? error.message : String(error)} preview=${JSON.stringify(preview)}`);
    return fallbackMatch(params.messageText, records);
  } finally {
    clearTimeout(timeout);
  }
}

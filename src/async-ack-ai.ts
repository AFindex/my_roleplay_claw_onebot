import type { OneBotAsyncReplyAiConfig } from "./config.js";

const ACK_MAX_CHARS = 60;
const ACK_MAX_TOKENS_CAP = 80;
const ACK_MAX_TOKENS_FLOOR = 24;
const ACK_TIMEOUT_CAP_MS = 4500;

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

function buildAckSystemPrompt(params: { agentName?: string; personaPrompt: string }): string {
  return [
    `你现在要扮演${params.agentName ? `「${params.agentName}」` : "当前角色"}，并严格维持下面的人设气质：`,
    params.personaPrompt || "请自然、口语化、轻盈地回应。",
    "",
    "你现在只需要生成一条‘收到任务后的即时短回复’。",
    "要求：",
    "- 语气自然，像同一个角色刚看到消息后的第一反应",
    "- 明确表达：已经收到，会去处理，稍后再回来回复",
    "- 简短一点，避免太正式，避免条目化",
    "- 不要复述完整需求，不要分析，不要承诺做不到的事",
    "- 不要使用引号、代码块、前缀标签",
    `- 总长度尽量不超过${ACK_MAX_CHARS}个中文字符`
  ].join("\n");
}

function buildAckUserPrompt(params: {
  chatType: "group" | "direct";
  triggerReason?: string;
  userRequestText: string;
}): string {
  return [
    `聊天类型：${params.chatType === "group" ? "群聊" : "私聊"}`,
    params.triggerReason ? `触发原因：${params.triggerReason}` : "",
    "",
    "用户刚刚的请求：",
    clipText(params.userRequestText, 600) || "（空）",
    "",
    "请直接给出一条角色口吻的即时短回复。"
  ].filter(Boolean).join("\n");
}

function normalizeAckText(raw: string): string {
  const normalized = raw
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return clipText(normalized, ACK_MAX_CHARS);
}

async function requestAckText(params: {
  apiConfig: OneBotAsyncReplyAiConfig;
  chatType: "group" | "direct";
  includeThinkingOff: boolean;
  personaPrompt: string;
  signal: AbortSignal;
  triggerReason?: string;
  userRequestText: string;
  agentName?: string;
}): Promise<{ retryWithoutThinking?: boolean; text?: string; error?: string }> {
  const response = await fetch(resolveApiPath(params.apiConfig.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiConfig.apiKey}`
    },
    body: JSON.stringify({
      model: params.apiConfig.ackModel,
      ...(params.includeThinkingOff ? { thinking: "off" } : {}),
      temperature: params.apiConfig.temperature,
      max_tokens: Math.max(ACK_MAX_TOKENS_FLOOR, Math.min(ACK_MAX_TOKENS_CAP, params.apiConfig.maxTokens)),
      messages: [
        {
          role: "system",
          content: buildAckSystemPrompt({
            agentName: params.agentName,
            personaPrompt: params.personaPrompt
          })
        },
        {
          role: "user",
          content: buildAckUserPrompt({
            chatType: params.chatType,
            triggerReason: params.triggerReason,
            userRequestText: params.userRequestText
          })
        }
      ]
    }),
    signal: params.signal
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      retryWithoutThinking: params.includeThinkingOff && shouldRetryWithoutThinking(response.status, text),
      error: `HTTP ${response.status} ${text.slice(0, 180)}`
    };
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const rawText = extractAssistantContent(data.choices?.[0]?.message?.content);
  return { text: rawText };
}

export async function generateAsyncAckWithAi(params: {
  apiConfig: OneBotAsyncReplyAiConfig;
  agentName?: string;
  chatType: "group" | "direct";
  fallbackText: string;
  logger?: { info?: (value: string) => void; warn?: (value: string) => void };
  personaPrompt: string;
  triggerReason?: string;
  userRequestText: string;
}): Promise<string> {
  const preview = previewTextForLog(params.userRequestText);
  if (!params.apiConfig.enabled || !params.apiConfig.apiKey?.trim() || !params.apiConfig.ackModel.trim()) {
    params.logger?.info?.(`[onebot] async ack ai skipped fallback=fixed preview=${JSON.stringify(preview)}`);
    return params.fallbackText;
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(params.apiConfig.timeoutMs, ACK_TIMEOUT_CAP_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    params.logger?.info?.(`[onebot] async ack ai request ackModel=${params.apiConfig.ackModel} timeoutMs=${timeoutMs} thinking=off preview=${JSON.stringify(preview)}`);
    let result = await requestAckText({
      agentName: params.agentName,
      apiConfig: params.apiConfig,
      chatType: params.chatType,
      includeThinkingOff: true,
      personaPrompt: params.personaPrompt,
      signal: controller.signal,
      triggerReason: params.triggerReason,
      userRequestText: params.userRequestText
    });

    if (result.retryWithoutThinking) {
      params.logger?.warn?.("[onebot] async ack ai rejected `thinking: off`; retrying without thinking field");
      result = await requestAckText({
        agentName: params.agentName,
        apiConfig: params.apiConfig,
        chatType: params.chatType,
        includeThinkingOff: false,
        personaPrompt: params.personaPrompt,
        signal: controller.signal,
        triggerReason: params.triggerReason,
        userRequestText: params.userRequestText
      });
    }

    const normalized = normalizeAckText(result.text ?? "");
    if (!normalized) {
      params.logger?.warn?.(`[onebot] async ack ai fallback=fixed reason=${result.error ?? "empty_text"} preview=${JSON.stringify(preview)}`);
      return params.fallbackText;
    }

    params.logger?.info?.(`[onebot] async ack ai generated text=${JSON.stringify(previewTextForLog(normalized, 72))} preview=${JSON.stringify(preview)}`);
    return normalized;
  } catch (error) {
    params.logger?.warn?.(`[onebot] async ack ai error: ${error instanceof Error ? error.message : String(error)} preview=${JSON.stringify(preview)}`);
    return params.fallbackText;
  } finally {
    clearTimeout(timeout);
  }
}

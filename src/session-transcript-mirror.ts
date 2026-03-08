import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CURRENT_SESSION_VERSION = 3;

type TranscriptRole = "assistant" | "user";

type SessionEntry = {
  sessionFile?: string;
  sessionId?: string;
};

type Logger = {
  warn?: (value: string) => void;
};

function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    }
  };
}

function loadSessionStore(storePath: string): Record<string, SessionEntry> {
  if (!storePath || !existsSync(storePath)) {
    return {};
  }

  try {
    const raw = readFileSync(storePath, "utf8").trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, SessionEntry>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function findSessionEntry(store: Record<string, SessionEntry>, sessionKey: string): SessionEntry | undefined {
  if (store[sessionKey]) {
    return store[sessionKey];
  }

  const lowered = sessionKey.trim().toLowerCase();
  for (const [key, value] of Object.entries(store)) {
    if (key.trim().toLowerCase() === lowered) {
      return value;
    }
  }
  return undefined;
}

function resolveTranscriptPath(storePath: string, sessionKey: string): { sessionFile: string; sessionId: string } | null {
  const store = loadSessionStore(storePath);
  const entry = findSessionEntry(store, sessionKey);
  const sessionId = entry?.sessionId?.trim();
  if (!sessionId) {
    return null;
  }

  const explicitFile = entry?.sessionFile?.trim();
  if (explicitFile) {
    return { sessionFile: explicitFile, sessionId };
  }

  return {
    sessionFile: path.join(path.dirname(storePath), `${sessionId}.jsonl`),
    sessionId
  };
}

function ensureHeader(sessionFile: string, sessionId: string): void {
  if (existsSync(sessionFile)) {
    return;
  }

  mkdirSync(path.dirname(sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd()
  };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
}

function resolveLeafId(sessionFile: string): string | null {
  if (!existsSync(sessionFile)) {
    return null;
  }

  const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as { id?: string; type?: string };
      if (parsed.type === "session") {
        return null;
      }
      if (typeof parsed.id === "string" && parsed.id.trim()) {
        return parsed.id.trim();
      }
    } catch {
      continue;
    }
  }

  return null;
}

function normalizeContentFromBody(body: unknown, fallbackText: string): Array<Record<string, unknown>> {
  if (body && typeof body === "object") {
    const content = (body as { content?: unknown }).content;
    if (Array.isArray(content) && content.length > 0) {
      return content.filter((item) => Boolean(item && typeof item === "object")) as Array<Record<string, unknown>>;
    }
  }

  if (typeof body === "string" && body.trim()) {
    return [{ type: "text", text: body.trim() }];
  }

  return [{ type: "text", text: fallbackText.trim() }];
}

function buildMediaMirrorText(mediaUrls?: string[]): string | undefined {
  const count = Array.isArray(mediaUrls)
    ? mediaUrls.filter((item) => typeof item === "string" && item.trim()).length
    : 0;
  if (count <= 0) {
    return undefined;
  }
  return count > 1 ? `（发送了 ${count} 个媒体）` : "（发送了 1 个媒体）";
}

function buildAssistantContent(params: { mediaUrls?: string[]; text?: string }): Array<Record<string, unknown>> | null {
  const text = params.text?.trim();
  if (text) {
    return [{ type: "text", text }];
  }

  const mediaText = buildMediaMirrorText(params.mediaUrls);
  if (!mediaText) {
    return null;
  }
  return [{ type: "text", text: mediaText }];
}

export function appendSessionUserMessage(params: {
  body: unknown;
  fallbackText: string;
  logger?: Logger;
  sessionKey: string;
  storePath: string;
  timestampMs?: number;
}): { ok: boolean; reason?: string; sessionFile?: string } {
  const resolved = resolveTranscriptPath(params.storePath, params.sessionKey);
  if (!resolved) {
    params.logger?.warn?.(`[onebot] appendSessionUserMessage skipped unknown sessionKey=${params.sessionKey}`);
    return { ok: false, reason: "unknown session" };
  }

  try {
    ensureHeader(resolved.sessionFile, resolved.sessionId);
    const entry = {
      type: "message",
      id: randomUUID().slice(0, 8),
      parentId: resolveLeafId(resolved.sessionFile),
      timestamp: new Date(params.timestampMs ?? Date.now()).toISOString(),
      message: {
        role: "user" as const,
        content: normalizeContentFromBody(params.body, params.fallbackText),
        timestamp: params.timestampMs ?? Date.now()
      }
    };
    appendFileSync(resolved.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
    return { ok: true, sessionFile: resolved.sessionFile };
  } catch (error) {
    params.logger?.warn?.(`[onebot] appendSessionUserMessage failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function appendSessionAssistantMessage(params: {
  logger?: Logger;
  mediaUrls?: string[];
  model?: string;
  sessionKey: string;
  storePath: string;
  text?: string;
  timestampMs?: number;
}): { ok: boolean; reason?: string; sessionFile?: string } {
  const resolved = resolveTranscriptPath(params.storePath, params.sessionKey);
  if (!resolved) {
    params.logger?.warn?.(`[onebot] appendSessionAssistantMessage skipped unknown sessionKey=${params.sessionKey}`);
    return { ok: false, reason: "unknown session" };
  }

  const content = buildAssistantContent({
    mediaUrls: params.mediaUrls,
    text: params.text
  });
  if (!content) {
    return { ok: false, reason: "empty content" };
  }

  try {
    ensureHeader(resolved.sessionFile, resolved.sessionId);
    const now = params.timestampMs ?? Date.now();
    const entry = {
      type: "message",
      id: randomUUID().slice(0, 8),
      parentId: resolveLeafId(resolved.sessionFile),
      timestamp: new Date(now).toISOString(),
      message: {
        role: "assistant" as TranscriptRole,
        content,
        api: "openai-responses",
        provider: "openclaw",
        model: params.model?.trim() || "onebot-async-mirror",
        usage: createZeroUsage(),
        stopReason: "stop",
        timestamp: now
      }
    };
    appendFileSync(resolved.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
    return { ok: true, sessionFile: resolved.sessionFile };
  } catch (error) {
    params.logger?.warn?.(`[onebot] appendSessionAssistantMessage failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

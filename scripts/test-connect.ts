import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECT_TIMEOUT_MS = 10000;
const ENV_FILES = [resolve(__dirname, "../.env"), resolve(__dirname, "../../.env")];
const OPENCLAW_CONFIG_FILES = [
  resolve(process.env.HOME || "", ".openclaw/openclaw.json"),
  resolve(process.env.HOME || "", ".openclaw-onebot-dev/openclaw.json")
];

const loadedEnvKeys = new Set<string>();
let loadedEnvFile: string | null = null;
let loadedOpenClawConfig: string | null = null;
let openClawConfigSkippedBecauseEnv = false;
let loadedOpenClawAccessToken = false;

function loadEnvFile(): void {
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    loadedEnvFile = file;
    const content = readFileSync(file, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (!match) continue;
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = value;
        loadedEnvKeys.add(key);
      }
    }
    break;
  }
}

function loadOpenClawConfig(): void {
  if (process.env.ONEBOT_WS_HOST && process.env.ONEBOT_WS_PORT) {
    openClawConfigSkippedBecauseEnv = true;
    return;
  }
  for (const file of OPENCLAW_CONFIG_FILES) {
    if (!existsSync(file)) continue;
    try {
      const config = JSON.parse(readFileSync(file, "utf-8"));
      const onebot = config?.channels?.onebot;
      if (!onebot?.host || !onebot?.port) continue;
      process.env.ONEBOT_WS_TYPE ||= String(onebot.type || "forward-websocket");
      process.env.ONEBOT_WS_HOST ||= String(onebot.host);
      process.env.ONEBOT_WS_PORT ||= String(onebot.port);
      process.env.ONEBOT_WS_PATH ||= String(onebot.path || "/onebot/v11/ws");
      if (onebot.accessToken) {
        const shouldUseOpenClawAccessToken = !process.env.ONEBOT_WS_ACCESS_TOKEN;
        process.env.ONEBOT_WS_ACCESS_TOKEN ||= String(onebot.accessToken);
        loadedOpenClawAccessToken = shouldUseOpenClawAccessToken;
      }
      loadedOpenClawConfig = file;
      break;
    } catch {
      continue;
    }
  }
}

function resolveConfigSource(): string {
  if (loadedOpenClawConfig) {
    return `openclaw:${loadedOpenClawConfig}`;
  }
  if (
    loadedEnvKeys.has("ONEBOT_WS_HOST")
    || loadedEnvKeys.has("ONEBOT_WS_PORT")
    || loadedEnvKeys.has("ONEBOT_WS_PATH")
    || loadedEnvKeys.has("ONEBOT_WS_TYPE")
    || loadedEnvKeys.has("ONEBOT_WS_ACCESS_TOKEN")
  ) {
    return `dotenv:${loadedEnvFile}`;
  }
  if (
    process.env.ONEBOT_WS_HOST
    || process.env.ONEBOT_WS_PORT
    || process.env.ONEBOT_WS_PATH
    || process.env.ONEBOT_WS_TYPE
    || process.env.ONEBOT_WS_ACCESS_TOKEN
  ) {
    return "process.env";
  }
  return "defaults";
}

function resolveAccessTokenSource(): string {
  if (loadedOpenClawConfig && loadedOpenClawAccessToken) {
    return `openclaw:${loadedOpenClawConfig}`;
  }
  if (loadedEnvKeys.has("ONEBOT_WS_ACCESS_TOKEN")) {
    return `dotenv:${loadedEnvFile}`;
  }
  if (process.env.ONEBOT_WS_ACCESS_TOKEN) {
    return "process.env";
  }
  return "unset";
}

function socketStateName(state: number): string {
  switch (state) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return `UNKNOWN(${state})`;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return String(error);
}

function previewData(data: WebSocket.RawData, limit = 400): string {
  const buffer = typeof data === "string"
    ? Buffer.from(data)
    : Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data.map((item) => Buffer.isBuffer(item) ? item : Buffer.from(item)))
        : Buffer.from(data);
  const text = buffer.toString("utf-8").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

loadEnvFile();
loadOpenClawConfig();

const host = process.env.ONEBOT_WS_HOST || "127.0.0.1";
const port = process.env.ONEBOT_WS_PORT || "3001";
const path = process.env.ONEBOT_WS_PATH || "/onebot/v11/ws";
const type = process.env.ONEBOT_WS_TYPE || "forward-websocket";
const token = process.env.ONEBOT_WS_ACCESS_TOKEN;
const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
const url = `ws://${host}:${port}${path}`;

const configSummary = {
  source: resolveConfigSource(),
  envFile: loadedEnvFile ?? undefined,
  openClawConfig: loadedOpenClawConfig ?? undefined,
  openClawConfigSkippedBecauseEnv,
  type,
  host,
  port,
  path,
  url,
  hasAccessToken: Boolean(token),
  accessToken: token,
  accessTokenSource: resolveAccessTokenSource(),
  timeoutMs: CONNECT_TIMEOUT_MS
};

console.log("[OneBot Test] starting", configSummary);

const socket = new WebSocket(url, { headers });

let settled = false;
let echo: string | null = null;
let openedAt = 0;
let lastMessageAt = 0;
let lastMessagePreview = "";
let responseTimeout: ReturnType<typeof setTimeout> | null = null;
let closeInfo: { code: number; reason: string; state: string } | null = null;

function runtimeContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    echo,
    socketState: socketStateName(socket.readyState),
    elapsedMs: openedAt ? now - openedAt : undefined,
    lastMessageAgoMs: lastMessageAt ? now - lastMessageAt : undefined,
    lastMessagePreview: lastMessagePreview || undefined,
    closeInfo: closeInfo ?? undefined,
    config: configSummary,
    ...extra
  };
}

function fail(message: string, extra: Record<string, unknown> = {}): void {
  if (settled) return;
  settled = true;
  if (responseTimeout) {
    clearTimeout(responseTimeout);
  }
  console.error(`[OneBot Test] ${message}`, runtimeContext(extra));
  process.exit(1);
}

socket.on("open", () => {
  openedAt = Date.now();
  echo = `test-${openedAt}`;
  console.log("[OneBot Test] transport open", runtimeContext({ action: "get_login_info" }));
  socket.send(JSON.stringify({ action: "get_login_info", params: {}, echo }));
  console.log("[OneBot Test] action sent", runtimeContext({ action: "get_login_info" }));

  responseTimeout = setTimeout(() => {
    fail("timeout", { action: "get_login_info" });
  }, CONNECT_TIMEOUT_MS);
});

socket.on("error", (error) => {
  fail("socket error", { error: formatError(error) });
});

socket.on("unexpected-response", (_request, response) => {
  fail("unexpected handshake response", {
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    headers: response.headers
  });
});

socket.on("close", (code, reason) => {
  closeInfo = {
    code,
    reason: reason.toString("utf-8") || "",
    state: socketStateName(socket.readyState)
  };
  if (!settled) {
    fail("socket closed before response");
    return;
  }
  console.log("[OneBot Test] socket closed", runtimeContext());
});

socket.on("message", (data) => {
  lastMessageAt = Date.now();
  lastMessagePreview = previewData(data);
  try {
    const payload = JSON.parse(data.toString());
    const isActionResponse = payload && typeof payload === "object" && payload.post_type == null && ("retcode" in payload || "status" in payload);
    if (payload.echo !== echo) {
      if (isActionResponse) {
        fail(payload.retcode === 0 ? "response echo mismatch" : "action failed without expected echo", { payload });
        return;
      }
      console.log("[OneBot Test] ignored non-target message", runtimeContext({
        payloadEcho: payload.echo,
        postType: payload.post_type
      }));
      return;
    }
    if (responseTimeout) {
      clearTimeout(responseTimeout);
    }
    if (payload.retcode === 0) {
      settled = true;
      console.log("[OneBot Test] connected", runtimeContext({ loginInfo: payload.data }));
      process.exit(0);
    }
    fail("unexpected response", { payload });
  } catch (error) {
    fail("parse failed", { error: formatError(error) });
  }
});

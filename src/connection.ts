import { createServer } from "node:http";
import http from "node:http";
import https from "node:https";
import { copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import type { OneBotAccountConfig, OneBotMessageSegment } from "./types.js";

const OPENCLAW_STATE_DIR = (process.env.OPENCLAW_STATE_DIR ?? "").trim() || join(homedir(), ".openclaw");
const IMAGE_TEMP_DIR = join(OPENCLAW_STATE_DIR, "media", "my-claw-onebot");
const IMAGE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const IMAGE_TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let ws: WebSocket | null = null;
let wsServer: WebSocketServer | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;

let imageTempCleanupTimer: ReturnType<typeof setInterval> | null = null;
let echoCounter = 0;
const pendingEcho = new Map<string, { resolve: (payload: any) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

let connectionReadyResolve: (() => void) | null = null;
let connectionReadyPromise = createReadyPromise();

function createReadyPromise(): Promise<void> {
  return new Promise<void>((resolve) => {
    connectionReadyResolve = resolve;
  });
}

function resetReadyPromise(): void {
  if (!connectionReadyResolve) {
    connectionReadyPromise = createReadyPromise();
  }
}

function getLogger(): { info?: (value: string) => void; warn?: (value: string) => void } {
  return (globalThis as any).__onebotApi?.logger ?? {};
}

function nextEcho(): string {
  echoCounter += 1;
  return `onebot-${Date.now()}-${echoCounter}`;
}

function cleanupImageTemp(): void {
  try {
    const now = Date.now();
    for (const file of readdirSync(IMAGE_TEMP_DIR)) {
      const fullPath = join(IMAGE_TEMP_DIR, file);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && now - stat.mtimeMs > IMAGE_TEMP_MAX_AGE_MS) {
          unlinkSync(fullPath);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}

function nextImageTempFile(ext: string): string {
  cleanupImageTemp();
  mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
  return join(
    IMAGE_TEMP_DIR,
    `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  );
}

function inferMediaExtension(value: string, fallback = "bin"): string {
  return value.match(/\.(png|jpg|jpeg|gif|webp|bmp|tiff|tif|mp4|webm|mov|m4v|avi|mkv)(?:\?|$)/i)?.[1]?.toLowerCase() ?? fallback;
}

function normalizeLocalPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function looksLikeAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function formatNestedError(error: unknown): string {
  if (error instanceof AggregateError) {
    const childMessages = Array.from(error.errors ?? []).map((item) => formatNestedError(item)).filter(Boolean);
    if (childMessages.length > 0) {
      return childMessages.join(" | ");
    }
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function downloadUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https://") ? https : http;
    const req = client.get(url, {
      family: 4,
      headers: {
        "User-Agent": "openclaw-onebot/0.1",
        "Accept": "image/*,video/*,*/*;q=0.8"
      }
    }, (res) => {
      const redirect = res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? res.headers.location : undefined;
      if (redirect) {
        const nextUrl = redirect.startsWith("http") ? redirect : new URL(redirect, url).href;
        downloadUrl(nextUrl).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Download failed (${url}): HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", (error) => reject(new Error(`Download failed (${url}): ${formatNestedError(error)}`)));
    });
    req.on("error", (error) => reject(new Error(`Download failed (${url}): ${formatNestedError(error)}`)));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`Download failed (${url}): timeout`));
    });
  });
}

async function resolveImageToLocalPath(image: string): Promise<string> {
  const value = image.trim();
  if (!value) {
    throw new Error("Empty image");
  }
  if (value.startsWith("file://")) {
    return value.slice(7).replace(/\\/g, "/");
  }
  if (value.startsWith("base64://")) {
    const fullPath = nextImageTempFile("png");
    writeFileSync(fullPath, Buffer.from(value.slice(9), "base64"));
    return normalizeLocalPath(fullPath);
  }
  if (/^https?:\/\//i.test(value)) {
    const ext = inferMediaExtension(value, "png");
    const fullPath = nextImageTempFile(ext);
    writeFileSync(fullPath, await downloadUrl(value));
    return normalizeLocalPath(fullPath);
  }
  return normalizeLocalPath(value);
}

export async function stageInboundMediaToLocalPath(media: string, fallbackExt = "bin"): Promise<string> {
  const value = media.trim();
  if (!value) {
    throw new Error("Empty media");
  }
  if (value.startsWith("base64://")) {
    const fullPath = nextImageTempFile(fallbackExt);
    writeFileSync(fullPath, Buffer.from(value.slice(9), "base64"));
    return normalizeLocalPath(fullPath);
  }
  if (/^https?:\/\//i.test(value)) {
    const ext = inferMediaExtension(value, fallbackExt);
    const fullPath = nextImageTempFile(ext);
    writeFileSync(fullPath, await downloadUrl(value));
    return normalizeLocalPath(fullPath);
  }
  const localPath = value.startsWith("file://") ? value.slice(7) : value;
  if (!looksLikeAbsoluteLocalPath(localPath)) {
    throw new Error(`Unsupported inbound media reference: ${value}`);
  }
  const ext = inferMediaExtension(localPath, fallbackExt);
  const fullPath = nextImageTempFile(ext);
  copyFileSync(localPath, fullPath);
  return normalizeLocalPath(fullPath);
}

export async function stageInboundImageToLocalPath(image: string): Promise<string> {
  return stageInboundMediaToLocalPath(image, "png");
}

function setupEchoHandler(socket: WebSocket): void {
  socket.on("message", (data) => {
    try {
      const payload = JSON.parse(data.toString());
      handleEchoResponse(payload);
    } catch {
      return;
    }
  });
}

function sendOneBotAction(socket: WebSocket, action: string, params: Record<string, unknown>): Promise<any> {
  const logger = getLogger();
  const echo = nextEcho();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingEcho.delete(echo);
      reject(new Error(`OneBot action ${action} timeout`));
    }, 15000);

    pendingEcho.set(echo, { resolve, reject, timeout });

    socket.send(JSON.stringify({ action, params, echo }), (error) => {
      if (error) {
        const pending = pendingEcho.get(echo);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingEcho.delete(echo);
        }
        logger.warn?.(`[onebot] send ${action} failed: ${error.message}`);
        reject(error);
      }
    });
  });
}

function assertOk(res: any, action: string): void {
  if (!res || res.retcode !== 0) {
    const reason = [res?.wording, res?.message, res?.msg].find((item) => typeof item === "string" && item.trim()) ?? "";
    const retcode = typeof res?.retcode === "number" ? ` retcode=${res.retcode}` : "";
    throw new Error(reason || `OneBot ${action} failed${retcode}`);
  }
}

export function handleEchoResponse(payload: any): boolean {
  if (!payload?.echo) return false;
  const pending = pendingEcho.get(payload.echo);
  if (!pending) return false;
  clearTimeout(pending.timeout);
  pendingEcho.delete(payload.echo);
  pending.resolve(payload);
  return true;
}

export function getWs(): WebSocket | null {
  return ws;
}

export function setWs(socket: WebSocket | null): void {
  ws = socket;
  if (socket && socket.readyState === WebSocket.OPEN) {
    connectionReadyResolve?.();
    connectionReadyResolve = null;
    return;
  }
  resetReadyPromise();
}

export async function waitForConnection(timeoutMs = 30000): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return ws;
  }
  return Promise.race([
    connectionReadyPromise.then(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        return ws;
      }
      throw new Error("OneBot WebSocket not connected");
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`OneBot WebSocket not connected after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

export async function ensureConnection(getConfig: () => OneBotAccountConfig | null, timeoutMs = 30000): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return ws;
  }
  const config = getConfig();
  if (!config) {
    throw new Error("OneBot not configured");
  }
  if (config.type === "forward-websocket") {
    const socket = await connectForward(config);
    setupEchoHandler(socket);
    setWs(socket);
    return socket;
  }
  return waitForConnection(timeoutMs);
}

export async function connectForward(config: OneBotAccountConfig): Promise<WebSocket> {
  const path = config.path?.startsWith("/") ? config.path : `/${config.path ?? "onebot/v11/ws"}`;
  const socket = new WebSocket(`ws://${config.host}:${config.port}${path}`, {
    headers: config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : undefined
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

export async function createServerAndWait(config: OneBotAccountConfig): Promise<WebSocket> {
  httpServer = createServer();
  wsServer = new WebSocketServer({
    server: httpServer,
    path: config.path ?? "/onebot/v11/ws"
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(config.port, config.host || "0.0.0.0", () => resolve());
  });

  return new Promise<WebSocket>((resolve) => {
    wsServer!.once("connection", (socket) => resolve(socket as WebSocket));
  });
}

export function startImageTempCleanup(): void {
  if (imageTempCleanupTimer) return;
  imageTempCleanupTimer = setInterval(cleanupImageTemp, IMAGE_TEMP_CLEANUP_INTERVAL_MS);
}

export function stopImageTempCleanup(): void {
  if (!imageTempCleanupTimer) return;
  clearInterval(imageTempCleanupTimer);
  imageTempCleanupTimer = null;
}

export function stopConnection(): void {
  for (const pending of pendingEcho.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("OneBot connection stopped"));
  }
  pendingEcho.clear();
  ws?.close();
  ws = null;
  wsServer?.close();
  wsServer = null;
  httpServer?.close();
  httpServer = null;
  resetReadyPromise();
}

type OneBotOutboundMessage = string | OneBotMessageSegment[];

function buildInvalidImageFallbackText(segment: OneBotMessageSegment): string {
  const summary = typeof segment.data?.summary === "string" ? segment.data.summary.trim() : "";
  return summary || "[图片无效]";
}

async function normalizeOutboundMessage(message: OneBotOutboundMessage): Promise<OneBotOutboundMessage> {
  if (typeof message === "string") {
    return message;
  }

  const logger = getLogger();
  const normalized: OneBotMessageSegment[] = [];
  for (const segment of message) {
    if (segment.type !== "image") {
      normalized.push(segment);
      continue;
    }

    const rawFile = typeof segment.data?.file === "string" ? segment.data.file.trim() : "";
    if (!rawFile) {
      normalized.push({ type: "text", data: { text: buildInvalidImageFallbackText(segment) } });
      logger.warn?.("[onebot] outbound image skipped: empty file reference");
      continue;
    }

    try {
      const normalizedFile = await resolveImageToLocalPath(rawFile);
      normalized.push({
        ...segment,
        data: {
          ...(segment.data ?? {}),
          file: normalizedFile
        }
      });
    } catch (error) {
      logger.warn?.(`[onebot] outbound image fallback: ${formatNestedError(error)} source=${rawFile.slice(0, 200)}`);
      normalized.push({ type: "text", data: { text: buildInvalidImageFallbackText(segment) } });
    }
  }

  return normalized;
}

async function sendMessage(action: "send_private_msg" | "send_group_msg", params: { user_id?: number | string; group_id?: number | string }, message: OneBotOutboundMessage, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const res = await sendOneBotAction(socket, action, {
    ...params,
    user_id: params.user_id != null ? String(params.user_id) : undefined,
    group_id: params.group_id != null ? String(params.group_id) : undefined,
    message: await normalizeOutboundMessage(message)
  });
  assertOk(res, action);
  return res?.data?.message_id as number | undefined;
}

export async function sendPrivateMsg(userId: number, message: OneBotOutboundMessage, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  return sendMessage("send_private_msg", { user_id: String(userId) }, message, getConfig);
}

export async function sendGroupMsg(groupId: number, message: OneBotOutboundMessage, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  return sendMessage("send_group_msg", { group_id: String(groupId) }, message, getConfig);
}

async function sendImageMessage(action: "send_private_msg" | "send_group_msg", params: { user_id?: number | string; group_id?: number | string }, image: string, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  return sendMessage(action, params, [{ type: "image", data: { file: image } }], getConfig);
}

export async function sendPrivateImage(userId: number, image: string, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  return sendImageMessage("send_private_msg", { user_id: String(userId) }, image, getConfig);
}

export async function sendGroupImage(groupId: number, image: string, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  return sendImageMessage("send_group_msg", { group_id: String(groupId) }, image, getConfig);
}

export async function getMsg(messageId: number): Promise<{ sender?: { nickname?: string; user_id?: number }; message?: string | OneBotMessageSegment[] } | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return null;
  }
  try {
    const res = await sendOneBotAction(ws, "get_msg", { message_id: messageId });
    assertOk(res, "get_msg");
    return res.data ?? null;
  } catch {
    return null;
  }
}

export async function getImage(file: string, getConfig?: () => OneBotAccountConfig | null): Promise<{ file?: string; filename?: string; url?: string } | null> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  try {
    const res = await sendOneBotAction(socket, "get_image", { file });
    assertOk(res, "get_image");
    if (!res?.data || typeof res.data !== "object") {
      return null;
    }
    return {
      file: typeof res.data.file === "string" ? res.data.file : undefined,
      filename: typeof res.data.filename === "string" ? res.data.filename : undefined,
      url: typeof res.data.url === "string" ? res.data.url : undefined,
    };
  } catch {
    return null;
  }
}

export async function getStrangerInfo(userId: number): Promise<{ nickname: string } | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return null;
  }
  try {
    const res = await sendOneBotAction(ws, "get_stranger_info", { user_id: userId, no_cache: false });
    assertOk(res, "get_stranger_info");
    return res.data ? { nickname: String(res.data.nickname ?? "") } : null;
  } catch {
    return null;
  }
}

export async function getGroupMemberInfo(groupId: number, userId: number): Promise<{ nickname: string; card: string } | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return null;
  }
  try {
    const res = await sendOneBotAction(ws, "get_group_member_info", { group_id: groupId, user_id: userId, no_cache: false });
    assertOk(res, "get_group_member_info");
    return res.data ? { nickname: String(res.data.nickname ?? ""), card: String(res.data.card ?? "") } : null;
  } catch {
    return null;
  }
}

export async function getGroupInfo(groupId: number): Promise<{ group_name: string } | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return null;
  }
  try {
    const res = await sendOneBotAction(ws, "get_group_info", { group_id: groupId, no_cache: false });
    assertOk(res, "get_group_info");
    return res.data ? { group_name: String(res.data.group_name ?? "") } : null;
  } catch {
    return null;
  }
}

export function getAvatarUrl(userId: number, size = 640): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=${size}`;
}

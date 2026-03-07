import { createServer } from "node:http";
import http from "node:http";
import https from "node:https";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import type { OneBotAccountConfig, OneBotMessageSegment } from "./types.js";

const IMAGE_TEMP_DIR = join(tmpdir(), "my-claw-onebot");
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

function downloadUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https://") ? https : http;
    const req = client.get(url, (res) => {
      const redirect = res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? res.headers.location : undefined;
      if (redirect) {
        const nextUrl = redirect.startsWith("http") ? redirect : new URL(redirect, url).href;
        downloadUrl(nextUrl).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Download timeout"));
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
    cleanupImageTemp();
    mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
    const fullPath = join(IMAGE_TEMP_DIR, `img-${Date.now()}.png`);
    writeFileSync(fullPath, Buffer.from(value.slice(9), "base64"));
    return fullPath.replace(/\\/g, "/");
  }
  if (/^https?:\/\//i.test(value)) {
    cleanupImageTemp();
    mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
    const ext = value.match(/\.(png|jpg|jpeg|gif|webp|bmp)(?:\?|$)/i)?.[1]?.toLowerCase() ?? "png";
    const fullPath = join(IMAGE_TEMP_DIR, `img-${Date.now()}.${ext}`);
    writeFileSync(fullPath, await downloadUrl(value));
    return fullPath.replace(/\\/g, "/");
  }
  return value.replace(/\\/g, "/");
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
    throw new Error(res?.msg ?? `OneBot ${action} failed`);
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

export async function sendPrivateMsg(userId: number, text: string, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const res = await sendOneBotAction(socket, "send_private_msg", { user_id: userId, message: text });
  assertOk(res, "send_private_msg");
  return res?.data?.message_id as number | undefined;
}

export async function sendGroupMsg(groupId: number, text: string, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const res = await sendOneBotAction(socket, "send_group_msg", { group_id: groupId, message: text });
  assertOk(res, "send_group_msg");
  return res?.data?.message_id as number | undefined;
}

async function sendImageMessage(action: "send_private_msg" | "send_group_msg", params: { user_id?: number; group_id?: number }, image: string, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const file = await resolveImageToLocalPath(image);
  const message: OneBotMessageSegment[] = [{ type: "image", data: { file } }];
  const res = await sendOneBotAction(socket, action, { ...params, message });
  assertOk(res, action);
  return res?.data?.message_id as number | undefined;
}

export async function sendPrivateImage(userId: number, image: string, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  return sendImageMessage("send_private_msg", { user_id: userId }, image, getConfig);
}

export async function sendGroupImage(groupId: number, image: string, getConfig?: () => OneBotAccountConfig | null): Promise<number | undefined> {
  return sendImageMessage("send_group_msg", { group_id: groupId }, image, getConfig);
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


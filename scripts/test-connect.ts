import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(): void {
  for (const file of [resolve(__dirname, "../.env"), resolve(__dirname, "../../.env")]) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (!match) continue;
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    break;
  }
}

function loadOpenClawConfig(): void {
  if (process.env.ONEBOT_WS_HOST && process.env.ONEBOT_WS_PORT) {
    return;
  }
  for (const file of [
    resolve(process.env.HOME || "", ".openclaw/openclaw.json"),
    resolve(process.env.HOME || "", ".openclaw-onebot-dev/openclaw.json")
  ]) {
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
        process.env.ONEBOT_WS_ACCESS_TOKEN ||= String(onebot.accessToken);
      }
      break;
    } catch {
      continue;
    }
  }
}

loadEnvFile();
loadOpenClawConfig();

const host = process.env.ONEBOT_WS_HOST || "127.0.0.1";
const port = process.env.ONEBOT_WS_PORT || "3001";
const path = process.env.ONEBOT_WS_PATH || "/onebot/v11/ws";
const token = process.env.ONEBOT_WS_ACCESS_TOKEN;
const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

const socket = new WebSocket(`ws://${host}:${port}${path}`, { headers });

socket.on("open", () => {
  const echo = `test-${Date.now()}`;
  socket.send(JSON.stringify({ action: "get_login_info", params: {}, echo }));

  const timeout = setTimeout(() => {
    console.error("[OneBot Test] timeout");
    process.exit(1);
  }, 10000);

  socket.on("message", (data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (payload.echo !== echo) return;
      clearTimeout(timeout);
      if (payload.retcode === 0) {
        console.log("[OneBot Test] connected");
        console.log(payload.data);
        process.exit(0);
      }
      console.error("[OneBot Test] unexpected response", payload);
      process.exit(1);
    } catch (error) {
      clearTimeout(timeout);
      console.error("[OneBot Test] parse failed", error);
      process.exit(1);
    }
  });
});

socket.on("error", (error) => {
  console.error("[OneBot Test] socket error", error.message);
  process.exit(1);
});


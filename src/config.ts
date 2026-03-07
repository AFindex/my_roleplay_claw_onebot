import type { OneBotAccountConfig } from "./types.js";

function getRootConfig(apiOrCfg?: any): any {
  return apiOrCfg?.config ?? apiOrCfg ?? (globalThis as any).__onebotGatewayConfig ?? {};
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


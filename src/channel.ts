import { getOneBotConfig, listAccountIds } from "./config.js";
import { sendMediaMessage, sendTextMessage } from "./send.js";

const meta = {
  id: "onebot",
  label: "OneBot",
  selectionLabel: "OneBot (QQ/Lagrange)",
  docsPath: "/channels/onebot",
  docsLabel: "onebot",
  blurb: "OneBot v11 protocol via WebSocket",
  aliases: ["qq", "lagrange", "cqhttp"],
  order: 85
};

function normalizeOneBotMessagingTarget(raw: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(onebot|qq|lagrange):/i, "").trim();
}

export const OneBotChannelPlugin = {
  id: "onebot",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"] as const,
    media: true,
    reactions: false,
    threads: false,
    polls: false
  },
  reload: {
    configPrefixes: ["channels.onebot"] as const
  },
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any) => {
      const config = getOneBotConfig({ config: cfg });
      return config ? { accountId: "default", ...config } : { accountId: "default" };
    }
  },
  groups: {
    resolveRequireMention: () => true
  },
  messaging: {
    normalizeTarget: normalizeOneBotMessagingTarget,
    targetResolver: {
      looksLikeId: (raw: string) => {
        const normalized = normalizeOneBotMessagingTarget(raw) ?? raw.trim();
        return /^group:\d+$/.test(normalized) || /^user:\d+$/.test(normalized) || /^\d{6,}$/.test(normalized);
      },
      hint: "user:<QQ号> 或 group:<群号>"
    }
  },
  outbound: {
    deliveryMode: "direct" as const,
    chunker: (text: string, limit: number) => {
      if (!text) return [];
      if (limit <= 0 || text.length <= limit) return [text];
      const chunks: string[] = [];
      let rest = text;
      while (rest.length > limit) {
        const window = rest.slice(0, limit);
        const breakIndex = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
        const index = breakIndex > 0 ? breakIndex : limit;
        chunks.push(rest.slice(0, index).trimEnd());
        rest = rest.slice(index).trimStart();
      }
      if (rest) chunks.push(rest);
      return chunks;
    },
    chunkerMode: "text" as const,
    textChunkLimit: 2000,
    resolveTarget: ({ to }: { to?: string }) => {
      const value = normalizeOneBotMessagingTarget(to ?? "") ?? to?.trim();
      if (!value) {
        return { ok: false, error: new Error("OneBot requires --target <user_id|group_id>") };
      }
      return { ok: true, to: value };
    },
    sendText: async ({ to, text, cfg }: { to: string; text: string; cfg?: any }) => {
      const api = cfg ? { config: cfg } : (globalThis as any).__onebotApi;
      const config = getOneBotConfig(api);
      if (!config) {
        return { channel: "onebot", ok: false, messageId: "", error: new Error("OneBot not configured") };
      }
      const result = await sendTextMessage(to, text, () => getOneBotConfig(api), cfg);
      if (!result.ok) {
        throw new Error(result.error || "OneBot send failed");
      }
      return {
        channel: "onebot",
        ok: true,
        messageId: result.messageId ?? "",
      };
    },
    sendMedia: async ({ to, mediaUrl, text, cfg }: { to: string; mediaUrl: string; text?: string; cfg?: any }) => {
      const api = cfg ? { config: cfg } : (globalThis as any).__onebotApi;
      const config = getOneBotConfig(api);
      if (!config) {
        return { channel: "onebot", ok: false, messageId: "", error: new Error("OneBot not configured") };
      }
      const result = await sendMediaMessage(to, mediaUrl, text, () => getOneBotConfig(api), cfg);
      if (!result.ok) {
        throw new Error(result.error || "OneBot send failed");
      }
      return {
        channel: "onebot",
        ok: true,
        messageId: result.messageId ?? "",
      };
    }
  }
};

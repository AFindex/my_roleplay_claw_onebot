import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentPersonaContext {
  agentId: string;
  agentName?: string;
  personaPrompt: string;
}

function clipText(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function readTextIfExists(path: string, maxChars: number): string {
  if (!path || !existsSync(path)) {
    return "";
  }

  try {
    return clipText(readFileSync(path, "utf8"), maxChars);
  } catch {
    return "";
  }
}

function resolveAgentEntry(cfg: any, agentId: string): Record<string, any> | null {
  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const normalizedAgentId = agentId.trim().toLowerCase();
  for (const entry of list) {
    const entryId = typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : "";
    if (entryId && entryId === normalizedAgentId) {
      return entry as Record<string, any>;
    }
  }
  return null;
}

function resolveAgentWorkspace(cfg: any, agentId: string): string {
  const entry = resolveAgentEntry(cfg, agentId);
  if (typeof entry?.workspace === "string" && entry.workspace.trim()) {
    return entry.workspace.trim();
  }

  const defaultWorkspace = typeof cfg?.agents?.defaults?.workspace === "string"
    ? cfg.agents.defaults.workspace.trim()
    : "";
  return defaultWorkspace;
}

function resolveAgentName(cfg: any, agentId: string): string | undefined {
  const entry = resolveAgentEntry(cfg, agentId);
  const candidates = [
    entry?.identity?.name,
    entry?.name,
    cfg?.identity?.name
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return agentId.trim() || undefined;
}

export function buildAgentPersonaContext(cfg: any, agentId: string): AgentPersonaContext {
  const workspace = resolveAgentWorkspace(cfg, agentId);
  const agentName = resolveAgentName(cfg, agentId);
  const identityText = workspace ? readTextIfExists(join(workspace, "IDENTITY.md"), 2200) : "";
  const soulText = workspace ? readTextIfExists(join(workspace, "SOUL.md"), 2200) : "";
  const promptParts: string[] = [];

  if (agentName) {
    promptParts.push(`角色名：${agentName}`);
  }
  if (identityText) {
    promptParts.push(`IDENTITY.md 摘要：\n${identityText}`);
  }
  if (soulText) {
    promptParts.push(`SOUL.md 摘要：\n${soulText}`);
  }

  return {
    agentId,
    agentName,
    personaPrompt: promptParts.join("\n\n").trim()
  };
}

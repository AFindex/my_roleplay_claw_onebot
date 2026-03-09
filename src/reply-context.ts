import { AsyncLocalStorage } from "node:async_hooks";

const replyTargetStore = new AsyncLocalStorage<string>();

function normalizeTarget(value: string): string {
  return value.replace(/^(onebot|qq|lagrange):/i, "").trim().toLowerCase();
}

export function withReplyTarget<T>(to: string, run: () => T): T {
  return replyTargetStore.run(to, run);
}

export function resolveTargetForReply(to: string): string {
  const stored = replyTargetStore.getStore();
  if (!stored) return to;
  const storedNormalized = normalizeTarget(stored);
  const groupMatch = storedNormalized.match(/^group:(\d+)$/);
  if (!groupMatch) return to;
  const groupId = groupMatch[1];
  const normalizedTo = normalizeTarget(to);
  const numeric = normalizedTo.replace(/^user:/, "");
  if (normalizedTo === groupId || numeric === groupId) {
    return stored;
  }
  return to;
}

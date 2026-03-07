let activeReplyTarget: string | null = null;

export function setActiveReplyTarget(to: string): void {
  activeReplyTarget = to;
}

export function clearActiveReplyTarget(): void {
  activeReplyTarget = null;
}

function normalizeTarget(value: string): string {
  return value.replace(/^(onebot|qq|lagrange):/i, "").trim().toLowerCase();
}

export function resolveTargetForReply(to: string): string {
  const stored = activeReplyTarget;
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


import type { OneBotMessageSegment } from "./types.js";

export type OneBotRichTextPart =
  | { type: "image"; mediaUrl: string }
  | { type: "mention"; target: string }
  | { type: "text"; text: string };

const RICH_TEXT_PATTERN = /<qqimg>\s*([\s\S]*?)\s*<\/(?:qqimg|img)>|\[\[(at|mention):([^\]]+?)\]\]|<at\b([^>]*)\/?>(?:\s*<\/at>)?/gi;

function pushTextPart(parts: OneBotRichTextPart[], text: string): void {
  if (!text) {
    return;
  }
  parts.push({ type: "text", text });
}

function parseXmlStyleMentionTarget(rawAttrs: string): string | null {
  const attrs = rawAttrs.trim();
  if (!attrs) {
    return null;
  }

  const attrPattern = /(id|qq|user|target)\s*=\s*(["'])(.*?)\2/gi;
  for (const match of attrs.matchAll(attrPattern)) {
    const value = (match[3] ?? "").trim();
    if (value) {
      return value;
    }
  }

  return null;
}

export function parseOneBotRichText(input: string): OneBotRichTextPart[] {
  if (!input) {
    return [];
  }

  const parts: OneBotRichTextPart[] = [];
  let cursor = 0;

  for (const match of input.matchAll(RICH_TEXT_PATTERN)) {
    const matchIndex = match.index ?? 0;
    pushTextPart(parts, input.slice(cursor, matchIndex));

    const imageUrl = (match[1] ?? "").trim();
    const mentionTarget = (match[3] ?? "").trim();
    const xmlMentionTarget = parseXmlStyleMentionTarget(match[4] ?? "");
    if (imageUrl) {
      parts.push({ type: "image", mediaUrl: imageUrl });
    } else if (mentionTarget) {
      parts.push({ type: "mention", target: mentionTarget });
    } else if (xmlMentionTarget) {
      parts.push({ type: "mention", target: xmlMentionTarget });
    }

    cursor = matchIndex + match[0].length;
  }

  pushTextPart(parts, input.slice(cursor));
  return parts.length > 0 ? parts : [{ type: "text", text: input }];
}

export function resolveOneBotMentionTarget(raw: string, currentUserId?: number): string | null {
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (["all", "everyone", "全体", "全员"].includes(lowered)) {
    return "all";
  }

  if (/^\d+$/.test(normalized)) {
    return normalized;
  }

  if (currentUserId && ["sender", "user", "author", "current"].includes(lowered)) {
    return String(currentUserId);
  }

  return null;
}

export function buildOneBotSegmentsFromRichText(input: string, options: {
  currentUserId?: number;
  isGroup: boolean;
}): OneBotMessageSegment[] {
  const parts = parseOneBotRichText(input);
  const segments: OneBotMessageSegment[] = [];

  for (const part of parts) {
    if (part.type === "image") {
      segments.push({ type: "image", data: { file: part.mediaUrl } });
      continue;
    }

    if (part.type === "mention") {
      const target = options.isGroup
        ? resolveOneBotMentionTarget(part.target, options.currentUserId)
        : null;
      if (target) {
        segments.push({ type: "at", data: { qq: target } });
      } else {
        segments.push({ type: "text", data: { text: `@${part.target}` } });
      }
      continue;
    }

    if (part.text) {
      segments.push({ type: "text", data: { text: part.text } });
    }
  }

  return segments;
}

export function buildOneBotCqMessageFromSegments(segments: OneBotMessageSegment[]): string | null {
  let hasMention = false;
  let result = "";

  for (const segment of segments) {
    if (segment.type === "text") {
      result += String(segment.data?.text ?? "");
      continue;
    }

    if (segment.type === "at") {
      const qq = String(segment.data?.qq ?? "").trim();
      if (!qq) {
        return null;
      }
      hasMention = true;
      result += `[CQ:at,qq=${qq}]`;
      continue;
    }

    return null;
  }

  return hasMention ? result : null;
}

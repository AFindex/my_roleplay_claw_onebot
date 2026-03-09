import type { OneBotMessageSegment } from "./types.js";

export type OneBotRichTextPart =
  | { type: "dice" }
  | { type: "face"; id: string }
  | { type: "file"; fileUrl: string; name?: string }
  | { type: "forward"; messageIds: string[] }
  | { type: "image"; mediaUrl: string }
  | { type: "mention"; target: string }
  | { type: "poke"; target: string }
  | { type: "record"; mediaUrl: string }
  | { type: "reply"; messageId: string }
  | { type: "rps" }
  | { type: "text"; text: string };

const RICH_TEXT_PATTERN = /<qqimg>\s*([\s\S]*?)\s*<\/(?:qqimg|img)>|\[\[(at|mention|face|poke|record|reply|file|forward):([^\]]+?)\]\]|\[\[(rps|dice)\]\]|<at\b([^>]*)\/?>(?:\s*<\/at>)?/gi;

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

function parseFileTagValue(raw: string): { fileUrl: string; name?: string } | null {
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }

  const pipeIndex = normalized.indexOf("|");
  if (pipeIndex < 0) {
    return { fileUrl: normalized };
  }

  const fileUrl = normalized.slice(0, pipeIndex).trim();
  const name = normalized.slice(pipeIndex + 1).trim();
  if (!fileUrl) {
    return null;
  }

  return {
    fileUrl,
    name: name || undefined
  };
}

function parseForwardMessageIds(raw: string): string[] {
  const messageIds = raw
    .split(/[,\s|]+/)
    .map((item) => item.trim())
    .filter((item) => /^\d+$/.test(item));
  return Array.from(new Set(messageIds));
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
    const taggedType = (match[2] ?? "").trim().toLowerCase();
    const taggedValue = (match[3] ?? "").trim();
    const simpleAction = (match[4] ?? "").trim().toLowerCase();
    const xmlMentionTarget = parseXmlStyleMentionTarget(match[5] ?? "");
    if (imageUrl) {
      parts.push({ type: "image", mediaUrl: imageUrl });
    } else if ((taggedType === "at" || taggedType === "mention") && taggedValue) {
      parts.push({ type: "mention", target: taggedValue });
    } else if (taggedType === "face" && /^\d+$/.test(taggedValue)) {
      parts.push({ type: "face", id: taggedValue });
    } else if (taggedType === "poke" && taggedValue) {
      parts.push({ type: "poke", target: taggedValue });
    } else if (taggedType === "record" && taggedValue) {
      parts.push({ type: "record", mediaUrl: taggedValue });
    } else if (taggedType === "reply" && /^\d+$/.test(taggedValue)) {
      parts.push({ type: "reply", messageId: taggedValue });
    } else if (taggedType === "file") {
      const file = parseFileTagValue(taggedValue);
      if (file) {
        parts.push({ type: "file", ...file });
      } else {
        pushTextPart(parts, match[0]);
      }
    } else if (taggedType === "forward") {
      const messageIds = parseForwardMessageIds(taggedValue);
      if (messageIds.length > 0) {
        parts.push({ type: "forward", messageIds });
      } else {
        pushTextPart(parts, match[0]);
      }
    } else if (simpleAction === "rps") {
      parts.push({ type: "rps" });
    } else if (simpleAction === "dice") {
      parts.push({ type: "dice" });
    } else if (xmlMentionTarget) {
      parts.push({ type: "mention", target: xmlMentionTarget });
    } else {
      pushTextPart(parts, match[0]);
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

export function resolveOneBotPokeTarget(raw: string, currentUserId?: number): string | null {
  const resolved = resolveOneBotMentionTarget(raw, currentUserId);
  if (!resolved || resolved === "all") {
    return null;
  }
  return resolved;
}

export function buildOneBotSegmentsFromRichParts(parts: OneBotRichTextPart[], options: {
  currentUserId?: number;
  isGroup: boolean;
}): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];

  for (const part of parts) {
    if (part.type === "image") {
      segments.push({ type: "image", data: { file: part.mediaUrl } });
      continue;
    }

    if (part.type === "record") {
      segments.push({ type: "record", data: { file: part.mediaUrl } });
      continue;
    }

    if (part.type === "file") {
      segments.push({
        type: "file",
        data: {
          file: part.fileUrl,
          name: part.name
        }
      });
      continue;
    }

    if (part.type === "reply") {
      segments.push({ type: "reply", data: { id: part.messageId } });
      continue;
    }

    if (part.type === "forward") {
      segments.push({ type: "text", data: { text: "[合并转发]" } });
      continue;
    }

    if (part.type === "poke") {
      segments.push({ type: "text", data: { text: "[戳一戳]" } });
      continue;
    }

    if (part.type === "face") {
      segments.push({ type: "face", data: { id: part.id } });
      continue;
    }

    if (part.type === "rps") {
      segments.push({ type: "rps" });
      continue;
    }

    if (part.type === "dice") {
      segments.push({ type: "dice" });
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

export function buildOneBotSegmentsFromRichText(input: string, options: {
  currentUserId?: number;
  isGroup: boolean;
}): OneBotMessageSegment[] {
  return buildOneBotSegmentsFromRichParts(parseOneBotRichText(input), options);
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

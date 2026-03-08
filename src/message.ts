import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

function stripCqCodes(text: string): string {
  return text.replace(/\[CQ:[^\]]+\]/g, "").trim();
}

function getSegments(message: OneBotMessage["message"]): OneBotMessageSegment[] {
  return Array.isArray(message) ? message : [];
}

function decodeCqValue(value: string): string {
  return value
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&");
}

function parseCqSegmentData(raw: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const item of raw.split(",")) {
    const eqIndex = item.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = item.slice(0, eqIndex).trim();
    const value = item.slice(eqIndex + 1).trim();
    if (!key) {
      continue;
    }
    data[key] = decodeCqValue(value);
  }
  return data;
}

export function getTextFromMessageContent(content: string | OneBotMessageSegment[] | undefined): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .filter((segment) => segment.type === "text")
      .map((segment) => String(segment.data?.text ?? ""))
      .join("")
      .trim();
  }
  return stripCqCodes(String(content));
}

export function getTextFromSegments(msg: OneBotMessage): string {
  return getTextFromMessageContent(msg.message);
}

export function getRawText(msg: OneBotMessage): string {
  if (typeof msg.raw_message === "string") {
    return stripCqCodes(msg.raw_message);
  }
  return getTextFromMessageContent(msg.message);
}

export function getImageSegments(msg: OneBotMessage): OneBotMessageSegment[] {
  const segments = getSegments(msg.message);
  if (segments.length > 0) {
    return segments.filter((segment) => segment.type === "image");
  }

  const raw = String(msg.raw_message ?? msg.message ?? "");
  if (!raw.includes("[CQ:image,")) {
    return [];
  }

  const result: OneBotMessageSegment[] = [];
  for (const match of raw.matchAll(/\[CQ:image,([^\]]+)\]/g)) {
    const params = match[1]?.trim();
    if (!params) {
      continue;
    }
    result.push({
      type: "image",
      data: parseCqSegmentData(params),
    });
  }
  return result;
}

export function isMentioned(msg: OneBotMessage, selfId: number): boolean {
  if (!selfId) return false;
  const segments = getSegments(msg.message);
  if (segments.length > 0) {
    return segments.some((segment) => segment.type === "at" && String(segment.data?.qq ?? "") === String(selfId));
  }
  const raw = String(msg.raw_message ?? msg.message ?? "");
  return raw.includes(`[CQ:at,qq=${selfId}]`);
}

export function getReplyMessageId(msg: OneBotMessage): number | null {
  const segments = getSegments(msg.message);
  const replySegment = segments.find((segment) => segment.type === "reply");
  const replyId = replySegment?.data?.id ?? replySegment?.data?.message_id;
  if (replyId !== undefined && /^\d+$/.test(String(replyId))) {
    return Number(replyId);
  }
  const raw = String(msg.raw_message ?? msg.message ?? "");
  const match = raw.match(/\[CQ:reply,(?:id|message_id)=(\d+)\]/);
  return match ? Number(match[1]) : null;
}

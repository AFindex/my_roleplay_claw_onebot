import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

type ReadableTextOptions = {
  selfId?: number;
};

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

function formatAtText(qq: string | number | boolean | undefined, options: ReadableTextOptions = {}): string {
  const target = String(qq ?? "").trim();
  if (!target) {
    return "@某人";
  }
  if (target === "all") {
    return "@全体成员";
  }
  if (options.selfId != null && target === String(options.selfId)) {
    return "@你";
  }
  return `@${target}`;
}

function segmentToReadableText(segment: OneBotMessageSegment, options: ReadableTextOptions = {}): string {
  if (segment.type === "text") {
    return String(segment.data?.text ?? "");
  }
  if (segment.type === "at") {
    return formatAtText(segment.data?.qq, options);
  }
  if (segment.type === "image") {
    return "[图片]";
  }
  if (segment.type === "video") {
    return "[视频]";
  }
  return "";
}

function renderSegmentsToReadableText(segments: OneBotMessageSegment[], options: ReadableTextOptions = {}): string {
  return segments.map((segment) => segmentToReadableText(segment, options)).join("").trim();
}

function replaceCqSegment(type: string, rawData: string | undefined, options: ReadableTextOptions = {}): string {
  if (type === "at") {
    const data = parseCqSegmentData(rawData ?? "");
    return formatAtText(data.qq, options);
  }
  if (type === "image") {
    return "[图片]";
  }
  if (type === "video") {
    return "[视频]";
  }
  return "";
}

function renderCqToReadableText(text: string, options: ReadableTextOptions = {}): string {
  return text.replace(/\[(?:CQ|cq):([^,\]]+)(?:,([^\]]+))?\]/g, (_match, type: string, rawData?: string) => {
    return replaceCqSegment(type.toLowerCase(), rawData, options);
  }).trim();
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

export function getReadableTextFromMessageContent(
  content: string | OneBotMessageSegment[] | undefined,
  options: ReadableTextOptions = {}
): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    return renderSegmentsToReadableText(content, options);
  }
  return renderCqToReadableText(String(content), options);
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

export function getReadableRawText(msg: OneBotMessage, options: ReadableTextOptions = {}): string {
  const segments = getSegments(msg.message);
  if (segments.length > 0) {
    return renderSegmentsToReadableText(segments, options);
  }
  if (typeof msg.raw_message === "string") {
    return renderCqToReadableText(msg.raw_message, options);
  }
  return getReadableTextFromMessageContent(msg.message, options);
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

export function getVideoSegments(msg: OneBotMessage): OneBotMessageSegment[] {
  const segments = getSegments(msg.message);
  if (segments.length > 0) {
    return segments.filter((segment) => segment.type === "video");
  }

  const raw = String(msg.raw_message ?? msg.message ?? "");
  if (!raw.includes("[CQ:video,")) {
    return [];
  }

  const result: OneBotMessageSegment[] = [];
  for (const match of raw.matchAll(/\[CQ:video,([^\]]+)\]/g)) {
    const params = match[1]?.trim();
    if (!params) {
      continue;
    }
    result.push({
      type: "video",
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

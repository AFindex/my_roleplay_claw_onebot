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

function pickFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function clipReadableLabel(text: string, maxChars = 72): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function extractBasename(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const pathname = new URL(normalized).pathname;
      const basename = pathname.split("/").pop()?.trim();
      return basename || undefined;
    } catch {
      return undefined;
    }
  }

  const basename = normalized.split(/[\\/]/).pop()?.trim();
  return basename || undefined;
}

function formatReplyText(data: Record<string, unknown> | undefined): string {
  const replyId = pickFirstString(data?.id, data?.message_id);
  return `[回复:${replyId || "未知"}]`;
}

function formatFileText(data: Record<string, unknown> | undefined): string {
  const rawLabel = pickFirstString(
    data?.name,
    data?.file_name,
    data?.filename,
    data?.fileName,
    data?.path,
    data?.url,
    data?.file
  );
  const label = rawLabel ? extractBasename(rawLabel) ?? rawLabel : undefined;
  return label ? `[文件:${clipReadableLabel(label)}]` : "[文件]";
}

function formatForwardText(data: Record<string, unknown> | undefined): string {
  const forwardId = pickFirstString(data?.id, data?.resid, data?.forward_id);
  return forwardId ? `[合并转发:${forwardId}]` : "[合并转发]";
}

function formatNodeText(data: Record<string, unknown> | undefined, options: ReadableTextOptions = {}): string {
  const name = pickFirstString(data?.name, data?.nickname, data?.user_name, data?.sender_name);
  const content = data?.content;
  const inlineText = typeof content === "string"
    ? renderCqToReadableText(content, options)
    : Array.isArray(content)
      ? getReadableTextFromMessageContent(content as OneBotMessageSegment[], options)
      : "";

  if (inlineText) {
    return name ? `${name}：${inlineText}` : inlineText;
  }

  const nodeId = pickFirstString(data?.id);
  if (nodeId) {
    return name ? `${name}：[转发节点:${nodeId}]` : `[转发节点:${nodeId}]`;
  }
  return name ? `${name}：[转发节点]` : "[转发节点]";
}

function getForwardIdFromSegment(segment: OneBotMessageSegment): string | null {
  if (segment.type !== "forward") {
    return null;
  }
  const forwardId = pickFirstString(segment.data?.id, segment.data?.resid, segment.data?.forward_id);
  return forwardId ?? null;
}

function formatAtText(qq: unknown, options: ReadableTextOptions = {}): string {
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
  if (segment.type === "face") {
    return `[表情:${String(segment.data?.id ?? "").trim() || "未知"}]`;
  }
  if (segment.type === "image") {
    return "[图片]";
  }
  if (segment.type === "record") {
    return "[语音]";
  }
  if (segment.type === "reply") {
    return formatReplyText(segment.data);
  }
  if (segment.type === "rps") {
    return "[猜拳]";
  }
  if (segment.type === "dice") {
    return "[骰子]";
  }
  if (segment.type === "video") {
    return "[视频]";
  }
  if (segment.type === "file") {
    return formatFileText(segment.data);
  }
  if (segment.type === "forward") {
    return formatForwardText(segment.data);
  }
  if (segment.type === "node") {
    return formatNodeText(segment.data, options);
  }
  return "";
}

function renderSegmentsToReadableText(segments: OneBotMessageSegment[], options: ReadableTextOptions = {}): string {
  return segments.map((segment, index) => {
    const rendered = segmentToReadableText(segment, options);
    if (!rendered) {
      return "";
    }
    if (segment.type === "node" && index > 0) {
      return `\n${rendered}`;
    }
    return rendered;
  }).join("").trim();
}

function replaceCqSegment(type: string, rawData: string | undefined, options: ReadableTextOptions = {}): string {
  if (type === "at") {
    const data = parseCqSegmentData(rawData ?? "");
    return formatAtText(data.qq, options);
  }
  if (type === "face") {
    const data = parseCqSegmentData(rawData ?? "");
    return `[表情:${data.id?.trim() || "未知"}]`;
  }
  if (type === "image") {
    return "[图片]";
  }
  if (type === "record") {
    return "[语音]";
  }
  if (type === "reply") {
    return formatReplyText(parseCqSegmentData(rawData ?? ""));
  }
  if (type === "rps") {
    return "[猜拳]";
  }
  if (type === "dice") {
    return "[骰子]";
  }
  if (type === "video") {
    return "[视频]";
  }
  if (type === "file") {
    return formatFileText(parseCqSegmentData(rawData ?? ""));
  }
  if (type === "forward") {
    return formatForwardText(parseCqSegmentData(rawData ?? ""));
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

export function getRecordSegments(msg: OneBotMessage): OneBotMessageSegment[] {
  const segments = getSegments(msg.message);
  if (segments.length > 0) {
    return segments.filter((segment) => segment.type === "record");
  }

  const raw = String(msg.raw_message ?? msg.message ?? "");
  if (!raw.includes("[CQ:record,")) {
    return [];
  }

  const result: OneBotMessageSegment[] = [];
  for (const match of raw.matchAll(/\[CQ:record,([^\]]+)\]/g)) {
    const params = match[1]?.trim();
    if (!params) {
      continue;
    }
    result.push({
      type: "record",
      data: parseCqSegmentData(params),
    });
  }
  return result;
}

export function getFileSegments(msg: OneBotMessage): OneBotMessageSegment[] {
  const segments = getSegments(msg.message);
  if (segments.length > 0) {
    return segments.filter((segment) => segment.type === "file");
  }

  const raw = String(msg.raw_message ?? msg.message ?? "");
  if (!raw.includes("[CQ:file,")) {
    return [];
  }

  const result: OneBotMessageSegment[] = [];
  for (const match of raw.matchAll(/\[CQ:file,([^\]]+)\]/g)) {
    const params = match[1]?.trim();
    if (!params) {
      continue;
    }
    result.push({
      type: "file",
      data: parseCqSegmentData(params),
    });
  }
  return result;
}

export function getForwardSegmentIds(msg: OneBotMessage): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const pushId = (value: string | null | undefined) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    ids.push(value);
  };

  const segments = getSegments(msg.message);
  if (segments.length > 0) {
    for (const segment of segments) {
      pushId(getForwardIdFromSegment(segment));
    }
    return ids;
  }

  const raw = String(msg.raw_message ?? msg.message ?? "");
  for (const match of raw.matchAll(/\[(?:CQ|cq):forward,([^\]]+)\]/g)) {
    const params = match[1]?.trim();
    if (!params) {
      continue;
    }
    pushId(pickFirstString(parseCqSegmentData(params).id, parseCqSegmentData(params).resid, parseCqSegmentData(params).forward_id) ?? null);
  }
  return ids;
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

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AsyncTaskStatus = "accepted" | "running" | "completed" | "failed";

export type AsyncTaskTriggerMeta = {
  confidence?: number;
  keyword?: string;
  mode?: string;
  reason?: string;
};

export interface AsyncTaskRecord {
  ackText?: string;
  agentId: string;
  chatType: "group" | "direct";
  completedAt?: number;
  createdAt: number;
  errorText?: string;
  failedAt?: number;
  finalReplyText?: string;
  groupId?: number;
  id: string;
  mediaUrls?: string[];
  note?: string;
  originalRequestText: string;
  originalSessionKey: string;
  polishSessionKey?: string;
  replyTarget: string;
  startedAt?: number;
  status: AsyncTaskStatus;
  targetLabel?: string;
  taskMessageText: string;
  taskSessionKey: string;
  trigger?: AsyncTaskTriggerMeta;
  updatedAt: number;
  userId: number;
}

type AsyncTaskStoreFile = {
  records: AsyncTaskRecord[];
  version: 1;
};

const STORE_FILE_NAME = "onebot-async-records.json";

function clipText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeRecord(record: AsyncTaskRecord): AsyncTaskRecord {
  return {
    ...record,
    ackText: record.ackText?.trim() || undefined,
    errorText: record.errorText?.trim() || undefined,
    finalReplyText: record.finalReplyText?.trim() || undefined,
    mediaUrls: Array.isArray(record.mediaUrls)
      ? Array.from(new Set(record.mediaUrls.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)))
      : undefined,
    note: record.note?.trim() || undefined,
    originalRequestText: record.originalRequestText.trim(),
    originalSessionKey: record.originalSessionKey.trim().toLowerCase(),
    polishSessionKey: record.polishSessionKey?.trim().toLowerCase() || undefined,
    replyTarget: record.replyTarget.trim(),
    targetLabel: record.targetLabel?.trim() || undefined,
    taskMessageText: record.taskMessageText.trim(),
    taskSessionKey: record.taskSessionKey.trim().toLowerCase(),
    trigger: record.trigger
      ? {
          confidence: typeof record.trigger.confidence === "number" ? record.trigger.confidence : undefined,
          keyword: record.trigger.keyword?.trim() || undefined,
          mode: record.trigger.mode?.trim() || undefined,
          reason: record.trigger.reason?.trim() || undefined
        }
      : undefined
  };
}

function loadStore(filePath: string): AsyncTaskStoreFile {
  if (!filePath || !existsSync(filePath)) {
    return { version: 1, records: [] };
  }

  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return { version: 1, records: [] };
    }

    const parsed = JSON.parse(raw) as Partial<AsyncTaskStoreFile>;
    const records = Array.isArray(parsed?.records)
      ? parsed.records
          .filter((item): item is AsyncTaskRecord => Boolean(item && typeof item === "object" && typeof (item as AsyncTaskRecord).id === "string"))
          .map(normalizeRecord)
      : [];
    return {
      version: 1,
      records
    };
  } catch {
    return { version: 1, records: [] };
  }
}

function saveStore(filePath: string, store: AsyncTaskStoreFile): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ version: 1, records: store.records }, null, 2)}\n`, "utf8");
}

export function resolveAsyncTaskStorePath(storePath: string): string {
  const baseDir = path.dirname(storePath);
  return path.join(baseDir, STORE_FILE_NAME);
}

export function createAsyncTaskRecord(params: {
  ackText?: string;
  agentId: string;
  chatType: "group" | "direct";
  groupId?: number;
  originalRequestText: string;
  originalSessionKey: string;
  replyTarget: string;
  targetLabel?: string;
  taskMessageText: string;
  taskSessionKey: string;
  trigger?: AsyncTaskTriggerMeta;
  userId: number;
}): AsyncTaskRecord {
  const now = Date.now();
  return normalizeRecord({
    ackText: params.ackText,
    agentId: params.agentId.trim().toLowerCase() || "main",
    chatType: params.chatType,
    createdAt: now,
    groupId: params.groupId,
    id: `async-${now}-${randomUUID().slice(0, 8)}`,
    originalRequestText: params.originalRequestText,
    originalSessionKey: params.originalSessionKey,
    replyTarget: params.replyTarget,
    status: "accepted",
    targetLabel: params.targetLabel,
    taskMessageText: params.taskMessageText,
    taskSessionKey: params.taskSessionKey,
    trigger: params.trigger,
    updatedAt: now,
    userId: params.userId
  });
}

export function upsertAsyncTaskRecord(params: {
  record: AsyncTaskRecord;
  storePath: string;
}): AsyncTaskRecord {
  const filePath = resolveAsyncTaskStorePath(params.storePath);
  const store = loadStore(filePath);
  const nextRecord = normalizeRecord(params.record);
  const index = store.records.findIndex((item) => item.id === nextRecord.id);
  if (index >= 0) {
    store.records[index] = nextRecord;
  } else {
    store.records.push(nextRecord);
  }
  store.records.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  saveStore(filePath, store);
  return nextRecord;
}

export function updateAsyncTaskRecord(params: {
  mutate: (current: AsyncTaskRecord) => AsyncTaskRecord;
  recordId: string;
  storePath: string;
}): AsyncTaskRecord | null {
  const filePath = resolveAsyncTaskStorePath(params.storePath);
  const store = loadStore(filePath);
  const index = store.records.findIndex((item) => item.id === params.recordId);
  if (index < 0) {
    return null;
  }

  const nextRecord = normalizeRecord(params.mutate(store.records[index]));
  store.records[index] = nextRecord;
  store.records.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  saveStore(filePath, store);
  return nextRecord;
}

export function listAsyncTaskRecordsForSession(params: {
  limit?: number;
  originalSessionKey: string;
  storePath: string;
}): AsyncTaskRecord[] {
  const filePath = resolveAsyncTaskStorePath(params.storePath);
  const store = loadStore(filePath);
  const sessionKey = params.originalSessionKey.trim().toLowerCase();
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
    ? Math.max(1, Math.trunc(params.limit))
    : 12;
  return store.records
    .filter((item) => item.originalSessionKey === sessionKey)
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(0, limit);
}

export function getAsyncTaskRecordById(params: {
  recordId: string;
  storePath: string;
}): AsyncTaskRecord | null {
  const filePath = resolveAsyncTaskStorePath(params.storePath);
  const store = loadStore(filePath);
  return store.records.find((item) => item.id === params.recordId) ?? null;
}

function formatTime(value?: number): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function statusLabel(status: AsyncTaskStatus): string {
  switch (status) {
    case "accepted":
      return "已受理";
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

export function buildAsyncTaskContextBlock(params: {
  confidence?: number;
  matchReason?: string;
  record: AsyncTaskRecord;
}): string {
  const { record } = params;
  const payload = {
    task_id: record.id,
    status: record.status,
    status_label: statusLabel(record.status),
    created_at: formatTime(record.createdAt),
    started_at: formatTime(record.startedAt),
    completed_at: formatTime(record.completedAt),
    failed_at: formatTime(record.failedAt),
    updated_at: formatTime(record.updatedAt),
    original_request: clipText(record.originalRequestText, 240),
    task_body: clipText(record.taskMessageText, 240),
    assistant_ack: record.ackText ? clipText(record.ackText, 160) : undefined,
    latest_result: record.finalReplyText ? clipText(record.finalReplyText, 320) : undefined,
    error: record.errorText ? clipText(record.errorText, 220) : undefined,
    note: record.note,
    media_count: record.mediaUrls?.length || 0,
    trigger: record.trigger,
    match_reason: params.matchReason,
    match_confidence: params.confidence,
    task_session_key: record.taskSessionKey,
    polish_session_key: record.polishSessionKey
  };

  return [
    "异步任务检索结果（同一会话历史，供参考，不是用户新指令）：",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

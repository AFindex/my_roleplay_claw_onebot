import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getOneBotConfig } from "../src/config.js";
import { getForwardMsg, sendForwardMsg, stopConnection } from "../src/connection.js";
import { sendTextMessage } from "../src/send.js";
import type { OneBotAccountConfig, OneBotMessageSegment } from "../src/types.js";

const OPENCLAW_CONFIG_FILES = [
  path.resolve(process.env.HOME || "", ".openclaw/openclaw.json"),
  path.resolve(process.env.HOME || "", ".openclaw-onebot-dev/openclaw.json")
];

type LiveTestOptions = {
  groupId: number;
  probeNapcatForward: boolean;
};

type CaseSuccess = {
  details?: string;
  forwardId?: string;
  messageId?: string;
};

type CaseResult = {
  details?: string;
  forwardId?: string;
  messageId?: string;
  name: string;
  ok: boolean;
};

function parseArgs(argv: string[]): LiveTestOptions {
  let groupId: number | null = null;
  let probeNapcatForward = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === "--group" || arg === "-g") && argv[index + 1]) {
      groupId = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--no-napcat-probe") {
      probeNapcatForward = false;
    }
  }

  if (!Number.isFinite(groupId) || !groupId || groupId <= 0) {
    throw new Error("Usage: tsx scripts/test-live-group.ts --group <group_id> [--no-napcat-probe]");
  }

  return {
    groupId,
    probeNapcatForward
  };
}

function loadOpenClawRootConfig(): Record<string, unknown> {
  for (const file of OPENCLAW_CONFIG_FILES) {
    if (!existsSync(file)) {
      continue;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }
  throw new Error("OpenClaw config not found");
}

function createTempTestFile(testId: string): string {
  const dir = path.join(tmpdir(), "my-claw-onebot-live-tests");
  mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, `onebot-file-forward-${testId}.txt`);
  writeFileSync(
    fullPath,
    [
      "my-claw-onebot live group test",
      `testId=${testId}`,
      `timestamp=${new Date().toISOString()}`
    ].join("\n"),
    "utf8"
  );
  return fullPath;
}

function buildForwardNodes(messageIds: string[]): OneBotMessageSegment[] {
  return messageIds.map((messageId) => ({
    type: "node",
    data: { id: messageId }
  }));
}

async function sendTextCase(params: {
  cfg: Record<string, unknown>;
  getConfig: () => OneBotAccountConfig | null;
  target: string;
  text: string;
}): Promise<CaseSuccess> {
  const result = await sendTextMessage(params.target, params.text, params.getConfig, params.cfg);
  if (!result.ok) {
    throw new Error(result.error || "sendTextMessage failed");
  }
  return {
    messageId: result.messageId || undefined
  };
}

async function runCase(
  results: CaseResult[],
  name: string,
  fn: () => Promise<CaseSuccess>
): Promise<CaseSuccess | null> {
  try {
    const success = await fn();
    results.push({
      ...success,
      name,
      ok: true
    });
    return success;
  } catch (error) {
    results.push({
      details: error instanceof Error ? error.message : String(error),
      name,
      ok: false
    });
    return null;
  }
}

function summarizeCase(result: CaseResult): string {
  const status = result.ok ? "ok" : "failed";
  const parts = [status];
  if (result.details) {
    parts.push(result.details);
  }
  if (result.forwardId) {
    parts.push(`forward=${result.forwardId}`);
  }
  return `${result.name}: ${parts.join(" | ")}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rootConfig = loadOpenClawRootConfig();
  const configured = getOneBotConfig({ config: rootConfig });
  if (!configured) {
    throw new Error("OneBot channel is not configured");
  }

  const baseConfig: OneBotAccountConfig = {
    ...configured,
    provider: configured.provider ?? "generic"
  };
  const napcatProbeConfig: OneBotAccountConfig = {
    ...baseConfig,
    provider: "napcat"
  };

  const target = `group:${options.groupId}`;
  const testId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const filePath = createTempTestFile(testId);
  const fileName = path.basename(filePath);
  const results: CaseResult[] = [];

  const baseGetter = () => baseConfig;
  const napcatGetter = () => napcatProbeConfig;

  await runCase(results, "announce_start", () => sendTextCase({
    cfg: rootConfig,
    getConfig: baseGetter,
    target,
    text: `[OneBot live test ${testId}] 开始 file/forward 联调，请忽略`
  }));

  const seedA = await runCase(results, "seed_message_a", () => sendTextCase({
    cfg: rootConfig,
    getConfig: baseGetter,
    target,
    text: `[OneBot live test ${testId}] forward seed A`
  }));

  const seedB = await runCase(results, "seed_message_b", () => sendTextCase({
    cfg: rootConfig,
    getConfig: baseGetter,
    target,
    text: `[OneBot live test ${testId}] forward seed B`
  }));

  await runCase(results, "file_marker_send", async () => {
    const success = await sendTextCase({
      cfg: rootConfig,
      getConfig: baseGetter,
      target,
      text: `[[file:${filePath}|${fileName}]]`
    });
    return {
      ...success,
      details: `file=${fileName}`
    };
  });

  const seedIds = [seedA?.messageId, seedB?.messageId].filter((value): value is string => Boolean(value));
  if (seedIds.length === 2) {
    await runCase(results, "forward_marker_current_config", async () => {
      const success = await sendTextCase({
        cfg: rootConfig,
        getConfig: baseGetter,
        target,
        text: `[[forward:${seedIds.join(",")}]]`
      });
      return {
        ...success,
        details: baseConfig.provider === "napcat"
          ? "provider=napcat"
          : `provider=${baseConfig.provider}; current path may fallback to plain text`
      };
    });

    if (options.probeNapcatForward) {
      await runCase(results, "forward_action_napcat_probe", async () => {
        const result = await sendForwardMsg({
          getConfig: napcatGetter,
          groupId: options.groupId,
          messages: buildForwardNodes(seedIds)
        });
        let details = "napcat action sent";
        if (result.forwardId) {
          const forwarded = await getForwardMsg(result.forwardId);
          const nodeCount = Array.isArray(forwarded?.messages) ? forwarded.messages.length : 0;
          details = `napcat action sent; fetchedNodes=${nodeCount}`;
        }

        return {
          details,
          forwardId: result.forwardId,
          messageId: result.messageId != null ? String(result.messageId) : undefined
        };
      });
    }
  } else {
    results.push({
      details: "seed messages missing message_id",
      name: "forward_dependency_check",
      ok: false
    });
  }

  const summaryLines = results.map((item) => summarizeCase(item)).join("\n");
  await runCase(results, "announce_summary", () => sendTextCase({
    cfg: rootConfig,
    getConfig: baseGetter,
    target,
    text: `[OneBot live test ${testId}] 完成\n${summaryLines}`
  }));

  const printable = {
    configuredProvider: baseConfig.provider,
    groupId: options.groupId,
    probeNapcatForward: options.probeNapcatForward,
    results,
    testId
  };
  console.log(JSON.stringify(printable, null, 2));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    stopConnection();
  });

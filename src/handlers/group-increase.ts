import { getGroupIncreaseConfig, getRenderMarkdownToPlain } from "../config.js";
import { getAvatarUrl, getGroupInfo, getGroupMemberInfo, getStrangerInfo, sendGroupMsg } from "../connection.js";
import { markdownToPlain } from "../markdown.js";
import type { OneBotMessage } from "../types.js";

interface GroupIncreaseContext {
  groupId: number;
  groupName: string;
  userId: number;
  userName: string;
  avatarUrl: string;
}

async function resolveContext(groupId: number, userId: number): Promise<GroupIncreaseContext> {
  const [groupInfo, memberInfo, strangerInfo] = await Promise.all([
    getGroupInfo(groupId),
    getGroupMemberInfo(groupId, userId),
    getStrangerInfo(userId)
  ]);

  const groupName = groupInfo?.group_name?.trim() || String(groupId);
  const userName = memberInfo?.card?.trim() || memberInfo?.nickname?.trim() || strangerInfo?.nickname?.trim() || String(userId);

  return {
    groupId,
    groupName,
    userId,
    userName,
    avatarUrl: getAvatarUrl(userId)
  };
}

function applyTemplate(template: string, ctx: GroupIncreaseContext): string {
  return template
    .replace(/\{name\}/g, ctx.userName)
    .replace(/\{groupName\}/g, ctx.groupName)
    .replace(/\{userId\}/g, String(ctx.userId))
    .replace(/\{groupId\}/g, String(ctx.groupId))
    .replace(/\{avatarUrl\}/g, ctx.avatarUrl);
}

export async function handleGroupIncrease(api: any, msg: OneBotMessage): Promise<void> {
  const config = getGroupIncreaseConfig(api);
  if (!config.enabled || !msg.group_id || !msg.user_id) {
    return;
  }

  const template = config.message?.trim();
  if (!template) {
    return;
  }

  try {
    const ctx = await resolveContext(msg.group_id, msg.user_id);
    const rawText = applyTemplate(template, ctx);
    const finalText = getRenderMarkdownToPlain(api) ? markdownToPlain(rawText) : rawText;
    await sendGroupMsg(ctx.groupId, finalText);
    api.logger?.info?.(`[onebot] sent group welcome to ${ctx.groupId} for ${ctx.userId}`);
  } catch (error) {
    api.logger?.error?.(`[onebot] group increase failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type OneBotWsType = "forward-websocket" | "backward-websocket";
export type OneBotProvider = "generic" | "napcat";

export interface OneBotAccountConfig {
  accountId?: string;
  enabled?: boolean;
  provider?: OneBotProvider;
  type: OneBotWsType;
  host: string;
  port: number;
  accessToken?: string;
  path?: string;
}

export interface OneBotMessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotSender {
  user_id?: number;
  nickname?: string;
  card?: string;
}

export interface OneBotMessage {
  self_id?: number;
  time?: number;
  post_type: string;
  message_type?: "private" | "group";
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  raw_message?: string;
  message?: string | OneBotMessageSegment[];
  sender?: OneBotSender;
  comment?: string;
  duration?: number;
  file?: Record<string, unknown>;
  flag?: string;
  notice_type?: string;
  meta_event_type?: string;
  operator_id?: number;
  request_type?: string;
  target_id?: number;
}

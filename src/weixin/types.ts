export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const MessageState = {
  FINISH: 2,
} as const;

export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface WeixinMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string; media?: CdnMedia; playtime?: number };
  image_item?: { media?: CdnMedia; aeskey?: string; url?: string; hd_size?: number; mid_size?: number; thumb_size?: number };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string; md5?: string };
  video_item?: { media?: CdnMedia; thumb_media?: CdnMedia; play_length?: number; video_size?: number };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  room_id?: string;
  chat_room_id?: string;
  message_type?: number;
  message_state?: number;
  msg_type?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

export interface QrStartResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QrStatusResponse {
  status?: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  sync_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface WeixinSendMessageRequest {
  msg: WeixinMessage;
}

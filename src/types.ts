export interface ServerCredentials {
  host: string;
  baseUrl: string;
  email: string;
  apiKey: string;
  notifyUserId: number;
  notifyEmail: string;
  notifyName: string;
  provisionerUserId: number;
  provisionerIsAdmin: boolean;
}

export interface BotCredential {
  host: string;
  baseUrl: string;
  channelName: string;
  email: string;
  apiKey: string;
  userId: number;
}

export interface StatusCard {
  goal: string;
  status: string;
  checklist: string[];
  decisions: string[];
}

export interface OpenQuestion {
  id: string;
  messageId: number;
  question: string;
  options: string[];
  recommendedIndex?: number;
  answer?: string;
}

/** Durable Pi-session state. Never put an API key or password in this object. */
export interface SessionAttachment {
  version: 1;
  attached: boolean;
  serverHost: string;
  channelName: string;
  streamId: number;
  topic: string;
  botEmail: string;
  botUserId: number;
  notifyUserId: number;
  statusMessageId: number;
  ownedMessageIds: number[];
  lastHandledMessageId: number;
  statusCard: StatusCard;
  openQuestions: OpenQuestion[];
  updatedAt: string;
}

export interface ZulipUser {
  user_id: number;
  email: string;
  delivery_email?: string;
  full_name: string;
  is_bot?: boolean;
  is_guest?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_active?: boolean;
  role?: number;
}

export interface ZulipMessage {
  id: number;
  sender_id: number;
  sender_email?: string;
  sender_full_name?: string;
  type?: string;
  display_recipient?: string | { id?: number; name?: string };
  stream_id?: number;
  subject?: string;
  content?: string;
  timestamp?: number;
  attachments?: ZulipAttachment[];
}

export interface ZulipAttachment {
  id?: number;
  name: string;
  path: string;
  size?: number;
  content_type?: string;
}

export interface ZulipEvent {
  id: number;
  type: string;
  message?: ZulipMessage;
  message_id?: number;
  message_ids?: number[];
  stream_id?: number;
  subject?: string;
  propagate_mode?: string;
  user_id?: number;
  emoji_name?: string;
  emoji_code?: string;
  reaction_type?: string;
  op?: string;
  [key: string]: unknown;
}

export interface EventQueue {
  queue_id: string;
  last_event_id: number;
}

export interface TopicInfo {
  name: string;
  max_id?: number;
}

export interface MessagePage {
  messages: ZulipMessage[];
  found_oldest: boolean;
  found_newest: boolean;
  history_limited?: boolean;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type PiContent = TextContent | ImageContent;

export const EVENT_TYPES = ["message", "update_message", "reaction"] as const;
export const DELIVERY_REACTION = "mail_received";
export const RESOLVED_PREFIX = "✔ ";

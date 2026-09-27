import { basename } from "node:path";
import type {
  BotCredential,
  EventQueue,
  MessagePage,
  TopicInfo,
  ZulipEvent,
  ZulipMessage,
  ZulipUser,
} from "../types.ts";

export interface ZulipBotRecord {
  username: string;
  full_name: string;
  api_key: string;
  default_sending_stream?: string | null;
  default_events_register_stream?: string | null;
  default_all_public_streams?: boolean;
}

export class ZulipApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly zulipCode?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ZulipApiError";
  }

  get isBadEventQueue(): boolean {
    return this.zulipCode === "BAD_EVENT_QUEUE_ID" || /bad event queue/i.test(this.message);
  }

  get isRetryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

function encodeForm(params: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null) continue;
    const value = Array.isArray(raw) || (typeof raw === "object" && raw !== null)
      ? JSON.stringify(raw)
      : String(raw);
    form.set(key, value);
  }
  return form;
}

function parseJson(text: string, status: number): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(text);
    if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
  } catch {
    // A bounded generic error below avoids exposing response bodies or credentials.
  }
  throw new ZulipApiError(`Zulip returned a malformed response (HTTP ${status})`, status);
}

/** Minimal typed Zulip REST client. Credentials are kept only in this instance. */
export class ZulipClient {
  readonly baseUrl: string;
  readonly host: string;
  private readonly authorization: string;

  constructor(baseUrl: string, private readonly email: string, private readonly apiKey: string) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHost(parsed.hostname))) {
      throw new Error("Zulip server URL must use HTTPS (HTTP is allowed only for localhost)");
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    parsed.search = "";
    parsed.hash = "";
    this.baseUrl = parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
    this.host = parsed.host.toLowerCase();
    this.authorization = `Basic ${Buffer.from(`${email}:${apiKey}`, "utf8").toString("base64")}`;
  }

  private endpoint(path: string): URL {
    return new URL(`${this.baseUrl}/api/v1${path.startsWith("/") ? path : `/${path}`}`);
  }

  private async request<T extends Record<string, unknown>>(
    method: string,
    path: string,
    params?: Record<string, unknown>,
    options: { signal?: AbortSignal; multipart?: FormData; unauthenticated?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    let url = this.endpoint(path);
    const headers = new Headers();
    if (!options.unauthenticated) headers.set("Authorization", this.authorization);
    let body: BodyInit | undefined;
    if (method === "GET" || method === "HEAD") {
      if (params) {
        for (const [key, value] of encodeForm(params)) url.searchParams.set(key, value);
      }
    } else if (options.multipart) {
      body = options.multipart;
    } else {
      headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
      body = encodeForm(params ?? {});
    }

    let response: Response;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs ?? 30_000);
    const abortFromCaller = () => timeoutController.abort();
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      response = await fetch(url, { method, headers, body, signal: timeoutController.signal });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (timeoutController.signal.aborted) throw new ZulipApiError("Zulip request timed out", 408);
      throw new ZulipApiError("Could not connect to the Zulip server");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = parseJson(text, response.status);
    } catch (error) {
      if (!response.ok) throw new ZulipApiError(`Zulip request failed (HTTP ${response.status})`, response.status);
      throw error;
    }
    if (!response.ok || payload.result === "error") {
      let msg = typeof payload.msg === "string" ? payload.msg.slice(0, 300) : "Request failed";
      const secrets = [this.apiKey, ...Object.entries(params ?? {}).filter(([key]) => /password|api.?key|token/i.test(key)).map(([, value]) => String(value))].filter(Boolean);
      for (const secret of secrets) msg = msg.replaceAll(secret, "<redacted>");
      const retry = Number(response.headers.get("retry-after"));
      throw new ZulipApiError(
        `Zulip request failed: ${msg}`,
        response.status,
        typeof payload.code === "string" ? payload.code : undefined,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    return payload as T;
  }

  async getProfile(signal?: AbortSignal): Promise<ZulipUser> {
    const response = await this.request<Record<string, unknown>>("GET", "/users/me", undefined, { signal });
    const user = (response.user ?? response) as ZulipUser;
    if (typeof user.user_id !== "number") throw new Error("Zulip profile response is missing its user ID");
    return user;
  }

  async fetchApiKey(email: string, password: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request<{ api_key?: string }>("POST", "/fetch_api_key", {
      username: email,
      password,
    }, { signal, unauthenticated: true });
    if (typeof result.api_key !== "string" || !result.api_key) throw new Error("Zulip did not return an API key");
    return result.api_key;
  }

  async listUsers(signal?: AbortSignal): Promise<ZulipUser[]> {
    const result = await this.request<{ members?: ZulipUser[] }>("GET", "/users", undefined, { signal });
    return Array.isArray(result.members) ? result.members : [];
  }

  async getUser(userId: number, signal?: AbortSignal): Promise<ZulipUser> {
    const result = await this.request<{ user?: ZulipUser }>("GET", `/users/${userId}`, undefined, { signal });
    if (!result.user) throw new Error("Zulip user lookup returned no user");
    return result.user;
  }

  async listBots(signal?: AbortSignal): Promise<ZulipBotRecord[]> {
    const result = await this.request<{ bots?: ZulipBotRecord[] }>("GET", "/bots", undefined, { signal });
    return Array.isArray(result.bots) ? result.bots : [];
  }

  async listSubscriptions(signal?: AbortSignal): Promise<Array<{ name: string; stream_id: number }>> {
    const result = await this.request<{ subscriptions?: Array<{ name: string; stream_id: number }> }>(
      "GET", "/users/me/subscriptions", undefined, { signal },
    );
    return Array.isArray(result.subscriptions) ? result.subscriptions : [];
  }

  async getStream(streamId: number, signal?: AbortSignal): Promise<{ stream_id: number; name: string; invite_only: boolean; description?: string }> {
    const result = await this.request<{ stream?: { stream_id: number; name: string; invite_only?: boolean; description?: string } }>(
      "GET", `/streams/${streamId}`, undefined, { signal },
    );
    if (!result.stream || typeof result.stream.stream_id !== "number") throw new Error("Zulip channel lookup returned no stream");
    return { stream_id: result.stream.stream_id, name: result.stream.name, invite_only: !!result.stream.invite_only, description: result.stream.description };
  }

  async listTopics(streamId: number, signal?: AbortSignal): Promise<TopicInfo[]> {
    const result = await this.request<{ topics?: TopicInfo[] }>(
      "GET", `/users/me/${streamId}/topics`, undefined, { signal },
    );
    return Array.isArray(result.topics) ? result.topics : [];
  }

  async getMessage(messageId: number, signal?: AbortSignal): Promise<ZulipMessage> {
    const result = await this.request<{ message?: ZulipMessage }>("GET", `/messages/${messageId}`, undefined, { signal });
    if (!result.message) throw new Error("Zulip message lookup returned no message");
    return result.message;
  }

  async listMessages(
    streamName: string,
    topic: string,
    anchor: number | "newest",
    numBefore = 0,
    numAfter = 100,
    signal?: AbortSignal,
  ): Promise<MessagePage> {
    const result = await this.request<MessagePage & Record<string, unknown>>("GET", "/messages", {
      anchor,
      num_before: numBefore,
      num_after: numAfter,
      narrow: [["channel", streamName], ["topic", topic]],
    }, { signal });
    return { messages: result.messages ?? [], found_oldest: !!result.found_oldest, found_newest: !!result.found_newest };
  }

  async sendMessage(streamName: string, topic: string, content: string, signal?: AbortSignal): Promise<number> {
    const result = await this.request<{ id?: number }>("POST", "/messages", {
      type: "stream", to: streamName, topic, content,
    }, { signal });
    if (typeof result.id !== "number") throw new Error("Zulip did not return the new message ID");
    return result.id;
  }

  async editMessage(messageId: number, params: { content?: string; topic?: string; propagate_mode?: string }, signal?: AbortSignal): Promise<void> {
    await this.request("PATCH", `/messages/${messageId}`, params, { signal });
  }

  async addReaction(messageId: number, emojiName: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/messages/${messageId}/reactions`, { emoji_name: emojiName }, { signal });
  }

  async sendTyping(streamId: number, topic: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/typing", { op: "start", type: "stream", stream_id: streamId, topic }, { signal });
  }

  async registerEventQueue(streamName: string, signal?: AbortSignal): Promise<EventQueue> {
    const result = await this.request<{ queue_id?: string; last_event_id?: number }>("POST", "/register", {
      event_types: ["message", "update_message", "reaction"],
      narrow: [["channel", streamName]],
      queue_lifespan_secs: 600,
    }, { signal });
    if (typeof result.queue_id !== "string" || typeof result.last_event_id !== "number") {
      throw new Error("Zulip did not return an event queue");
    }
    return { queue_id: result.queue_id, last_event_id: result.last_event_id };
  }

  async pollEvents(queue: EventQueue, lastEventId: number, signal?: AbortSignal): Promise<ZulipEvent[]> {
    const result = await this.request<{ events?: ZulipEvent[] }>("GET", "/events", {
      queue_id: queue.queue_id,
      last_event_id: lastEventId,
    }, { signal, timeoutMs: 120_000 });
    return Array.isArray(result.events) ? result.events : [];
  }

  async createPrivateChannel(name: string, description: string, subscribers: number[], signal?: AbortSignal): Promise<number> {
    const result = await this.request<{ id?: number }>("POST", "/channels/create", {
      name, description, invite_only: true, subscribers,
    }, { signal });
    if (typeof result.id !== "number") throw new Error("Zulip did not return the new channel ID");
    return result.id;
  }

  async createBot(fullName: string, shortName: string, defaultStream: string, signal?: AbortSignal): Promise<number> {
    const result = await this.request<{ user_id?: number }>("POST", "/bots", {
      full_name: fullName,
      short_name: shortName,
      default_sending_stream: defaultStream,
    }, { signal });
    if (typeof result.user_id !== "number") throw new Error("Zulip did not return the new bot ID");
    return result.user_id;
  }

  async setBotGuest(botId: number, signal?: AbortSignal): Promise<void> {
    // Zulip 12.3's API accepts the numeric role enum, not the label "guest".
    await this.request("PATCH", `/bots/${botId}`, { role: 600 }, { signal });
  }

  async getBotApiKey(botId: number, signal?: AbortSignal): Promise<string> {
    const result = await this.request<{ api_key?: string }>("GET", `/bots/${botId}/api_key`, undefined, { signal });
    if (typeof result.api_key !== "string" || !result.api_key) throw new Error("Could not retrieve the project bot key");
    return result.api_key;
  }

  async subscribePrincipals(streamName: string, userIds: number[], signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/users/me/subscriptions", {
      subscriptions: [{ name: streamName }],
      principals: userIds,
      authorization_errors_fatal: true,
    }, { signal });
  }

  async unsubscribeSelf(streamName: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", "/users/me/subscriptions", { subscriptions: [streamName] }, { signal });
  }

  async uploadFile(fileName: string, bytes: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), basename(fileName));
    const result = await this.request<{ uri?: string }>("POST", "/user_uploads", undefined, { signal, multipart: form, timeoutMs: 120_000 });
    if (typeof result.uri !== "string") throw new Error("Zulip did not return the uploaded file URI");
    return result.uri;
  }

  async downloadFile(uri: string, signal?: AbortSignal, maxBytes = 8 * 1024 * 1024): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const path = new URL(uri, `${this.baseUrl}/`).pathname;
    if (!path.startsWith("/user_uploads/")) throw new Error("Invalid Zulip attachment path");
    const metadata = await this.request<{ url?: string }>("GET", path, undefined, { signal });
    if (typeof metadata.url !== "string") throw new Error("Zulip did not return a temporary download URL");
    const downloadUrl = new URL(metadata.url, `${this.baseUrl}/`);
    let response: Response;
    try {
      // The temporary URL is a bearer token. Do not forward the Zulip API key.
      response = await fetch(downloadUrl, { signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ZulipApiError("Could not download the Zulip attachment");
    }
    if (!response.ok) throw new ZulipApiError(`Attachment download failed (HTTP ${response.status})`, response.status);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Zulip attachment exceeds the download size limit");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Zulip attachment response has no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Zulip attachment exceeds the download size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, mimeType: response.headers.get("content-type") ?? "application/octet-stream" };
  }
}

export function normalizeServerUrl(input: string, allowLocalHttp = false): string {
  const value = input.trim();
  const parsed = new URL(value.includes("://") ? value : `https://${value}`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Enter a server URL without credentials, query, or fragment");
  if (parsed.protocol !== "https:" && !(allowLocalHttp && parsed.protocol === "http:" && isLocalHost(parsed.hostname))) {
    throw new Error("Use an HTTPS Zulip server URL");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

export function botCredentialFromRecord(host: string, baseUrl: string, channelName: string, record: ZulipBotRecord, userId: number): BotCredential {
  return {
    host,
    baseUrl,
    channelName,
    email: record.username,
    apiKey: record.api_key,
    userId,
  };
}

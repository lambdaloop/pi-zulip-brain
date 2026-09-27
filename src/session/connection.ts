import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BotCredential, EventQueue, ImageContent, OpenQuestion, PiContent, SessionAttachment, ZulipEvent, ZulipMessage, ZulipUser } from "../types.ts";
import { DELIVERY_REACTION, RESOLVED_PREFIX } from "../types.ts";
import { ZulipApiError, ZulipClient } from "../zulip/client.ts";
import { addOwnedMessage, persistAttachment } from "./state.ts";
import { attachmentMimeType, formatIncomingMessage, formatOutbound, isImageAttachment, messagePlainText } from "./format.ts";

export interface ConnectionOptions {
  pi: ExtensionAPI;
  state: SessionAttachment;
  bot: BotCredential;
  getContext: () => ExtensionContext;
  onConnectionChange?: (connected: boolean) => void;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_BACKLOG_PAGES = 10;
const CHOICE_NAMES: Record<string, number> = {
  one: 0, keycap_1: 0, two: 1, keycap_2: 1, three: 2, keycap_3: 2, four: 3, keycap_4: 3, five: 4, keycap_5: 4,
};
const CHOICE_REACTIONS = ["one", "two", "three", "four", "five"] as const;

/** Owns one channel-narrow event queue. Topic/sender filtering remains local and strict. */
export class ZulipConnection {
  private readonly client: ZulipClient;
  private queue?: EventQueue;
  private lastEventId = 0;
  private controller?: AbortController;
  private loop?: Promise<void>;
  private readonly users = new Map<number, ZulipUser>();
  private readonly deliveredIds = new Set<number>();
  private readonly waiters = new Map<string, Set<(answer: string) => void>>();
  private connected = false;

  constructor(private readonly options: ConnectionOptions) {
    this.client = new ZulipClient(options.bot.baseUrl, options.bot.email, options.bot.apiKey);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async start(options: { previewBacklog?: boolean } = {}): Promise<boolean> {
    if (this.loop || this.controller) return true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      const profile = await this.client.getProfile(signal);
      if (profile.user_id !== this.options.state.botUserId || !profile.is_bot) {
        throw new Error("The saved Zulip credential is not the expected project bot");
      }
      const subscriptions = await this.client.listSubscriptions(signal);
      const stream = subscriptions.find((item) => item.name.toLowerCase() === this.options.state.channelName.toLowerCase());
      if (!stream) throw new Error("The project bot is no longer subscribed to its private channel");
      this.options.state.streamId = stream.stream_id;
      await this.reconcileOwnedMessages(signal);
      this.queue = await this.client.registerEventQueue(this.options.state.channelName, signal);
      this.lastEventId = this.queue.last_event_id;

      const missed = await this.fetchMissedMessages(signal);
      const humanMissed = await this.filterHumanMessages(missed, signal);
      if (options.previewBacklog && humanMissed.length) {
        const accepted = await this.previewBacklog(humanMissed);
        if (!accepted) {
          await this.stop();
          return false;
        }
        await this.deliverBatch(humanMissed);
      } else if (humanMissed.length) {
        await this.deliverBatch(humanMissed);
      }
      this.connected = true;
      this.options.onConnectionChange?.(true);
      this.loop = this.pollLoop(signal).finally(() => {
        this.loop = undefined;
        this.connected = false;
        this.options.onConnectionChange?.(false);
      });
      return true;
    } catch (error) {
      this.controller.abort();
      this.controller = undefined;
      this.connected = false;
      this.options.onConnectionChange?.(false);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
    this.queue = undefined;
    this.connected = false;
    this.options.onConnectionChange?.(false);
    if (this.loop) await this.loop.catch(() => undefined);
    this.loop = undefined;
    this.resolveAllWaiters("Zulip connection stopped before the question was answered.");
  }

  waitForQuestion(questionId: string, signal?: AbortSignal): Promise<string> {
    const question = this.options.state.openQuestions.find((item) => item.id === questionId);
    if (!question) return Promise.reject(new Error(`No open Zulip question with ID ${questionId}`));
    if (question.answer) return Promise.resolve(question.answer);
    return new Promise((resolve, reject) => {
      const listeners = this.waiters.get(questionId) ?? new Set<(answer: string) => void>();
      const finish = (answer: string) => {
        signal?.removeEventListener("abort", abort);
        listeners.delete(finish);
        if (!listeners.size) this.waiters.delete(questionId);
        resolve(answer);
      };
      const abort = () => {
        listeners.delete(finish);
        if (!listeners.size) this.waiters.delete(questionId);
        reject(signal?.reason ?? new Error("Wait cancelled"));
      };
      listeners.add(finish);
      this.waiters.set(questionId, listeners);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async createQuestion(question: string, options: string[], recommendedIndex?: number): Promise<{ id: string; reactionsAdded: number; reactionErrors: string[] }> {
    const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const state = this.options.state;
    const notify = await this.client.getUser(state.notifyUserId).catch(() => undefined);
    const mention = notify ? `@**${notify.full_name.replace(/[|*<>]/g, "")}|${notify.user_id}**\n` : "";
    const optionLines = options.map((option, index) => {
      const emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][index];
      const mark = index === recommendedIndex ? " *(recommended)*" : "";
      return `${emoji} ${option}${mark}`;
    });
    const text = `${mention}**Question ID:** ${id}\n${question}\n\n${optionLines.join("\n")}\n\nReact to this message with the matching number, or reply with the question ID and your answer.`;
    const messageId = await this.client.sendMessage(state.channelName, state.topic, text);
    const reactions = await Promise.allSettled(options.map((_, index) =>
      this.client.addReaction(messageId, CHOICE_REACTIONS[index]!),
    ));
    const reactionErrors = reactions.flatMap((result, index) => result.status === "rejected"
      ? [`${index + 1}: ${safeError(result.reason)}`]
      : []);
    if (reactionErrors.length) {
      this.notify(`Could not add ${reactionErrors.length} choice reaction(s) to the Zulip question: ${reactionErrors.join("; ")}. Replies still work.`, "warning");
    }
    const record: OpenQuestion = { id, messageId, question, options, recommendedIndex };
    state.openQuestions.push(record);
    addOwnedMessage(state, messageId);
    state.statusCard.status = `⏸ waiting on you: ${question}`;
    persistAttachment(this.options.pi, state);
    await this.refreshStatusCard();
    return { id, reactionsAdded: reactions.length - reactionErrors.length, reactionErrors };
  }

  async updateStatusCard(patch?: Partial<{ goal: string; status: string; checklist: string[]; decision: string }>): Promise<void> {
    const state = this.options.state;
    if (!patch) return this.refreshStatusCard();
    if (patch.goal !== undefined) state.statusCard.goal = patch.goal;
    if (patch.status !== undefined) state.statusCard.status = patch.status;
    if (patch.checklist !== undefined) state.statusCard.checklist = patch.checklist.slice(0, 30);
    if (patch.decision?.trim()) state.statusCard.decisions.push(patch.decision.trim());
    state.statusCard.decisions = state.statusCard.decisions.slice(-30);
    await this.client.editMessage(state.statusMessageId, { content: renderCard(state.statusCard) });
    persistAttachment(this.options.pi, state);
  }

  async resolveTopic(resolve: boolean): Promise<void> {
    const state = this.options.state;
    const plainTopic = state.topic.startsWith(RESOLVED_PREFIX) ? state.topic.slice(RESOLVED_PREFIX.length) : state.topic;
    const target = resolve ? `${RESOLVED_PREFIX}${plainTopic}` : plainTopic;
    if (target !== state.topic) {
      await this.client.editMessage(state.statusMessageId, { topic: target, propagate_mode: "change_all" });
      state.topic = target;
    }
    state.statusCard.status = resolve ? "✔ done" : "working";
    await this.client.editMessage(state.statusMessageId, { content: renderCard(state.statusCard) });
    persistAttachment(this.options.pi, state);
  }

  async post(level: "needs_you" | "milestone", text: string, files: string[] = [], cwd = process.cwd()): Promise<number> {
    const state = this.options.state;
    const mention = level === "needs_you"
      ? await this.client.getUser(this.options.state.notifyUserId).then((user) => ` @**${user.full_name.replace(/[|*<>]/g, "")}|${user.user_id}**`).catch(() => "")
      : "";
    let content = level === "needs_you" ? `${mention ? `${mention.trim()} ` : ""}${formatOutbound(text)}` : formatOutbound(text);
    if (files.length > 5) throw new Error("Attach at most five files to a Zulip post");
    if (files.length) {
      const root = await realpath(cwd);
      const links: string[] = [];
      let total = 0;
      for (const inputPath of files) {
        const absolute = await realpath(resolve(cwd, inputPath));
        const rel = relative(root, absolute);
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Zulip attachments must be files inside the current project directory");
        const info = await stat(absolute);
        if (!info.isFile() || info.size > 15 * 1024 * 1024) throw new Error(`Attachment is not a regular file under 15 MiB: ${inputPath}`);
        total += info.size;
        if (total > 30 * 1024 * 1024) throw new Error("Combined Zulip attachments may not exceed 30 MiB");
        const bytes = await readFile(absolute);
        const uri = await this.client.uploadFile(absolute, bytes, mimeTypeForPath(absolute));
        links.push(`[${absolute.split("/").at(-1)}](${new URL(uri, `${this.options.bot.baseUrl}/`).toString()})`);
      }
      content += `\n\n${links.join("\n")}`;
    }
    const id = await this.client.sendMessage(state.channelName, state.topic, content);
    addOwnedMessage(state, id);
    persistAttachment(this.options.pi, state);
    return id;
  }

  async read(anchor?: number, limit = 30, signal?: AbortSignal): Promise<ZulipMessage[]> {
    const state = this.options.state;
    const page = await this.client.listMessages(state.channelName, state.topic, anchor ?? "newest", limit, 0, signal);
    return page.messages.filter((message) => message.stream_id === state.streamId && message.subject === state.topic);
  }

  async imagesForMessage(message: ZulipMessage, signal?: AbortSignal): Promise<ImageContent[]> {
    const images: ImageContent[] = [];
    for (const attachment of (message.attachments ?? []).slice(0, MAX_IMAGES_PER_MESSAGE)) {
      if (!isImageAttachment(attachment) || (attachment.size !== undefined && attachment.size > MAX_IMAGE_BYTES)) continue;
      try {
        const downloaded = await this.client.downloadFile(attachment.path, signal, MAX_IMAGE_BYTES);
        if (downloaded.bytes.length > MAX_IMAGE_BYTES || !downloaded.mimeType.startsWith("image/")) continue;
        images.push({ type: "image", data: Buffer.from(downloaded.bytes).toString("base64"), mimeType: attachmentMimeType(attachment, downloaded.mimeType) });
      } catch {
        // The caller still receives attachment metadata in the text result.
      }
    }
    return images;
  }

  async getStatus(): Promise<string> {
    const state = this.options.state;
    const questions = state.openQuestions.filter((question) => !question.answer);
    return [
      `Server: ${state.serverHost}`,
      `Channel: #${state.channelName} (stream ${state.streamId})`,
      `Topic: ${state.topic}`,
      `Connection: ${this.connected ? "connected" : "disconnected"}`,
      `Status: ${state.statusCard.status}`,
      `Open questions: ${questions.length ? questions.map((q) => `${q.id}: ${q.question}`).join("; ") : "none"}`,
    ].join("\n");
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      if (!this.queue) {
        await this.recreateQueue(signal);
        failures = 0;
        continue;
      }
      try {
        const events = await this.client.pollEvents(this.queue, this.lastEventId, signal);
        for (const event of events) {
          if (signal.aborted) break;
          try {
            await this.handleEvent(event, signal);
          } catch (error) {
            this.notify(`Could not process a Zulip event: ${safeError(error)}`, "warning");
          } finally {
            if (typeof event.id === "number") this.lastEventId = Math.max(this.lastEventId, event.id);
          }
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof ZulipApiError && error.isBadEventQueue) {
          this.queue = undefined;
          await this.recreateQueue(signal);
          failures = 0;
          continue;
        }
        failures++;
        if (!(error instanceof ZulipApiError) || !error.isRetryable) {
          this.notify(`Zulip connection issue: ${safeError(error)}`, "warning");
        }
        await sleep(Math.min(error instanceof ZulipApiError ? error.retryAfterSeconds ?? 0 : 0, 30) || Math.min(2 ** failures, 30), signal);
      }
    }
  }

  private async recreateQueue(signal: AbortSignal): Promise<void> {
    this.queue = await this.client.registerEventQueue(this.options.state.channelName, signal);
    this.lastEventId = this.queue.last_event_id;
    await this.reconcileOwnedMessages(signal);
    const missed = await this.fetchMissedMessages(signal);
    if (missed.length) await this.deliverBatch(missed);
    this.connected = true;
    this.options.onConnectionChange?.(true);
  }

  private async handleEvent(event: ZulipEvent, signal: AbortSignal): Promise<void> {
    if (event.type === "message" && event.message) {
      await this.handleMessage(event.message, signal);
      return;
    }
    if (event.type === "update_message") {
      await this.handleUpdate(event);
      return;
    }
    if (event.type === "reaction") await this.handleReaction(event, signal);
  }

  private async handleUpdate(event: ZulipEvent): Promise<void> {
    const state = this.options.state;
    const affected = event.message_ids ?? (typeof event.message_id === "number" ? [event.message_id] : []);
    if (!affected.some((id) => state.ownedMessageIds.includes(id))) return;
    if (typeof event.stream_id === "number" && event.stream_id !== state.streamId) {
      state.attached = false;
      persistAttachment(this.options.pi, state);
      this.notify("A Zulip-owned message moved to another channel; detached to preserve topic isolation.", "error");
      void this.stop();
      return;
    }
    if (typeof event.subject === "string" && event.subject !== state.topic) {
      state.topic = event.subject;
      persistAttachment(this.options.pi, state);
      this.options.getContext().ui.setStatus("pi-zulip", `Zulip #${state.channelName} › ${state.topic}`);
    }
  }

  private async handleMessage(message: ZulipMessage, signal: AbortSignal): Promise<void> {
    const state = this.options.state;
    if (message.stream_id !== state.streamId || message.subject !== state.topic) return;
    if (message.sender_id === state.botUserId || message.id <= state.lastHandledMessageId || this.deliveredIds.has(message.id)) return;
    const sender = await this.getUser(message.sender_id, signal);
    if (!sender || sender.is_bot) return;
    const question = state.openQuestions.find((item) => !item.answer && messagePlainText(message).includes(item.id));
    if (question && this.waiters.has(question.id)) {
      this.answerQuestion(question.id, `${sender.full_name}: ${messagePlainText(message)}`);
      if (!(await this.addReceipt(message.id, signal))) {
        this.notify("Zulip answer reached the waiting tool, but its 📨 delivery receipt could not be added.", "warning");
      }
      return;
    }
    const extra = question ? `Reply to decision ${question.id}.` : undefined;
    const delivered = await this.deliverBatch([message], new Map([[sender.user_id, sender]]), extra ? new Map([[message.id, extra]]) : undefined);
    if (question && delivered) this.answerQuestion(question.id, messagePlainText(message));
  }

  private async handleReaction(event: ZulipEvent, signal: AbortSignal): Promise<void> {
    const messageId = event.message_id;
    if (typeof messageId !== "number") return;
    const question = this.options.state.openQuestions.find((item) => item.messageId === messageId && !item.answer);
    if (!question || event.op === "remove") return;
    const userId = event.user_id;
    if (typeof userId !== "number") return;
    const sender = await this.getUser(userId, signal);
    if (!sender || sender.is_bot) return;
    const optionIndex = typeof event.emoji_name === "string" ? CHOICE_NAMES[event.emoji_name] : undefined;
    if (optionIndex === undefined || optionIndex >= question.options.length) return;
    const answer = `${optionIndex + 1}. ${question.options[optionIndex]}`;
    if (this.waiters.has(question.id)) {
      this.answerQuestion(question.id, `${sender.full_name}: ${answer}`);
      persistAttachment(this.options.pi, this.options.state);
      return;
    }
    try {
      this.options.pi.sendUserMessage(`[Zulip decision from ${sender.full_name}] ${question.id}: ${answer}`, {
        ...(this.options.getContext().isIdle() ? {} : { deliverAs: "steer" as const }),
      });
      this.answerQuestion(question.id, answer);
      persistAttachment(this.options.pi, this.options.state);
    } catch (error) {
      this.notify(`Pi could not enqueue a Zulip decision: ${safeError(error)}`, "error");
    }
  }

  private answerQuestion(questionId: string, answer: string): void {
    const question = this.options.state.openQuestions.find((item) => item.id === questionId);
    if (!question || question.answer) return;
    question.answer = answer;
    const listeners = this.waiters.get(questionId);
    if (listeners) for (const resolve of [...listeners]) resolve(answer);
    if (this.options.state.statusCard.status.startsWith("⏸ waiting on you:")) {
      this.options.state.statusCard.status = "working";
    }
    persistAttachment(this.options.pi, this.options.state);
    void this.refreshStatusCard();
  }

  private async deliverBatch(
    messages: ZulipMessage[],
    knownUsers = new Map<number, ZulipUser>(),
    extras = new Map<number, string>(),
  ): Promise<boolean> {
    const accepted: ZulipMessage[] = [];
    const userById = knownUsers;
    for (const message of [...messages].sort((a, b) => a.id - b.id)) {
      if (message.stream_id !== this.options.state.streamId || message.subject !== this.options.state.topic) continue;
      if (message.sender_id === this.options.state.botUserId || message.id <= this.options.state.lastHandledMessageId || this.deliveredIds.has(message.id)) continue;
      let user = userById.get(message.sender_id);
      if (!user) user = await this.getUser(message.sender_id, this.controller?.signal);
      if (!user || user.is_bot) continue;
      userById.set(user.user_id, user);
      accepted.push(message);
    }
    if (!accepted.length) return false;

    const content: PiContent[] = [];
    const ackIds: number[] = [];
    let downloadedImageBytes = 0;
    for (const message of accepted) {
      const user = userById.get(message.sender_id);
      const prefix = extras.get(message.id);
      content.push({ type: "text", text: formatIncomingMessage(message, user, this.options.state.channelName, this.options.state.topic, prefix) });
      let imageCount = 0;
      for (const attachment of message.attachments ?? []) {
        if (imageCount >= MAX_IMAGES_PER_MESSAGE || downloadedImageBytes >= MAX_BATCH_IMAGE_BYTES) break;
        if (!isImageAttachment(attachment) || (attachment.size !== undefined && attachment.size > MAX_IMAGE_BYTES)) continue;
        try {
          const downloaded = await this.client.downloadFile(attachment.path, this.controller?.signal, Math.min(MAX_IMAGE_BYTES, MAX_BATCH_IMAGE_BYTES - downloadedImageBytes));
          if (downloaded.bytes.length > MAX_IMAGE_BYTES || !downloaded.mimeType.startsWith("image/")) continue;
          downloadedImageBytes += downloaded.bytes.length;
          imageCount++;
          content.push({
            type: "image",
            data: Buffer.from(downloaded.bytes).toString("base64"),
            mimeType: attachmentMimeType(attachment, downloaded.mimeType),
          } as ImageContent);
        } catch {
          this.notify(`Could not download Zulip image attachment: ${attachment.name}`, "warning");
        }
      }
      ackIds.push(message.id);
    }

    try {
      this.options.pi.sendUserMessage(content, {
        ...(this.options.getContext().isIdle() ? {} : { deliverAs: "steer" as const }),
      });
    } catch (error) {
      this.notify(`Pi could not enqueue a Zulip message: ${safeError(error)}`, "error");
      return false;
    }

    for (const id of ackIds) this.deliveredIds.add(id);
    this.options.state.lastHandledMessageId = Math.max(this.options.state.lastHandledMessageId, ...ackIds);
    persistAttachment(this.options.pi, this.options.state);
    for (const id of ackIds) {
      if (!(await this.addReceipt(id))) {
        // Delivery succeeded. A missing receipt must not block other messages.
        this.notify("Zulip message reached Pi, but the 📨 delivery receipt could not be added.", "warning");
      }
    }
    return true;
  }

  private async addReceipt(messageId: number, signal = this.controller?.signal): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.addReaction(messageId, DELIVERY_REACTION, signal);
        return true;
      } catch (error) {
        // Zulip reports an error if the reaction already exists; treat that as delivered.
        if (error instanceof ZulipApiError && /already/i.test(error.message)) return true;
        if (signal?.aborted || (error instanceof ZulipApiError && !error.isRetryable)) return false;
        if (signal) await sleep(attempt + 1, signal);
      }
    }
    return false;
  }

  private async fetchMissedMessages(signal: AbortSignal): Promise<ZulipMessage[]> {
    if (this.options.state.lastHandledMessageId <= 0) return [];
    let anchor: number | "newest" = this.options.state.lastHandledMessageId;
    const messages = new Map<number, ZulipMessage>();
    for (let pageNumber = 0; pageNumber < MAX_BACKLOG_PAGES; pageNumber++) {
      const page = await this.client.listMessages(this.options.state.channelName, this.options.state.topic, anchor, 0, 100, signal);
      for (const message of page.messages) {
        if (message.id > this.options.state.lastHandledMessageId) messages.set(message.id, message);
      }
      if (page.found_newest || page.messages.length === 0) break;
      const last = page.messages.at(-1)?.id;
      if (typeof last !== "number" || last <= Number(anchor)) break;
      anchor = last;
    }
    return [...messages.values()].sort((a, b) => a.id - b.id);
  }

  private async reconcileOwnedMessages(signal: AbortSignal): Promise<void> {
    const state = this.options.state;
    for (const messageId of [state.statusMessageId]) {
      try {
        const message = await this.client.getMessage(messageId, signal);
        if (message.stream_id !== state.streamId) {
          state.attached = false;
          persistAttachment(this.options.pi, state);
          throw new Error("An owned Zulip message moved to another channel");
        }
        if (typeof message.subject === "string" && message.subject !== state.topic) state.topic = message.subject;
      } catch (error) {
        if (error instanceof ZulipApiError && error.status === 404) continue;
        if (error instanceof Error && error.message.includes("moved to another channel")) throw error;
        // A deleted/old status post should not prevent reconnect if other state is intact.
      }
    }
    persistAttachment(this.options.pi, state);
  }

  private async filterHumanMessages(messages: ZulipMessage[], signal?: AbortSignal): Promise<ZulipMessage[]> {
    const humans: ZulipMessage[] = [];
    for (const message of messages) {
      if (message.sender_id === this.options.state.botUserId) continue;
      const sender = await this.getUser(message.sender_id, signal);
      if (sender && !sender.is_bot) humans.push(message);
    }
    return humans;
  }

  private async previewBacklog(messages: ZulipMessage[]): Promise<boolean> {
    const previewLines: string[] = [];
    for (const message of messages.slice(0, 8)) {
      const sender = await this.getUser(message.sender_id, this.controller?.signal);
      previewLines.push(`• ${sender?.full_name ?? message.sender_email ?? "human"}: ${messagePlainText(message, 220) || "(attachment)"}`);
    }
    const preview = previewLines.join("\n");
    const more = messages.length > 8 ? `\n…and ${messages.length - 8} more` : "";
    const context = this.options.getContext();
    if (!context.hasUI) return false;
    return context.ui.confirm(
      "Missed Zulip messages",
      `${messages.length} human message(s) arrived while this session was detached. Deliver them to the agent?\n\n${preview}${more}`,
    );
  }

  private async getUser(userId: number, signal?: AbortSignal): Promise<ZulipUser | undefined> {
    if (userId === this.options.state.botUserId) return undefined;
    const cached = this.users.get(userId);
    if (cached) return cached;
    try {
      const user = await this.client.getUser(userId, signal);
      this.users.set(userId, user);
      return user;
    } catch {
      // Fail closed: an unverifiable sender is never injected into model context.
      return undefined;
    }
  }

  private async refreshStatusCard(): Promise<void> {
    try {
      await this.client.editMessage(this.options.state.statusMessageId, { content: renderCard(this.options.state.statusCard) });
    } catch (error) {
      this.notify(`Could not update Zulip status card: ${safeError(error)}`, "warning");
    }
  }

  private notify(message: string, level: "info" | "warning" | "error"): void {
    this.options.getContext().ui.notify(message, level);
  }

  private resolveAllWaiters(message: string): void {
    for (const [id, listeners] of this.waiters) for (const resolve of [...listeners]) resolve(message);
    this.waiters.clear();
  }
}

function renderCard(card: SessionAttachment["statusCard"]): string {
  const lines = [`**Goal:** ${card.goal || "(not set)"}`, `**Status:** ${card.status || "working"}`];
  if (card.checklist.length) lines.push("", "**Checklist**", ...card.checklist.map((item) => `- ${item}`));
  if (card.decisions.length) lines.push("", "**Decision log**", ...card.decisions.map((item) => `- ${item}`));
  return lines.join("\n");
}

function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, seconds * 1000);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function mimeTypeForPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  const types: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", json: "application/json", pdf: "application/pdf",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    csv: "text/csv", zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

function safeError(error: unknown): string {
  if (error instanceof ZulipApiError) return error.message.replace(/https?:\/\/\S+/g, "<server>").slice(0, 200);
  if (error instanceof Error) return error.message.replace(/https?:\/\/\S+/g, "<server>").slice(0, 200);
  return "unknown error";
}

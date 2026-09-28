import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BotCredential, SessionAttachment } from "./types.ts";
import { registerCommands, startSession, type CommandRuntime } from "./commands.ts";
import { ZulipConnection } from "./session/connection.ts";
import { readAttachmentFromBranch, persistAttachment } from "./session/state.ts";
import { readBotCredential, readServerCredentials, saveBotCredential } from "./storage/credentials.ts";
import { ZulipClient } from "./zulip/client.ts";
import { registerTools } from "./tools.ts";

const ZULIP_TOOLS = ["zulip_post", "zulip_read", "zulip_status", "zulip_ask", "zulip_wait", "zulip_answer"];

export default function(pi: ExtensionAPI): void {
  const runtime = new PiZulipRuntime(pi);
  registerTools(pi, runtime);
  registerCommands(runtime);
  runtime.registerLifecycle();
}

class PiZulipRuntime implements CommandRuntime {
  private attachment?: SessionAttachment;
  private connection?: ZulipConnection;
  private context?: ExtensionContext;

  constructor(readonly pi: ExtensionAPI) {}

  getAttachment(): SessionAttachment | undefined {
    return this.attachment;
  }

  getConnection(): ZulipConnection | undefined {
    return this.connection;
  }

  setAttachment(state: SessionAttachment | undefined): void {
    this.attachment = state;
  }

  async attach(state: SessionAttachment, bot: BotCredential, ctx: ExtensionContext, previewBacklog = false): Promise<void> {
    this.context = ctx;
    if (this.connection) await this.connection.stop();
    this.attachment = state;
    this.connection = new ZulipConnection({
      pi: this.pi,
      state,
      bot,
      getContext: () => this.context ?? ctx,
      onConnectionChange: (connected) => {
        const current = this.context ?? ctx;
        current.ui.setStatus("pi-zulip", connected ? `Zulip #${state.channelName} › ${state.topic}` : undefined);
      },
    });
    try {
      const started = await this.connection.start({ previewBacklog });
      if (!started) {
        state.attached = false;
        persistAttachment(this.pi, state);
        this.connection = undefined;
        this.disableTools();
        ctx.ui.notify("Missed messages were not delivered. This Pi session remains detached; use /zulip-start to resume when ready.", "info");
        return;
      }
      state.attached = true;
      if (state.statusCard.status === "detached") await this.connection.updateStatusCard({ status: "working" });
      if (previewBacklog) await this.connection.post("milestone", "↻ resumed");
      persistAttachment(this.pi, state);
      this.enableTools();
    } catch (error) {
      state.attached = false;
      persistAttachment(this.pi, state);
      this.connection = undefined;
      this.disableTools();
      throw error;
    }
  }

  async detach(ctx: ExtensionContext, postLine: boolean): Promise<void> {
    this.context = ctx;
    const state = this.attachment;
    const connection = this.connection;
    if (connection && postLine) {
      try {
        await connection.post("milestone", "Pi session detached. Messages received while detached will be previewed before delivery on resume.");
        await connection.updateStatusCard({ status: "detached" });
      } catch (error) {
        ctx.ui.notify(`Could not post a Zulip detach notice: ${safeError(error)}`, "warning");
      }
    }
    if (connection) await connection.stop();
    this.connection = undefined;
    if (state) {
      state.attached = false;
      persistAttachment(this.pi, state);
    }
    this.disableTools();
    ctx.ui.setStatus("pi-zulip", undefined);
  }

  registerLifecycle(): void {
    this.pi.on("session_start", async (event, ctx) => {
      this.context = ctx;
      const state = readAttachmentFromBranch(ctx.sessionManager.getBranch());
      this.attachment = state;
      this.connection = undefined;
      this.disableTools();
      if (!state?.attached) {
        if (event.reason === "startup") {
          const servers = await readServerCredentials();
          if (servers.length) {
            const start = await ctx.ui.confirm("Start a Zulip session?", `You are logged in to ${servers.map((server) => server.host).join(", ")}. Choose a project channel and topic to attach this Pi session.`);
            if (start) {
              try {
                await startSession("", ctx, this);
              } catch (error) {
                ctx.ui.notify(`Could not start Zulip session: ${safeError(error)}`, "error");
              }
            }
          }
        }
        return;
      }
      if (event.reason === "fork") {
        state.attached = false;
        persistAttachment(this.pi, state);
        ctx.ui.notify("This Pi session was forked from a Zulip-attached session. It will not share that live topic; use /zulip-start to create or select a separate topic.", "warning");
        return;
      }
      try {
        const bot = await this.restoreBot(state);
        if (!bot) throw new Error("Saved bot credentials are missing; run /zulip-login and /zulip-start again");
        await this.attach(state, bot, ctx, true);
      } catch (error) {
        state.attached = false;
        persistAttachment(this.pi, state);
        this.connection = undefined;
        this.disableTools();
        ctx.ui.notify(`Could not resume Zulip topic #${state.channelName} > ${state.topic}: ${safeError(error)}. The session is detached.`, "warning");
      }
    });

    this.pi.on("session_shutdown", async (_event) => {
      if (!this.context) return;
      await this.pauseForShutdown(this.context).catch(() => undefined);
    });

    this.pi.on("before_agent_start", (_event, ctx) => {
      if (!this.attachment?.attached || !this.connection?.isConnected) return;
      return {
        message: {
          customType: "pi-zulip-session",
          display: false,
          content: `This Pi session is attached to Zulip #${this.attachment.channelName} > ${this.attachment.topic} on ${this.attachment.serverHost}. Handle only messages delivered from this exact topic. Use zulip_post for concise progress/blockers, zulip_status for the shared status and small decisions, zulip_ask for decisions that genuinely block work, and zulip_wait only when the current turn cannot proceed independently. Do not attach files unless the user explicitly requested sharing them. Before attaching, prefer PNG or JPEG for images and web-safe video encoded as H.264 with yuv420p pixel format. Keep each file at most 15 MiB and all files in one post at most 30 MiB (maximum five files); do not spend time uploading larger files. If a requested file exceeds these limits, explain and offer a smaller/compressed version.`,

        },
      };
    });
  }

  private async pauseForShutdown(ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    const state = this.attachment;
    const connection = this.connection;
    if (connection) {
      try {
        await connection.post("milestone", "Pi session paused. Messages received while it is away will be previewed before delivery when resumed.");
      } catch {
        // Shutdown should still stop polling if the Zulip server is unavailable.
      }
      await connection.stop();
    }
    this.connection = undefined;
    this.disableTools();
    ctx.ui.setStatus("pi-zulip", undefined);
    // Keep explicitly attached durable state true so session_start can reconnect and preview backlog.
    if (state?.attached) persistAttachment(this.pi, state);
  }

  private async restoreBot(state: SessionAttachment): Promise<BotCredential | undefined> {
    const cached = await readBotCredential(state.serverHost, state.channelName);
    if (cached && cached.userId === state.botUserId) {
      const client = new ZulipClient(cached.baseUrl, cached.email, cached.apiKey);
      const profile = await client.getProfile();
      const subscriptions = await client.listSubscriptions();
      const ownStream = subscriptions.find((item) => item.name.toLowerCase() === state.channelName.toLowerCase());
      if (profile.user_id === state.botUserId && profile.is_bot && (profile.is_guest || profile.role === 600) && subscriptions.length === 1 && ownStream?.stream_id === state.streamId) return cached;
    }

    const servers = await readServerCredentials(state.serverHost);
    const server = servers[0];
    if (!server) return undefined;
    const admin = new ZulipClient(server.baseUrl, server.email, server.apiKey);
    const record = (await admin.listBots()).find((item) => item.default_sending_stream?.toLowerCase() === state.channelName.toLowerCase());
    if (!record) return undefined;
    const client = new ZulipClient(server.baseUrl, record.username, record.api_key);
    const profile = await client.getProfile();
    if (!profile.is_bot || profile.user_id !== state.botUserId || !(profile.is_guest || profile.role === 600)) return undefined;
    const subscriptions = await client.listSubscriptions();
    const subscription = subscriptions.find((item) => item.name.toLowerCase() === state.channelName.toLowerCase());
    if (!subscription || subscription.stream_id !== state.streamId || subscriptions.length !== 1) return undefined;
    const stream = await client.getStream(subscription.stream_id);
    if (!stream.invite_only) return undefined;
    const bot: BotCredential = {
      host: server.host,
      baseUrl: server.baseUrl,
      channelName: state.channelName,
      email: record.username,
      apiKey: record.api_key,
      userId: profile.user_id,
    };
    await saveBotCredential(bot);
    return bot;
  }

  private enableTools(): void {
    const active = this.pi.getActiveTools();
    this.pi.setActiveTools([...new Set([...active, ...ZULIP_TOOLS])]);
  }

  private disableTools(): void {
    this.pi.setActiveTools(this.pi.getActiveTools().filter((name) => !ZULIP_TOOLS.includes(name)));
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "<server>").slice(0, 300) : "unknown error";
}

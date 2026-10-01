import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BotCredential, SessionAttachment, ServerCredentials, ZulipUser } from "./types.ts";
import { makeStatusCard, persistAttachment } from "./session/state.ts";
import { renderStatusCard } from "./session/format.ts";
import { ZulipConnection } from "./session/connection.ts";
import { ZulipApiError, ZulipBotRecord, ZulipClient, normalizeServerUrl } from "./zulip/client.ts";
import { readServerCredentials, saveBotCredential, saveServerCredentials, removeServerCredentials } from "./storage/credentials.ts";
import { searchableSelect, searchableSelectItems } from "./commands/picker.ts";
import { describeTopicSession, findTopicSessions, sessionDirectories, setRestoreHandoff, topicLabel, type TopicSession } from "./session/catalog.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";

export interface CommandRuntime {
  pi: ExtensionAPI;
  getAttachment(): SessionAttachment | undefined;
  getConnection(): ZulipConnection | undefined;
  attach(state: SessionAttachment, bot: BotCredential, ctx: ExtensionContext, previewBacklog?: boolean): Promise<void>;
  detach(ctx: ExtensionContext, postLine: boolean): Promise<void>;
  setAttachment(state: SessionAttachment | undefined): void;
  /** Reconnect this session's saved attachment (restoring bot credentials) and preview missed messages. */
  reattach(state: SessionAttachment, ctx: ExtensionContext): Promise<void>;
}

const PROJECT_CHANNEL_DESCRIPTION = "Private project channel for the Pi Zulip extension.";

interface ProjectBotChoice {
  record: ZulipBotRecord;
  channelName: string;
  label: string;
}

export function registerCommands(runtime: CommandRuntime): void {
  const { pi } = runtime;

  pi.registerCommand("zulip-login", {
    description: "Configure a Zulip server and human notification recipient",
    handler: async (args, ctx) => {
      try {
        await login(args.trim(), ctx);
      } catch (error) {
        ctx.ui.notify(`Zulip login failed: ${safeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("zulip-logout", {
    description: "Remove saved Zulip credentials",
    handler: async (args, ctx) => {
      try {
        const credentials = await readServerCredentials();
        if (!credentials.length) return ctx.ui.notify("No Zulip servers are configured.", "info");
        let chosen: ServerCredentials | undefined;
        if (args.trim()) {
          const wanted = args.trim().toLowerCase();
          chosen = credentials.find((item) => item.host.toLowerCase() === wanted || item.baseUrl.toLowerCase() === wanted);
        } else if (credentials.length === 1) chosen = credentials[0];
        else {
          const labels = credentials.map((item) => item.host);
          const picked = await ctx.ui.select("Choose the Zulip server to log out", labels);
          chosen = credentials[labels.indexOf(picked ?? "")];
        }
        if (!chosen) return ctx.ui.notify("Server not found; pass its host to /zulip-logout.", "warning");
        const confirmed = await ctx.ui.confirm("Remove Zulip credentials?", `This removes the saved login and cached bot keys for ${chosen.host}. Server-side bots and channels are not deleted.`);
        if (!confirmed) return;
        if (runtime.getAttachment()?.serverHost === chosen.host) await runtime.detach(ctx, true);
        await removeServerCredentials(chosen.host);
        ctx.ui.notify(`Removed Zulip credentials for ${chosen.host}.`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not remove Zulip credentials: ${safeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("zulip-start", {
    description: "Attach this Pi session to one Zulip project channel and topic",
    handler: async (args, ctx) => {
      try {
        await startSession(args, ctx, runtime);
      } catch (error) {
        ctx.ui.notify(`Could not start Zulip session: ${safeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("zulip-stop", {
    description: "Detach this Pi session from Zulip",
    handler: async (_args, ctx) => {
      if (!runtime.getAttachment()?.attached) return ctx.ui.notify("This session is not attached to Zulip.", "info");
      try {
        await runtime.detach(ctx, true);
        ctx.ui.notify("Detached from Zulip.", "info");
      } catch (error) {
        ctx.ui.notify(`Could not detach cleanly: ${safeError(error)}`, "warning");
      }
    },
  });

  pi.registerCommand("zulip-resolve", {
    description: "Resolve this session's Zulip topic; pass --undo to reopen it",
    handler: async (args, ctx) => {
      const connection = runtime.getConnection();
      if (!connection) return ctx.ui.notify("Attach this session with /zulip-start first.", "warning");
      try {
        await connection.resolveTopic(!args.trim().startsWith("--undo"));
        ctx.ui.notify(args.trim().startsWith("--undo") ? "Reopened the Zulip topic." : "Resolved the Zulip topic.", "info");
      } catch (error) {
        ctx.ui.notify(`Could not resolve the Zulip topic: ${safeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("zulip-restore", {
    description: "Search Zulip #channel > topic attachments and resume the Pi session responsible for one",
    handler: async (args, ctx) => {
      try {
        await restoreSession(args.trim(), ctx, runtime);
      } catch (error) {
        ctx.ui.notify(`Could not restore Zulip session: ${safeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("zulip-status", {
    description: "Show this session's Zulip attachment and delivery state",
    handler: async (_args, ctx) => {
      const connection = runtime.getConnection();
      if (connection) return ctx.ui.notify(await connection.getStatus(), "info");
      const state = runtime.getAttachment();
      if (!state) return ctx.ui.notify("Not attached to Zulip. Run /zulip-start to attach this session.", "info");
      ctx.ui.notify(`Detached from ${state.serverHost} #${state.channelName} > ${state.topic}\nStatus: ${state.statusCard.status}`, "info");
    },
  });
}

/** Prefix for the internal form `/zulip-restore --session <path>` used to switch without showing the picker. */
export const RESTORE_SESSION_FLAG = "--session ";

async function listTopicSessions(ctx: ExtensionContext): Promise<TopicSession[]> {
  return findTopicSessions(await sessionDirectories(join(getAgentDir(), "sessions"), [ctx.sessionManager.getSessionDir()]));
}

export async function hasTopicSessions(ctx: ExtensionContext): Promise<boolean> {
  return listTopicSessions(ctx).then((sessions) => sessions.length > 0, () => false);
}

/** Show the searchable #channel > topic picker; returns the chosen session, if any. */
export async function pickTopicSession(ctx: ExtensionContext, query = ""): Promise<TopicSession | undefined> {
  const currentFile = ctx.sessionManager.getSessionFile();
  const sessions = await listTopicSessions(ctx);
  if (!sessions.length) {
    ctx.ui.notify("No Pi sessions attached to a Zulip topic were found.", "info");
    return undefined;
  }
  const now = new Date();
  const items = sessions.map((session) => ({
    value: session.path,
    label: topicLabel(session.state),
    description: describeTopicSession(session, now, currentFile),
  }));
  const picked = await searchableSelectItems(ctx, "Restore the Pi session for a Zulip topic", items, { initialQuery: query });
  return sessions.find((item) => item.path === picked);
}

async function restoreSession(args: string, ctx: ExtensionCommandContext, runtime: CommandRuntime): Promise<void> {
  let session: TopicSession | undefined;
  if (args.startsWith(RESTORE_SESSION_FLAG)) {
    const wanted = resolve(args.slice(RESTORE_SESSION_FLAG.length).trim());
    session = (await listTopicSessions(ctx)).find((item) => resolve(item.path) === wanted);
    if (!session) return ctx.ui.notify("That Pi session is no longer attached to a Zulip topic.", "warning");
  } else {
    session = await pickTopicSession(ctx, args);
  }
  if (session) await switchToTopicSession(session, ctx, runtime);
}

async function switchToTopicSession(session: TopicSession, ctx: ExtensionCommandContext, runtime: CommandRuntime): Promise<void> {
  const currentFile = ctx.sessionManager.getSessionFile();
  const label = topicLabel(session.state);
  if (currentFile && resolve(currentFile) === resolve(session.path)) {
    if (runtime.getConnection()?.isConnected) return ctx.ui.notify(`This session is already attached to ${label}.`, "info");
    const state = runtime.getAttachment() ?? session.state;
    await runtime.reattach(state, ctx);
    if (runtime.getConnection()?.isConnected) ctx.ui.notify(`Reattached to ${label}.`, "info");
    return;
  }

  await ctx.waitForIdle();
  setRestoreHandoff(session.path);
  let result: { cancelled: boolean };
  try {
    result = await ctx.switchSession(session.path, {
      withSession: async (next) => next.ui.notify(`Restored the Pi session for ${label}.`, "info"),
    });
  } catch (error) {
    setRestoreHandoff(undefined);
    throw error;
  }
  if (result.cancelled) {
    setRestoreHandoff(undefined);
    ctx.ui.notify("Session restore was cancelled.", "info");
  }
}

async function login(urlArg: string, ctx: ExtensionCommandContext): Promise<void> {
  let inputUrl = urlArg;
  if (!inputUrl) {
    const answer = await ctx.ui.input("Zulip server URL", "https://zulip.example.com");
    if (!answer) return;
    inputUrl = answer;
  }
  const candidate = inputUrl.includes("://") ? inputUrl : `https://${inputUrl}`;
  const parsed = new URL(candidate);
  const isLocalHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.replace(/^\[|\]$/g, ""));
  if (parsed.protocol === "http:" && (!isLocalHttp || !(await ctx.ui.confirm("Use unencrypted HTTP?", "API credentials will be sent without TLS. Continue only for a local development server.")))) {
    throw new Error("Zulip login requires HTTPS");
  }
  const baseUrl = normalizeServerUrl(candidate, isLocalHttp);
  const email = (await ctx.ui.input("Zulip login email", "name@example.com"))?.trim();
  if (!email) return;

  const authKind = await ctx.ui.select("Authenticate with", ["API key", "Password (exchange for API key)"]);
  if (!authKind) return;
  let apiKey = "";
  const unauthenticated = new ZulipClient(baseUrl, email, "");
  if (authKind === "API key") {
    apiKey = (await ctx.ui.input("Zulip API key", "Paste the API key"))?.trim() ?? "";
    if (!apiKey) return;
  } else {
    const password = await ctx.ui.input("Zulip password", "Password is used once and is not saved");
    if (!password) return;
    apiKey = await unauthenticated.fetchApiKey(email, password);
  }

  const client = new ZulipClient(baseUrl, email, apiKey);
  const profile = await client.getProfile();
  const users = await client.listUsers();
  const humanUsers = users.filter((user) => user.is_active !== false && !user.is_bot);
  const owners = humanUsers.filter((user) => user.is_owner);
  let notifyUser: ZulipUser | undefined;
  const notifyEmail = await ctx.ui.input("Human account to notify (leave blank for the organization owner)", owners[0]?.email ?? "owner@example.com");
  if (notifyEmail === undefined) return;
  if (notifyEmail.trim()) {
    const wanted = notifyEmail.trim().toLowerCase();
    notifyUser = humanUsers.find((user) => user.email.toLowerCase() === wanted || user.delivery_email?.toLowerCase() === wanted);
    if (!notifyUser) throw new Error("That notification email is not an active human account in this Zulip organization");
  } else if (owners.length === 1) notifyUser = owners[0];
  else if (owners.length > 1) {
    const labels = owners.map((user) => `${user.full_name} <${user.email}>`);
    const picked = await ctx.ui.select("Choose an organization owner to notify", labels);
    notifyUser = owners[labels.indexOf(picked ?? "")];
  } else {
    notifyUser = humanUsers.find((user) => user.user_id === profile.user_id) ?? humanUsers[0];
  }
  if (!notifyUser) throw new Error("Could not find a human notification recipient");

  const host = new URL(baseUrl).host.toLowerCase();
  await saveServerCredentials({
    host,
    baseUrl,
    email,
    apiKey,
    notifyUserId: notifyUser.user_id,
    notifyEmail: notifyUser.email,
    notifyName: notifyUser.full_name,
    provisionerUserId: profile.user_id,
    provisionerIsAdmin: !!(profile.is_admin || profile.is_owner),
  });
  ctx.ui.notify(`Logged in to ${host} as ${profile.full_name}. Notifications go to ${notifyUser.full_name}.${profile.is_admin || profile.is_owner ? "" : " Warning: this account is not an organization administrator; private bot provisioning may be unavailable."}`, "info");
}

export async function startSession(rawArgs: string, ctx: ExtensionContext, runtime: CommandRuntime): Promise<void> {
  const parsed = parseStartArgs(rawArgs);
  const servers = await readServerCredentials();
  if (!servers.length) throw new Error("Run /zulip-login first");
  let server: ServerCredentials | undefined;
  if (servers.length === 1) server = servers[0];
  else {
    const labels = servers.map((item) => item.host);
    const selected = await ctx.ui.select("Choose a Zulip server", labels);
    server = servers[labels.indexOf(selected ?? "")];
  }
  if (!server) return;
  const provisioner = new ZulipClient(server.baseUrl, server.email, server.apiKey);
  const records = await provisioner.listBots();
  const choices: ProjectBotChoice[] = records
    .filter((record) => !!record.default_sending_stream && !!record.api_key)
    .map((record) => ({
      record,
      channelName: record.default_sending_stream!,
      label: `#${record.default_sending_stream} — ${record.full_name}`,
    }));

  let selected: ProjectBotChoice | undefined;
  if (parsed.channel) selected = choices.find((choice) => choice.channelName.toLowerCase() === parsed.channel!.toLowerCase());
  else {
    const options = [...choices.map((choice) => choice.label), "➕ New private project channel…"];
    const choice = await searchableSelect(ctx, "Choose a Zulip project channel", options);
    if (!choice) return;
    if (choice === "➕ New private project channel…") {
      const name = (await ctx.ui.input("New private Zulip channel name", "my-project"))?.trim();
      if (!name) return;
      const bot = await provisionProjectChannel(server, name, provisioner, choices, ctx);
      await attachToTopic(server, bot, name, parsed.topic, ctx, runtime);
      return;
    }
    selected = choices.find((item) => item.label === choice);
  }

  if (!selected && parsed.channel) {
    const create = await ctx.ui.confirm("No Pi project bot found", `There is no bot-owned project channel named #${parsed.channel}. Create a new private channel and Guest bot with this name?`);
    if (!create) return;
    const bot = await provisionProjectChannel(server, parsed.channel, provisioner, choices, ctx);
    await attachToTopic(server, bot, parsed.channel, parsed.topic, ctx, runtime);
    return;
  }
  if (!selected) return;
  const bot = await loadBot(server, selected);
  await attachToTopic(server, bot, selected.channelName, parsed.topic, ctx, runtime);
}

async function loadBot(server: ServerCredentials, choice: ProjectBotChoice): Promise<BotCredential> {
  const client = new ZulipClient(server.baseUrl, choice.record.username, choice.record.api_key);
  const profile = await client.getProfile();
  if (!profile.is_bot) throw new Error("The selected Zulip credential does not belong to a bot");
  if (!(profile.is_guest || profile.role === 600)) throw new Error("The project bot is not a Guest; refusing to use a bot with broader server access");
  const subscriptions = await client.listSubscriptions();
  const subscription = subscriptions.find((item) => item.name.toLowerCase() === choice.channelName.toLowerCase());
  if (!subscription) throw new Error(`Bot is not subscribed to #${choice.channelName}`);
  if (subscriptions.length !== 1) throw new Error("The project Guest bot is subscribed to more than its own channel; refusing to attach");
  const stream = await client.getStream(subscription.stream_id);
  if (!stream.invite_only) {
    throw new Error(`#${choice.channelName} is not a private channel. pi-zulip only attaches to private project channels.`);
  }
  const bot: BotCredential = {
    host: server.host,
    baseUrl: server.baseUrl,
    channelName: choice.channelName,
    email: choice.record.username,
    apiKey: choice.record.api_key,
    userId: profile.user_id,
  };
  await saveBotCredential(bot);
  return bot;
}

async function provisionProjectChannel(
  server: ServerCredentials,
  channelName: string,
  admin: ZulipClient,
  choices: ProjectBotChoice[],
  ctx: ExtensionContext,
): Promise<BotCredential> {
  const profile = await admin.getProfile();
  if (!profile.is_admin && !profile.is_owner) throw new Error("The saved Zulip login must be an organization administrator to create a private project channel and bot");
  if (profile.user_id !== server.provisionerUserId) throw new Error("Provisioner identity changed; run /zulip-login again");
  const subscriptions = await admin.listSubscriptions();
  let streamId = subscriptions.find((item) => item.name.toLowerCase() === channelName.toLowerCase())?.stream_id;
  let createdChannel = false;
  if (!streamId) {
    streamId = await admin.createPrivateChannel(channelName, PROJECT_CHANNEL_DESCRIPTION, [profile.user_id, server.notifyUserId]);
    createdChannel = true;
  }

  let record = choices.find((choice) => choice.channelName.toLowerCase() === channelName.toLowerCase())?.record;
  let botId: number;
  if (record) {
    const botClient = new ZulipClient(server.baseUrl, record.username, record.api_key);
    botId = (await botClient.getProfile()).user_id;
    await admin.setBotGuest(botId);
  } else {
    const shortName = `${channelName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 45) || "project"}-bot`;
    botId = await admin.createBot(`Pi ${channelName} Bot`, shortName, channelName);
    await admin.setBotGuest(botId);
    const key = await admin.getBotApiKey(botId);
    record = { username: `bot-${botId}`, full_name: `Pi ${channelName} Bot`, api_key: key, default_sending_stream: channelName };
  }
  await admin.subscribePrincipals(channelName, [botId]);

  const recordFromServer = (await admin.listBots()).find((item) => item.default_sending_stream?.toLowerCase() === channelName.toLowerCase());
  if (!recordFromServer) throw new Error("Zulip did not list the newly created project bot; refusing to attach");
  const botClient = new ZulipClient(server.baseUrl, recordFromServer.username, recordFromServer.api_key);
  const botProfile = await botClient.getProfile();
  const botUser = await admin.getUser(botProfile.user_id);
  if (!(botUser.is_guest || botUser.role === 600)) throw new Error("Could not verify the project bot's Guest role; refusing to attach");
  const botSubscriptions = await botClient.listSubscriptions();
  const botSubscription = botSubscriptions.find((item) => item.name.toLowerCase() === channelName.toLowerCase());
  if (!botSubscription || botSubscription.stream_id !== streamId || botSubscriptions.length !== 1) throw new Error("The Guest bot is not subscribed only to the expected project channel");
  const stream = await botClient.getStream(streamId);
  if (!stream.invite_only) throw new Error("The project channel is not private; refusing to attach");
  const createdByThisExtension = createdChannel || stream.description === PROJECT_CHANNEL_DESCRIPTION;

  const bot: BotCredential = {
    host: server.host,
    baseUrl: server.baseUrl,
    channelName,
    email: recordFromServer.username,
    apiKey: recordFromServer.api_key,
    userId: botProfile.user_id,
  };
  await saveBotCredential(bot);
  // The provisioning user must see the private stream while setting default_sending_stream;
  // remove it after the bot is subscribed and verified.
  if (createdByThisExtension && profile.user_id !== server.notifyUserId) await admin.unsubscribeSelf(channelName);
  if (createdChannel) ctx.ui.notify(`Created private #${channelName} with a Guest bot. Only the notification human and project bot remain subscribed.`, "info");
  return bot;
}

async function attachToTopic(
  server: ServerCredentials,
  bot: BotCredential,
  channelName: string,
  providedTopic: string,
  ctx: ExtensionContext,
  runtime: CommandRuntime,
): Promise<void> {
  const client = new ZulipClient(bot.baseUrl, bot.email, bot.apiKey);
  const profile = await client.getProfile();
  const subscriptions = await client.listSubscriptions();
  const subscription = subscriptions.find((item) => item.name.toLowerCase() === channelName.toLowerCase());
  if (!subscription) throw new Error(`The project bot has lost access to #${channelName}`);
  const topics = await client.listTopics(subscription.stream_id);
  let topic = providedTopic.trim();
  let selectedExistingTopic = false;
  if (!topic) {
    const newTopicOption = "➕ New topic…";
    const choice = await searchableSelect(ctx, `Choose a topic in #${channelName}`, [...topics.map((item) => item.name), newTopicOption]);
    if (!choice) return;
    if (choice === newTopicOption) {
      topic = (await ctx.ui.input(`New topic in #${channelName}`, "Describe this session's task"))?.trim() ?? "";
      if (!topic) return;
    } else {
      topic = choice;
      selectedExistingTopic = true;
    }
  }

  const previous = runtime.getAttachment();
  if (previous && previous.serverHost === server.host && previous.channelName.toLowerCase() === channelName.toLowerCase() && previous.topic === topic) {
    previous.attached = true;
    persistAttachment(runtime.pi, previous);
    await runtime.attach(previous, bot, ctx, true);
    return;
  }
  if (!selectedExistingTopic && topics.some((item) => item.name.toLowerCase() === topic.toLowerCase())) {
    const replacement = await ctx.ui.input(`Topic “${topic}” already exists`, "Choose a new topic name; existing topics are not auto-attached");
    if (!replacement?.trim()) return;
    topic = replacement.trim();
    if (topics.some((item) => item.name.toLowerCase() === topic.toLowerCase())) throw new Error(`Topic “${topic}” already exists; choose a unique topic`);
  }
  if (runtime.getAttachment()?.attached) await runtime.detach(ctx, true);

  const statusCard = makeStatusCard(topic);
  const statusMessageId = await client.sendMessage(channelName, topic, renderStatusCard(statusCard));
  const state: SessionAttachment = {
    version: 1,
    attached: true,
    serverHost: server.host,
    channelName,
    streamId: subscription.stream_id,
    topic,
    botEmail: bot.email,
    botUserId: profile.user_id,
    notifyUserId: server.notifyUserId,
    statusMessageId,
    ownedMessageIds: [statusMessageId],
    lastHandledMessageId: 0,
    statusCard,
    openQuestions: [],
    updatedAt: new Date().toISOString(),
  };
  persistAttachment(runtime.pi, state);
  await runtime.attach(state, bot, ctx, false);
  ctx.ui.notify(`Attached to ${server.host} #${channelName} > ${topic}.`, "info");
}

function parseStartArgs(args: string): { channel?: string; topic: string } {
  const trimmed = args.trim();
  if (!trimmed) return { topic: "" };
  const quoted = trimmed.match(/^(?:"([^"]+)"|'([^']+)')(?:\s+(.*))?$/);
  if (quoted) return { channel: quoted[1] ?? quoted[2], topic: quoted[3] ?? "" };
  const [channel, ...rest] = trimmed.split(/\s+/);
  return { channel, topic: rest.join(" ") };
}

function safeError(error: unknown): string {
  if (error instanceof ZulipApiError) return error.message;
  return error instanceof Error ? error.message : "unknown error";
}

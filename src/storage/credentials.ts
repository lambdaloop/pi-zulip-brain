import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BotCredential, ServerCredentials } from "../types.ts";

const CONFIG_ROOT = join(homedir(), ".config", "pi-zulip");
const SERVERS_DIR = join(CONFIG_ROOT, "servers");

export function hostSlug(host: string): string {
  return host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
}

function safeChannelSlug(channel: string): string {
  const value = channel.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (!value) throw new Error("Channel name cannot be converted to a safe cache filename");
  return value.slice(0, 100);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

async function atomicPrivateWrite(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(join(path, ".."));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function isServerCredentials(value: unknown): value is ServerCredentials {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ServerCredentials>;
  return typeof item.host === "string" && typeof item.baseUrl === "string" &&
    typeof item.email === "string" && typeof item.apiKey === "string" &&
    typeof item.notifyUserId === "number" && typeof item.provisionerUserId === "number";
}

function isBotCredential(value: unknown): value is BotCredential {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<BotCredential>;
  return typeof item.host === "string" && typeof item.baseUrl === "string" && typeof item.channelName === "string" &&
    typeof item.email === "string" && typeof item.apiKey === "string" && typeof item.userId === "number";
}

function serverPath(host: string): string {
  return join(SERVERS_DIR, `${hostSlug(host)}.json`);
}

function botCachePath(host: string, channelName: string): string {
  return join(SERVERS_DIR, hostSlug(host), "bots", `${safeChannelSlug(channelName)}.json`);
}

export async function saveServerCredentials(credentials: ServerCredentials): Promise<void> {
  await ensurePrivateDirectory(SERVERS_DIR);
  await atomicPrivateWrite(serverPath(credentials.host), credentials);
}

export async function readServerCredentials(host?: string): Promise<ServerCredentials[]> {
  await ensurePrivateDirectory(SERVERS_DIR);
  const files = await readdir(SERVERS_DIR).catch(() => []);
  const selected = host ? [`${hostSlug(host)}.json`] : files.filter((file) => file.endsWith(".json"));
  const output: ServerCredentials[] = [];
  for (const file of selected) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(SERVERS_DIR, file), "utf8"));
      if (isServerCredentials(parsed)) output.push(parsed);
    } catch {
      // Ignore unreadable or malformed credential records without exposing contents.
    }
  }
  return output.sort((a, b) => a.host.localeCompare(b.host));
}

export async function removeServerCredentials(host: string): Promise<void> {
  await rm(serverPath(host), { force: true });
  await rm(join(SERVERS_DIR, hostSlug(host)), { recursive: true, force: true });
}

export async function saveBotCredential(credential: BotCredential): Promise<void> {
  const path = botCachePath(credential.host, credential.channelName);
  await ensurePrivateDirectory(join(path, ".."));
  await atomicPrivateWrite(path, credential);
}

export async function readBotCredential(host: string, channelName: string): Promise<BotCredential | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(botCachePath(host, channelName), "utf8"));
    if (isBotCredential(parsed) && parsed.host === host && parsed.channelName.toLowerCase() === channelName.toLowerCase()) {
      return parsed;
    }
  } catch {
    // A missing local cache is recovered through the server's bot list.
  }
  return undefined;
}

export async function deleteAllStoredCredentials(): Promise<void> {
  await rm(CONFIG_ROOT, { recursive: true, force: true });
}

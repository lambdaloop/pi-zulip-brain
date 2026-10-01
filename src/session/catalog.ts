import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { SessionAttachment } from "../types.ts";
import { isAttachment, SESSION_STATE_ENTRY } from "./state.ts";

/** A Pi session file whose latest Zulip attachment points at a topic. */
export interface TopicSession {
  path: string;
  sessionId: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  modified: Date;
  state: SessionAttachment;
}

const SCAN_CONCURRENCY = 16;

/** Session directories to scan: every project directory under the sessions root plus any extra directories. */
export async function sessionDirectories(sessionsRoot: string, extraDirs: string[] = []): Promise<string[]> {
  const dirs = new Set<string>();
  try {
    for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) dirs.add(resolve(sessionsRoot, entry.name));
    }
  } catch {
    // A missing sessions root just means there is nothing to restore.
  }
  for (const dir of extraDirs) if (dir) dirs.add(resolve(dir));
  return [...dirs];
}

/** Find every session file with a Zulip attachment, newest first, hiding forked copies of the same attachment. */
export async function findTopicSessions(dirs: string[], signal?: AbortSignal): Promise<TopicSession[]> {
  const files = new Set<string>();
  for (const dir of dirs) {
    try {
      for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) files.add(join(dir, name));
    } catch {
      // Unreadable directories are skipped.
    }
  }
  const paths = [...files];
  const results: Array<TopicSession | undefined> = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      signal?.throwIfAborted();
      const index = next++;
      results[index] = await readTopicSession(paths[index]!, signal).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, paths.length) }, worker));
  return dedupeForks(results.filter((item): item is TopicSession => !!item))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Read the header and latest attachment entry of one session file without parsing the whole transcript. */
export async function readTopicSession(path: string, signal?: AbortSignal): Promise<TopicSession | undefined> {
  const stats = await stat(path);
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8", signal }), crlfDelay: Infinity });
  let header: { id?: unknown; cwd?: unknown; parentSession?: unknown } | undefined;
  let name: string | undefined;
  let state: SessionAttachment | undefined;
  try {
    for await (const line of lines) {
      if (!header) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        if (parsed.type !== "session") return undefined;
        header = parsed;
        continue;
      }
      // Cheap substring checks avoid JSON-parsing every transcript message.
      if (line.includes(SESSION_STATE_ENTRY)) {
        const entry = parseLine(line);
        if (entry?.type === "custom" && entry.customType === SESSION_STATE_ENTRY && isAttachment(entry.data)) state = entry.data;
      } else if (line.includes('"session_info"')) {
        const entry = parseLine(line);
        if (entry?.type === "session_info") name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      }
    }
  } finally {
    lines.close();
  }
  if (!header || !state) return undefined;
  return {
    path,
    sessionId: typeof header.id === "string" ? header.id : "",
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
    modified: stats.mtime,
    state,
  };
}

/**
 * A forked session inherits its parent's attachment entry (same status message) but is not the
 * session responsible for the topic. Keep only sessions whose parent is not another copy.
 */
export function dedupeForks(sessions: TopicSession[]): TopicSession[] {
  const groups = new Map<string, TopicSession[]>();
  for (const session of sessions) {
    const key = attachmentKey(session.state);
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  const kept: TopicSession[] = [];
  for (const group of groups.values()) {
    const paths = new Set(group.map((item) => resolve(item.path)));
    const originals = group.filter((item) => !item.parentSessionPath || !paths.has(resolve(item.parentSessionPath)));
    const candidates = originals.length ? originals : group;
    kept.push(candidates.reduce((best, item) => item.modified > best.modified ? item : best));
  }
  return kept;
}

function attachmentKey(state: SessionAttachment): string {
  return `${state.serverHost}\u0000${state.streamId}\u0000${state.statusMessageId}`;
}

export function topicLabel(state: Pick<SessionAttachment, "channelName" | "topic">): string {
  return `#${state.channelName} > ${state.topic}`;
}

export function describeTopicSession(session: TopicSession, now = new Date(), currentSessionFile?: string): string {
  const parts = [
    currentSessionFile && resolve(currentSessionFile) === resolve(session.path) ? "current session" : undefined,
    session.state.attached ? "attached" : "detached",
    session.state.serverHost,
    shortenHome(session.cwd),
    relativeTime(session.modified, now),
    session.name,
  ];
  return parts.filter(Boolean).join(" · ");
}

function shortenHome(path: string): string {
  const home = homedir();
  return path && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

export function relativeTime(date: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Session switching replaces the extension instance, so the restore intent is handed to the
 * replacement instance through a process-global, single-use slot keyed by session file.
 */
const RESTORE_HANDOFF = Symbol.for("pi-zulip.restore-handoff");
const HANDOFF_TTL_MS = 60_000;

interface RestoreHandoff {
  sessionFile: string;
  expiresAt: number;
}

export function setRestoreHandoff(sessionFile: string | undefined): void {
  const slot = globalThis as Record<symbol, RestoreHandoff | undefined>;
  slot[RESTORE_HANDOFF] = sessionFile ? { sessionFile: resolve(sessionFile), expiresAt: Date.now() + HANDOFF_TTL_MS } : undefined;
}

/** Consume the handoff; returns true only when it targets this session file and has not expired. */
export function takeRestoreHandoff(sessionFile: string | undefined): boolean {
  const slot = globalThis as Record<symbol, RestoreHandoff | undefined>;
  const handoff = slot[RESTORE_HANDOFF];
  slot[RESTORE_HANDOFF] = undefined;
  return !!handoff && !!sessionFile && handoff.expiresAt >= Date.now() && handoff.sessionFile === resolve(sessionFile);
}

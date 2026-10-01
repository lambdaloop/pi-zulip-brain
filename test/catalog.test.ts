import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeTopicSession,
  findTopicSessions,
  sessionDirectories,
  setRestoreHandoff,
  takeRestoreHandoff,
  topicLabel,
} from "../src/session/catalog.ts";
import { makeStatusCard, SESSION_STATE_ENTRY } from "../src/session/state.ts";
import { uniqueFallbackLabels } from "../src/commands/picker.ts";
import type { SessionAttachment } from "../src/types.ts";

function attachment(topic: string, statusMessageId: number, attached = true): SessionAttachment {
  return {
    version: 1, attached, serverHost: "zulip.example.com", channelName: "proj", streamId: 7, topic,
    botEmail: "bot@example.com", botUserId: 9, notifyUserId: 1, statusMessageId, ownedMessageIds: [statusMessageId],
    lastHandledMessageId: 0, statusCard: makeStatusCard(topic), openQuestions: [], updatedAt: "2026-01-01T00:00:00Z",
  };
}

async function writeSession(path: string, id: string, states: SessionAttachment[], extra: { parentSession?: string; mtime?: Date; name?: string } = {}): Promise<void> {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, cwd: "/work/proj", timestamp: "2026-01-01T00:00:00Z", parentSession: extra.parentSession }),
    JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: `mentions ${SESSION_STATE_ENTRY} in text` } }),
    ...states.map((data, index) => JSON.stringify({ type: "custom", id: `c${index}`, customType: SESSION_STATE_ENTRY, data })),
    ...(extra.name ? [JSON.stringify({ type: "session_info", id: "n", name: extra.name })] : []),
  ];
  await writeFile(path, `${lines.join("\n")}\n`);
  if (extra.mtime) await utimes(path, extra.mtime, extra.mtime);
}

test("finds the latest attachment per session, newest first, hiding forked copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-zulip-catalog-"));
  try {
    const project = join(root, "--work-proj--");
    await mkdir(project);
    const original = join(project, "a.jsonl");
    await writeSession(original, "a", [attachment("old name", 100), attachment("✔ renamed", 100, false)], { mtime: new Date("2026-01-02"), name: "My task" });
    await writeSession(join(project, "fork.jsonl"), "f", [attachment("✔ renamed", 100, false)], { parentSession: original, mtime: new Date("2026-01-05") });
    await writeSession(join(project, "b.jsonl"), "b", [attachment("second", 200)], { mtime: new Date("2026-01-03") });
    await writeSession(join(project, "plain.jsonl"), "p", []);
    await writeFile(join(project, "broken.jsonl"), "not json\n");

    const dirs = await sessionDirectories(root, [project]);
    assert.deepEqual(dirs, [project]);
    const found = await findTopicSessions(dirs);
    assert.deepEqual(found.map((item) => [item.sessionId, topicLabel(item.state)]), [["b", "#proj > second"], ["a", "#proj > ✔ renamed"]]);
    assert.equal(found[1]!.name, "My task");
    assert.equal(
      describeTopicSession(found[1]!, new Date("2026-01-02T03:00:00Z"), original),
      "current session · detached · zulip.example.com · /work/proj · 3h ago · My task",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore handoff is single-use and bound to the target session file", () => {
  setRestoreHandoff("/tmp/s.jsonl");
  assert.equal(takeRestoreHandoff("/tmp/other.jsonl"), false);
  assert.equal(takeRestoreHandoff("/tmp/s.jsonl"), false);
  setRestoreHandoff("/tmp/s.jsonl");
  assert.equal(takeRestoreHandoff("/tmp/s.jsonl"), true);
  assert.equal(takeRestoreHandoff("/tmp/s.jsonl"), false);
});

test("non-TUI fallback labels include descriptions and stay unique", () => {
  assert.deepEqual(uniqueFallbackLabels([
    { value: "1", label: "#a > t", description: "x" },
    { value: "2", label: "#a > t", description: "x" },
    { value: "3", label: "#b > u" },
  ]), ["#a > t — x", "#a > t — x (2)", "#b > u"]);
});

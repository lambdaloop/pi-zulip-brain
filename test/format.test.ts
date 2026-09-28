import assert from "node:assert/strict";
import test from "node:test";
import { formatAttachment, formatIncomingMessage, formatOutbound, htmlToText, renderStatusCard } from "../src/session/format.ts";
import { makeStatusCard, readAttachmentFromBranch, SESSION_STATE_ENTRY } from "../src/session/state.ts";
import { DELIVERY_REACTION, type SessionAttachment, type ZulipMessage } from "../src/types.ts";

const message: ZulipMessage = {
  id: 21,
  sender_id: 4,
  sender_email: "human@example.com",
  stream_id: 8,
  subject: "build tests",
  content: "<p>Hello <strong>agent</strong>.</p><p>Second paragraph</p>",
  attachments: [{ name: "screen.png", path: "/user_uploads/abc/screen.png", size: 1024, content_type: "image/png" }],
};

test("HTML is converted to readable bounded plain text", () => {
  assert.equal(htmlToText("<p>A &amp; B</p><ul><li>one</li><li>two</li></ul>"), "A & B\n• one\n• two");
});

test("incoming messages are labeled and include safe attachment metadata", () => {
  const formatted = formatIncomingMessage(message, { full_name: "Human" }, "project", "build tests");
  assert.match(formatted, /Human in #project > build tests · message 21/);
  assert.match(formatted, /Hello agent/);
  assert.match(formatted, /screen\.png, 1\.0 KiB/);
});

test("outbound long text is capped into a spoiler block", () => {
  const formatted = formatOutbound("x".repeat(1500));
  assert.ok(formatted.length < 2200);
  assert.match(formatted, /```spoiler Full details/);
});

test("status card is deterministic and includes a decision log", () => {
  const card = makeStatusCard("Implement tests");
  card.status = "working";
  card.checklist.push("Typecheck");
  card.decisions.push("Use built-in fetch");
  assert.equal(renderStatusCard(card), "**Goal:** Implement tests\n**Status:** working\n\n**Checklist**\n- Typecheck\n\n**Decision log**\n- Use built-in fetch");
});

test("session attachment reader selects the latest valid active-branch entry", () => {
  const state: SessionAttachment = {
    version: 1,
    attached: true,
    serverHost: "zulip.example",
    channelName: "project",
    streamId: 8,
    topic: "build tests",
    botEmail: "project-bot@example.com",
    botUserId: 9,
    notifyUserId: 4,
    statusMessageId: 21,
    ownedMessageIds: [21],
    lastHandledMessageId: 20,
    statusCard: makeStatusCard("Build tests"),
    openQuestions: [],
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const branch = [
    { type: "custom", customType: SESSION_STATE_ENTRY, data: state },
    { type: "custom", customType: SESSION_STATE_ENTRY, data: { ...state, topic: "new topic" } },
  ];
  assert.equal(readAttachmentFromBranch(branch)?.topic, "new topic");
  assert.equal(DELIVERY_REACTION, "mail_received");
});

test("attachment renderer keeps Zulip upload path", () => {
  assert.equal(formatAttachment({ name: "screen.png", path: "/user_uploads/abc/screen.png" }), "[screen.png](/user_uploads/abc/screen.png)");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ZulipConnection } from "../src/session/connection.ts";
import { makeStatusCard } from "../src/session/state.ts";
import type { SessionAttachment, ZulipMessage, ZulipUser } from "../src/types.ts";

function createConnection() {
  const state: SessionAttachment = {
    version: 1,
    attached: true,
    serverHost: "zulip.example",
    channelName: "project",
    streamId: 8,
    topic: "build tests",
    botEmail: "bot@example.com",
    botUserId: 9,
    notifyUserId: 4,
    statusMessageId: 21,
    ownedMessageIds: [],
    lastHandledMessageId: 5,
    statusCard: makeStatusCard("test"),
    openQuestions: [
      { id: "q-one", messageId: 31, question: "Choose?", options: ["A", "B"] },
      { id: "q-two", messageId: 32, question: "Choose?", options: ["C", "D"] },
    ],
    updatedAt: new Date(0).toISOString(),
  };
  const pi = { appendEntry() {} } as unknown as ExtensionAPI;
  const connection = new ZulipConnection({
    pi,
    state,
    bot: { host: state.serverHost, baseUrl: "https://zulip.example", channelName: state.channelName, email: state.botEmail, apiKey: "secret", userId: state.botUserId },
    getContext: () => ({ ui: { notify() {} }, isIdle: () => true } as unknown as ExtensionContext),
  });
  const internals = connection as unknown as {
    getUser: (userId: number, signal?: AbortSignal) => Promise<ZulipUser>;
    deliverBatch: () => Promise<boolean>;
    addReceipt: () => Promise<boolean>;
    refreshStatusCard: () => Promise<void>;
    handleMessage: (message: ZulipMessage, signal: AbortSignal) => Promise<void>;
  };
  internals.getUser = async (userId) => ({ user_id: userId, email: "human@example.com", full_name: "Human" });
  internals.deliverBatch = async () => true;
  internals.addReceipt = async () => true;
  internals.refreshStatusCard = async () => undefined;
  return { connection, internals, state };
}

function message(content: string): ZulipMessage {
  return {
    id: 6,
    sender_id: 4,
    sender_email: "human@example.com",
    stream_id: 8,
    subject: "build tests",
    content,
  };
}

test("agent can record an untagged human reply as a question answer", () => {
  const { connection, state } = createConnection();
  assert.deepEqual(connection.resolveQuestion("q-one", "The latest message answers this: use option A."), {
    resolved: true,
    answer: "The latest message answers this: use option A.",
  });
  assert.equal(state.openQuestions[0]?.answer, "The latest message answers this: use option A.");
  assert.deepEqual(connection.resolveQuestion("q-one", "A different answer"), {
    resolved: false,
    answer: "The latest message answers this: use option A.",
  });
});

test("zulip_wait resolves on a new topic message without marking questions answered", async () => {
  const { connection, internals, state } = createConnection();
  const waiting = connection.waitForQuestion("q-one");
  await internals.handleMessage(message("A fresh topic update"), new AbortController().signal);
  assert.match(await waiting, /New message in the attached Zulip topic: Human: A fresh topic update/);
  assert.equal(state.openQuestions[0]?.answer, undefined);
});

test("a topic reply answers its referenced question and wakes other waits", async () => {
  const { connection, internals, state } = createConnection();
  const questionWait = connection.waitForQuestion("q-one");
  const otherWait = connection.waitForQuestion("q-two");
  await internals.handleMessage(message("q-one: choose A"), new AbortController().signal);
  assert.equal(await questionWait, "Human: q-one: choose A");
  assert.match(await otherWait, /New message in the attached Zulip topic: Human: q-one: choose A/);
  assert.equal(state.openQuestions[0]?.answer, "Human: q-one: choose A");
  assert.equal(state.openQuestions[1]?.answer, undefined);
});

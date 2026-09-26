import assert from "node:assert/strict";
import test from "node:test";
import { normalizeServerUrl, ZulipApiError, ZulipClient } from "../src/zulip/client.ts";

test("server URLs normalize and reject credential/query injection", () => {
  assert.equal(normalizeServerUrl("zulip.example/"), "https://zulip.example");
  assert.equal(normalizeServerUrl("https://zulip.example/zulip/"), "https://zulip.example/zulip");
  assert.equal(normalizeServerUrl("http://localhost:9991", true), "http://localhost:9991");
  assert.throws(() => normalizeServerUrl("http://zulip.example"), /HTTPS/);
  assert.throws(() => normalizeServerUrl("https://user:pass@zulip.example"), /without credentials/);
  assert.throws(() => normalizeServerUrl("https://zulip.example/?token=secret"), /without credentials/);
});

test("client authenticates profile requests and supports server base paths", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ result: "success", user: { user_id: 3, is_bot: false } });
  }) as typeof fetch;
  try {
    const client = new ZulipClient("https://zulip.example/zulip", "a@example.com", "secret-key");
    assert.equal((await client.getProfile()).user_id, 3);
    assert.equal(calls[0]?.url, "https://zulip.example/zulip/api/v1/users/me");
    assert.equal(calls[0]?.authorization, `Basic ${Buffer.from("a@example.com:secret-key").toString("base64")}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("password exchange is unauthenticated and API failures do not expose credentials", async () => {
  const originalFetch = globalThis.fetch;
  let authorization: string | null | undefined;
  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    const body = String(init?.body);
    assert.match(body, /password=plain-password/);
    return Response.json({ result: "error", msg: "invalid password plain-password" }, { status: 400 });
  }) as typeof fetch;
  try {
    const client = new ZulipClient("https://zulip.example", "a@example.com", "");
    await assert.rejects(client.fetchApiKey("a@example.com", "plain-password"), (error: unknown) => {
      assert.ok(error instanceof ZulipApiError);
      assert.match(error.message, /invalid password/);
      assert.doesNotMatch(error.message, /plain-password/);
      return true;
    });
    assert.equal(authorization, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("event subscriptions are narrowed by channel name and filtered event types", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    body = String(init?.body);
    return Response.json({ result: "success", queue_id: "q1", last_event_id: 7 });
  }) as typeof fetch;
  try {
    const client = new ZulipClient("https://zulip.example", "bot@example.com", "bot-key");
    const queue = await client.registerEventQueue("project");
    assert.equal(queue.queue_id, "q1");
    assert.match(body, /narrow=%5B%5B%22channel%22%2C%22project%22%5D%5D/);
    assert.match(body, /%22reaction%22/);
    assert.match(body, /queue_lifespan_secs=600/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

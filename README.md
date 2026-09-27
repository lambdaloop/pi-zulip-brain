# pi-zulip

A standalone Pi extension that connects an explicitly attached Pi session to one Zulip channel and topic. Each project channel has a dedicated Guest bot; a session only delivers messages from its own topic to the model.

## Install locally

```sh
pi install /home/lili/code/pi-zulip
```

Restart Pi, then run `/zulip-login https://your-zulip.example` and `/zulip-start`. The first command asks for an email and API key (or exchanges a password for a key without storing the password), then asks which human account should receive mentions. `/zulip-start` lets you choose an existing project bot/channel or create a private project channel and Guest bot. A new channel is created with the human and provisioning account subscribed; the provisioning account is removed after the Guest bot is configured.

Only an attached session has Zulip tools. Use `/zulip-stop` to detach. An explicitly attached session reconnects when resumed; missed messages are previewed before delivery.

## Agent tools

- `zulip_post`: concise milestone or blocking update to the attached topic.
- `zulip_read`: bounded, paginated history from only the attached topic.
- `zulip_status`: inspect/update the session's status card and decision log.
- `zulip_ask`: post a blocking decision with reaction options without waiting.
- `zulip_wait`: optionally wait for a question's answer.

Human messages are delivered only after channel, topic, sender, and duplicate checks pass. A 📨 (`mail_received`) reaction means the message was queued to Pi, not that the agent acted on it.

## Security

Credentials live under `~/.config/pi-zulip/servers/` with restrictive file permissions. Provisioning and bot keys are never written into Pi session entries. Use HTTPS except for an explicitly confirmed localhost development server. Review the recipient, topic, and any files before sharing. Guest role assignment is verified; the extension refuses to attach if isolation setup fails. The provisioning Zulip account should be dedicated and protected; it can administer bots and retrieve keys for bots it owns.

## Development

```sh
npm install
npm test
npm run typecheck
```

Tests cover URL normalization, authentication and redaction, event-queue narrowing, formatting, session-state recovery, and extension registration. They mock HTTP; run the manual checklist below against a test channel before relying on a new server.

### Manual end-to-end checklist

1. `/zulip-login`, then `/zulip-start pi-test first topic` — a status card appears and `/zulip-status` shows `connected`.
2. Post from Zulip in that topic — the agent receives it and the message gets 📨. A message in another topic is ignored.
3. Ask the agent to call `zulip_ask`; answer with 1️⃣ — the decision reaches Pi.
4. `/zulip-resolve`, then `/zulip-resolve --undo` — the topic gains, then loses, the `✔ ` prefix.
5. Quit Pi, post in Zulip, resume the session — a backlog preview appears before delivery.

### Not yet implemented

- Status-card edits are sent immediately rather than batched every 5–10 seconds.
- `/zulip-start` does not tab-complete channel names.

Pi, Pi TUI, and TypeBox are peer dependencies supplied by the Pi runtime. The package currently targets the extension APIs in Pi 0.87.1 and the Zulip REST API verified against Zulip 12.3. Push notifications, joining another live session's topic, and subagent posting are not included.

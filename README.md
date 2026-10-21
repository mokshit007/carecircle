# CareCircle: one Alexa+ for the whole family

**CareCircle is a self-hosted MCP server that connects an older adult's Echo with the Echos of everyone who cares for them.**
It helps Mum with her medicines by voice. It tells the family when something needs attention. And it notices when her
routine quietly starts to change, by combining her voice check-ins with **Ring** front-door activity at night.

> **Margaret (kitchen Echo Show):** "I took my Metformin." → *"Logged your 8 AM Metformin. Next up is Vitamin D at noon."*
> **Margaret, an hour later:** "I took my Metformin." → *"I already have that logged at 1:30. Your next one isn't until 7 PM, so there's no need to take another."* (and the family is told)
> **Priya (her daughter's Echo, 200 miles away):** "How's Mum doing?" → *"She's taken 3 of 5 doses today. I've noticed a change in her routine: front-door activity at night three nights running, evening doses being missed, and later mornings…"* (with the care-circle view on screen)
> **Priya:** "I'll drive her to cardiology." → the task is claimed, Sam is told, and Margaret's Echo says *"Priya will drive you to your cardiology check-up."*

## Why this matters

* Many adults over 65 take **five or more medicines** every day, and missed or doubled doses are a common cause of avoidable hospital visits.
* Most family caregivers **live away** and only find out something has changed when there is a crisis.
* Amazon's **Alexa Together** caregiving service was discontinued in 2024. Families still need it. Alexa+ and MCP make it possible again, with an agent that can reason over a whole care circle instead of fixed routines.

## What's new here

1. **One MCP server, a whole family, role-scoped tools.** Each Echo connects with its own token, so the server knows
   who is speaking. Margaret's Echo gets a gentle voice toolset (`log_dose`, `log_wellbeing`, `message_family`…).
   Her daughter's Echo gets the family toolset (`get_circle_status`, `get_routine_insights`, `claim_task`,
   `message_recipient`, `prepare_visit_brief`…). Same server, different `tools/list`.
2. **Routine-drift early warning across Alexa and Ring.** CareCircle compares the last 3 days with the person's own
   10-day baseline on six explainable signals: front-door motion between midnight and 5 AM (Ring), missed evening
   doses, dose delay, when the day starts, mood, and new symptoms. Each signal is simple and shown with its numbers.
   Combined, they catch the slow changes (night wandering, slipping routines) that often come before a crisis.
   **Claude on Amazon Bedrock** explains the change in plain language for the family, without diagnosing.
3. **MCP Apps for Echo Show.** `get_today_schedule` and `get_circle_status` declare `ui://` views (MCP Apps,
   spec 2026-01-26). On a screen, Margaret gets big "I took it" buttons that call an **app-only** tool
   (`visibility: ["app"]`). Priya gets a care-circle card with routine signals and "I'll do it" buttons for tasks.
4. **Proactive, escalating care.** A reminder engine announces doses on Margaret's Echo, checks in again after
   30 minutes, and tells the family after 60, through their Echos, the dashboard and optionally **Amazon SNS**
   text or email. It respects quiet hours and opens family tasks for low supply and for appointments that need a ride.
5. **Safety built into the server, not left to the model.** Emergency phrases (falls, chest pain, breathing trouble)
   are caught by deterministic rules and alert the family instantly. A **double-dose guard** refuses a likely repeat
   "I took it" and tells the family. It never suggests taking another dose when someone is unsure.
6. **An Agent Skill** ([`skills/carecircle-care-companion/SKILL.md`](skills/carecircle-care-companion/SKILL.md),
   open Agent Skills format) teaches any agent how to run CareCircle: how to speak, safety rules, and which tool for
   which moment. The demo's Alexa stand-in loads it as its instructions.

## Architecture

```
  Margaret's Echo Show          Priya's Echo              Sam's Echo
  (care recipient token)        (caregiver token)         (caregiver token)
          │                            │                          │
          └──────────── Streamable HTTP · MCP 2025-11-25 ─────────┘
                                       │
                     ┌─────────────────▼──────────────────┐
  Ring doorbell ───▶ │  CareCircle MCP server              │ ──▶ Amazon SNS (SMS / email)
  webhooks v1.1      │  · role-scoped tools per person     │
  (HMAC-verified)    │  · MCP Apps views (ui://)           │ ──▶ Family dashboard (live SSE)
                     │  · reminder & escalation engine     │
                     │  · routine-drift detector           │ ──▶ Claude on Amazon Bedrock
                     │  · double-dose & emergency guards   │     (drift explanations, digest,
                     └─────────────────────────────────────┘      visit brief, label vision, agent)
```

| Piece | Where | Notes |
|---|---|---|
| MCP server | [src/mcp.js](src/mcp.js), [src/server.js](src/server.js) | `@modelcontextprotocol/sdk` 1.32, stateless Streamable HTTP, protocol **2025-11-25**, bearer token → person → toolset; icons, annotations, `structuredContent` on every tool |
| MCP Apps views | [src/views/](src/views), [src/views.js](src/views.js) | `text/html;profile=mcp-app`, `_meta.ui.resourceUri`, app-only tools; official `@modelcontextprotocol/ext-apps` runtime inlined |
| Routine drift | [src/drift.js](src/drift.js) | six signals vs personal baseline → steady / watch / concern |
| Escalation engine | [src/escalation.js](src/escalation.js), [src/notify.js](src/notify.js) | reminders, family alerts, refill and ride tasks, SNS |
| Ring | [src/ring.js](src/ring.js) | Ring Partner API webhook v1.1: `X-Signature` HMAC-SHA256 over raw body, `meta.request_id` de-dup, 200 before processing |
| Claude on Bedrock | [src/bedrock.js](src/bedrock.js), [src/agent.js](src/agent.js) | `@anthropic-ai/bedrock-sdk` (Mantle); every AI feature has a deterministic fallback |
| Agent Skill | [skills/carecircle-care-companion/SKILL.md](skills/carecircle-care-companion/SKILL.md) | loaded by the demo agent as its system instructions |
| Echo Show simulator | [public/echo.html](public/echo.html) | a working **MCP Apps host**: sandboxed iframe, `ui/initialize`, tool-input/result, proxied `tools/call`, `ui/message`, model context |
| Family dashboard | [public/index.html](public/index.html) | routine check, Ring night chart, live alerts, tasks, visit brief, pill-bottle scan |

## Run it

Requires Node.js 22.9+.

```bash
npm install
npm start
```

| Open | What |
|---|---|
| http://127.0.0.1:3000/echo.html | Echo Show simulator: switch between Margaret's, Priya's and Sam's devices |
| http://127.0.0.1:3000/ | Family dashboard |
| `http://127.0.0.1:3000/mcp` | MCP endpoint: send `Authorization: Bearer <token>` |

Demo tokens: `margaret-echo-demo` (care recipient), `priya-echo-demo` and `sam-echo-demo` (caregivers). Without a
token, local requests act as Margaret (turn that off with `ALLOW_ANONYMOUS=false`).

End-to-end test (both roles, MCP Apps resources, Ring signatures, auth):

```bash
npm run smoke
```

### Use it from the Claude desktop app (or any stdio MCP host)

[`scripts/claude-bridge.js`](scripts/claude-bridge.js) connects a stdio MCP host to the running server as one
person, forwarding every message, so the role-scoped tools and MCP Apps views come through as-is.

Quit the Claude desktop app completely, run `npm run install-claude`, then start CareCircle and reopen Claude.
The installer backs up your config and adds these entries (you can also add them by hand):

```json
{
  "mcpServers": {
    "carecircle-priya":    { "command": "node", "args": ["<repo>/scripts/claude-bridge.js", "--as", "priya"] },
    "carecircle-margaret": { "command": "node", "args": ["<repo>/scripts/claude-bridge.js", "--as", "margaret"] }
  }
}
```

Enable one at a time per chat, then try "How's Mum doing?" as Priya or "I took my Metformin" as Margaret.
`node scripts/bridge-check.js priya` checks the bridge from the command line.

For a repeatable demo, `npm run demo` starts with fresh data and the household clock pinned to 1:30 PM.

### Test the views in the official MCP Apps reference host

CareCircle's views have been tested in `basic-host` from
[modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host):
both views render inside its double-iframe sandbox, and in-view buttons call `confirm_dose_from_screen` and
`claim_task` through its AppBridge. basic-host can't send auth headers, so pick the person with
`CARECIRCLE_DEFAULT_PERSON`:

```bash
CARECIRCLE_DEFAULT_PERSON=priya npm run demo
# in a copy of ext-apps/examples/basic-host, after npm install:
INPUT=index.html npx vite build && INPUT=sandbox.html npx vite build
SERVERS='["http://localhost:3000/mcp"]' node serve.ts   # then open http://localhost:8080
```

Try it in MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

Then connect to `http://127.0.0.1:3000/mcp` (Streamable HTTP) with header `Authorization: Bearer priya-echo-demo`.

### Configuration

Copy `.env.example` to `.env` (it is loaded automatically).

| Variable | Default | Purpose |
|---|---|---|
| `BEDROCK_ENABLED` | `false` | `true` turns on Claude for the voice agent, drift explanations, digest, visit brief and label reading |
| `AWS_REGION` | `us-east-1` | Bedrock and SNS region (standard AWS credential chain) |
| `BEDROCK_MODEL_ID` | `anthropic.claude-opus-5-5` | Any Claude model enabled in your account |
| `SNS_TOPIC_ARN` | – | Send urgent alerts, escalations and drift insights to caregivers by SMS or email |
| `RING_WEBHOOK_SECRET` | demo secret | Your Ring app's HMAC signing key |
| `ALLOW_ANONYMOUS` | `true` | `false` requires a bearer token on `/mcp` |
| `HOST` / `PORT` / `ALLOWED_HOSTS` | `127.0.0.1` / `3000` / – | Bind address and Host allow-list when exposed |
| `CARECIRCLE_TZ` | system | Household timezone |
| `CARECIRCLE_CLOCK` | – | Pin the time of day (e.g. `13:30`) for repeatable demos |

### Deploy

The server is stateless, so it runs anywhere a container runs. See [docs/DEPLOY.md](docs/DEPLOY.md) for Docker, Amazon
Bedrock AgentCore Runtime and exposing it to Alexa+.

## Safety and privacy

* CareCircle is a reminder, logging and coordination aid, **not a medical device**. It never recommends doses or
  medication changes, and its AI features are instructed to describe, not diagnose.
* Emergency detection and the double-dose guard are deterministic and run on the server.
* Each person only sees the tools for their role; tokens map to people on the server.

## License

MIT

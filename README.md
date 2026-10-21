# CareCircle: medication and wellbeing support for Alexa+

**CareCircle is a self-hosted MCP server that lets an older adult manage medications, appointments and daily check-ins just by talking to Alexa+, and gives their family a dashboard and alerts.**

> "Alexa, I just took my Metformin." · "Did I miss anything today?" · "I fell in the kitchen." · "How has Mum been doing this week?"

About 1 in 4 adults over 65 takes five or more prescriptions, and missed or doubled doses are one of the most common reasons older people end up in hospital. The people who help most, adult children who often live far away, usually have no idea whether the morning pills were taken. Pill-reminder apps assume a smartphone and good eyesight. A voice assistant in the kitchen needs neither.

CareCircle turns Alexa+ into that missing link:

| For the older adult (voice) | For the family (dashboard + alerts) |
|---|---|
| "What do I take today?" gives the schedule with what's done and what's left | Live view of today's doses: taken, due, missed |
| "I took my Metformin" logs the right dose and says what's next | 7-day adherence chart with missed-dose patterns |
| "Did I miss anything?" checks gently, without suggesting a double dose | Automatic alert when a dose is overdue or logged unusually early |
| "I'm feeling dizzy" or "I fell" logs it; serious words alert family **immediately** | Wellbeing journal with mood and symptoms |
| "Tell Priya I need a refill" sends a message to the family feed | Weekly AI digest written by Claude on Amazon Bedrock |
| "When's my next doctor visit?" | Upcoming appointments with notes ("bring BP log") |

## Architecture

```
 ┌──────────────┐  Streamable HTTP   ┌─────────────────────────────┐
 │   Alexa+     │ ─────────────────▶ │  CareCircle MCP server      │
 │ (or any MCP  │   POST /mcp        │  protocol 2025-11-25        │
 │  client)     │ ◀───────────────── │  11 tools · 1 resource ·    │
 └──────────────┘                    │  1 prompt                   │
                                     │        │                    │
 ┌──────────────┐   /api/assistant   │        ▼                    │
 │ Voice console│ ──▶ agent loop ──▶ │  care logic + JSON store    │──▶ Family dashboard
 │ (simulated   │   Claude on Bedrock│        │                    │    (/ , polls /api/state)
 │  Echo)       │   calls tools via  │        ▼                    │
 └──────────────┘   MCP client       │  Claude on Amazon Bedrock   │
                                     │  (weekly digest)            │
                                     └─────────────────────────────┘
```

* **MCP server**: `@modelcontextprotocol/sdk` 1.32, `StreamableHTTPServerTransport`, protocol version **2025-11-25**. It runs stateless (a fresh server per request), so it scales horizontally or on Lambda without sticky sessions. Every tool has `title`, `annotations` (read-only, destructive and open-world hints) and returns a short **speakable sentence** first, then JSON detail.
* **Simulated Alexa+ console** (`/voice.html`): browser speech recognition and speech synthesis. The backend runs an agent loop on **Claude on Amazon Bedrock**. It discovers the tools through MCP `tools/list` and calls them through MCP `tools/call` over Streamable HTTP, the same path Alexa+ uses. A side panel shows every MCP call live.
* **AWS**: Claude on Amazon Bedrock (via `@anthropic-ai/bedrock-sdk`, Bedrock Mantle Messages API) writes the caregiver digest and powers the voice agent.
* **Safety by design**: CareCircle never gives dosing advice. "Did I miss it?" never suggests taking another dose (it points to the pharmacist). Emergency phrases (falls, chest pain, breathing trouble, confusion) are caught by deterministic rules, not the LLM, so the family is alerted even if the model misreads the request.

## MCP surface

| Tool | What it does |
|---|---|
| `get_today_schedule` | Today's doses with status: taken, skipped, due, missed, upcoming |
| `log_dose` | Fuzzy-matches the spoken drug name, picks the right slot, warns on early doses, refuses double logging |
| `check_missed_doses` | Overdue doses, posted to the family feed once each |
| `list_medications` / `add_medication` / `stop_medication` | Manage the plan (`stop_medication` is marked `destructiveHint`) |
| `log_wellbeing` | Mood 1–5, symptoms, note; urgent keywords trigger instant caregiver alert |
| `notify_caregiver` | Message the family feed |
| `add_appointment` / `list_upcoming_appointments` | Appointments in spoken form |
| `get_care_digest` | Weekly adherence, mood and symptom summary, written by Claude on Bedrock (template fallback) |

Resource: `carecircle://care-plan` (Markdown care plan) · Prompt: `daily_check_in`

## Run it

Requires Node.js 22.9+. Settings are read from a `.env` file if present (copy `.env.example`).

```bash
npm install
npm start
```

* Family dashboard: http://127.0.0.1:3000/
* Alexa+ voice console: http://127.0.0.1:3000/voice.html (Chrome or Edge for the microphone)
* MCP endpoint: `http://127.0.0.1:3000/mcp`

Run the end-to-end MCP test against the running server:

```bash
npm run smoke
```

Without AWS credentials the voice console uses a small keyword router that still goes through the real MCP tools. To use Claude on Amazon Bedrock, copy `.env.example` and set:

| Variable | Default | Purpose |
|---|---|---|
| `BEDROCK_ENABLED` | `false` | `true` turns on Claude for the voice agent and the digest |
| `AWS_REGION` | `us-east-1` | Bedrock region (standard AWS credential chain is used) |
| `BEDROCK_MODEL_ID` | `anthropic.claude-opus-5-5` | Any Claude model enabled in your account |
| `MCP_AUTH_TOKEN` | – | Require `Authorization: Bearer <token>` on `/mcp` |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bind address |
| `ALLOWED_HOSTS` | – | Comma-separated Host headers allowed when exposed through a tunnel or domain |
| `CARECIRCLE_TZ` | system | Household timezone |
| `CARECIRCLE_CLOCK` | – | Pin the time of day (e.g. `13:30`) for repeatable demos |

You can also set them in the shell instead; on PowerShell, use `$env:BEDROCK_ENABLED="true"` before `npm start`.

### Connect it to Alexa+ or another MCP client

1. Expose the server over HTTPS, for example with a tunnel: `HOST=0.0.0.0 ALLOWED_HOSTS=<your-tunnel-host> MCP_AUTH_TOKEN=<secret> npm start`.
2. Register `https://<your-host>/mcp` as a Streamable HTTP MCP server in the Alexa+ developer preview (or in MCP Inspector: `npx @modelcontextprotocol/inspector`).

## Project layout

```
src/server.js   HTTP entry: /mcp, dashboard API, voice-console API
src/mcp.js      MCP tools, resource and prompt
src/care.js     Scheduling, adherence, alerts, digest facts
src/agent.js    Claude-on-Bedrock agent loop that uses the MCP server as its tools
src/bedrock.js  Bedrock client and digest writer
src/store.js    JSON store and demo household seed
public/         Family dashboard and simulated Alexa+ console
scripts/smoke.js End-to-end MCP client test
```

## Not medical advice

CareCircle is a reminder and logging aid, not a medical device. It never recommends doses or changes to medication.

## License

MIT

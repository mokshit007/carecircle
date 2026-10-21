# Submission kit (Amazon Developer Hackathon)

**Track:** Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP)
**Mini challenges:** AWS Builder (Claude on Amazon Bedrock) · optionally Open Source (repo is MIT-licensed)

---

## Project description (paste into Devpost)

**CareCircle: Alexa+ that helps older adults take their medications and keeps their family in the loop.**

Missed and doubled doses are among the most common causes of avoidable hospital visits for older adults. Their adult children often live far away and can't tell whether the morning pills were taken. Phone apps assume a smartphone, small text and good eyesight. A voice assistant in the kitchen needs none of these.

CareCircle is a self-hosted MCP server (protocol 2025-11-25, Streamable HTTP) that gives Alexa+ 11 care tools, a care-plan resource and a daily check-in prompt:

- **"I just took my Metformin"**: fuzzy-matches the drug name, logs the right dose slot, says what's next, refuses to double-log, and tells the family about an unusually early dose.
- **"Did I miss anything?"**: lists overdue doses and never suggests a double dose (it points to the pharmacist instead). Overdue doses go to the family feed automatically.
- **"I fell in the kitchen"**: logged in the wellbeing journal. Emergency phrases are caught by deterministic rules (not the LLM) and alert the family immediately.
- **"Tell Priya I need a refill"**: sends a message to the family feed.
- **"How has Mum been doing this week?"**: a weekly digest of adherence, missed-dose patterns, mood and symptoms, written by Claude on Amazon Bedrock.

Family caregivers get a live dashboard: today's doses, 7-day adherence, alerts, wellbeing journal and upcoming appointments.

**How it works:** Node.js and the official MCP TypeScript SDK (`StreamableHTTPServerTransport`, stateless, so it scales horizontally or on Lambda). Every tool has annotations (read-only, destructive and open-world hints) and returns a short speakable sentence followed by JSON detail, written for voice. The demo's simulated Alexa+ console runs an agent loop on Claude on Amazon Bedrock that discovers and calls the tools through a real MCP client over Streamable HTTP. A side panel shows each `tools/call` live.

**Built during the hackathon window:** everything in the repository.

---

## Demo video script (target 2:45)

| Time | Show | Say |
|---|---|---|
| 0:00–0:15 | Title card, then the dashboard | "1 in 4 adults over 65 takes five or more prescriptions. Their families have no idea whether the morning pills were taken. CareCircle fixes that with Alexa+." |
| 0:15–0:30 | Terminal: `npm start` banner showing `2025-11-25` and `/mcp`; `npm run smoke` listing 11 tools | "CareCircle is a self-hosted MCP server on the 2025-11-25 spec over Streamable HTTP." |
| 0:30–1:30 | Voice console, speaking aloud: "What medicine do I take today?", "I just took my Metformin", "Did I miss anything?" Point to the MCP tool-call panel | "Margaret just talks. Claude on Bedrock picks the tool and the MCP server does the work. Here's the actual `tools/call` going over Streamable HTTP." |
| 1:30–1:55 | "I fell in the kitchen and my hip hurts", then switch to the dashboard: red urgent alert | "Emergencies aren't left to the model. Deterministic rules alert Priya instantly." |
| 1:55–2:20 | "Tell Priya I need a refill of Lisinopril", then "How has Mum been doing this week?" | "And for the family, a weekly digest written by Claude on Amazon Bedrock that spots the pattern: the evening Metformin keeps getting missed." |
| 2:20–2:45 | Dashboard overview, then README architecture | "Stateless, so it deploys to Lambda. Never gives medical advice. Open source. CareCircle: peace of mind for the whole family." |

Recording tips: start the server with `CARECIRCLE_CLOCK=13:30` so one dose is overdue on screen, click **Reset demo data** before recording, and set `BEDROCK_ENABLED=true` so the Claude path (not the offline router) is shown.

---

## Product feedback (draft: edit with your own experience)

**MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32)**
- Used for: the server (`McpServer`, `registerTool/Resource/Prompt`, `StreamableHTTPServerTransport`) and the voice console's client (`Client`, `StreamableHTTPClientTransport`).
- Worked well: `createMcpExpressApp` adds DNS-rebinding protection by default; the stateless mode is a few lines; protocol 2025-11-25 negotiated with no configuration.
- Needs work: when exposing through a tunnel, the localhost host check silently returns 403 until `allowedHosts` is set. The error could name the option.
- Would build with it again: yes.

**Claude on Amazon Bedrock (AWS Builder)**
- Used for: the voice agent loop (tool use over MCP-discovered tools) and the weekly caregiver digest.
- Worked well: MCP tool schemas map directly onto Claude tool definitions with no conversion.
- Needs work / onboarding: *(fill in your experience enabling model access and credentials)*.

**Alexa+ MCP integration**
- *(fill in: what registering the endpoint was like, documentation, testing loop)*

## Friction log (up to 10% bonus; fill in as you go)

| Task | Steps | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|
| Expose local MCP server to a remote client | Ran behind a tunnel | Requests reach the server | 403 from host validation | Medium | Set `ALLOWED_HOSTS` | Log the rejected Host header and the option to set |
| | | | | | | |

## Feature requests (optional)

- **Important:** An official Alexa+ MCP simulator or test console, so developers can see how Alexa+ chooses tools and reads responses aloud before preview access.
- **Nice-to-have:** Proactive notifications from an MCP server to the device ("You haven't logged your 8 AM pill"), which medication reminders need.

---

## Submission checklist

- [ ] Push to GitHub (public with the MIT LICENSE, or private and shared with testing@devpost.com and knmeiss, giolaq, anishamalde, mosesroth, emersonsklar, added **at submission time**, since invites expire after 7 days)
- [ ] Record the demo (under 3 min, English, public on YouTube or Vimeo, no copyrighted music)
- [ ] Run once with `BEDROCK_ENABLED=true` to show Claude on Bedrock
- [ ] Fill in the feedback and friction-log sections with your own experience
- [ ] Select track Alexa+ and the AWS Builder mini challenge

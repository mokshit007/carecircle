# Submission kit (Amazon Developer Hackathon)

**Primary track:** Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP, plus MCP Apps views and an Agent Skill)
**Mini challenges:** Open Source (MIT repo). Add AWS Builder only if you get Bedrock running and show it in the video.
**Deadline:** 24 Oct 2026, 12:30 AM (as shown on Devpost)

---

## Project description (paste into Devpost)

### CareCircle: one Alexa+ for the whole family

Amazon's Alexa Together caregiving service was retired in 2024, but the problem it addressed remains. Many older
adults juggle five or more daily medicines, and the family members who help usually live elsewhere and find out
something has changed only when there is a crisis.

**CareCircle is a self-hosted MCP server that connects an older adult's Echo with the Echos of everyone who cares
for them.**

**One server, a whole family, role-scoped tools.** Each Echo connects with its own token. Margaret's kitchen Echo Show
gets a gentle voice toolset: "I took my Metformin", "did I miss anything?", "I didn't sleep well", "tell Priya I need
milk". Her daughter Priya's Echo, in another city, gets the family toolset: "How's Mum doing?", "Has anything
changed?", "I'll drive her to cardiology", "Tell Mum I'll call tonight", "Prepare a brief for her doctor". Same MCP
server, different `tools/list`.

**Routine-drift early warning across Alexa and Ring.** CareCircle compares the last three days with the person's own
baseline on six explainable signals. Night-time front-door motion comes from Ring webhooks; missed evening doses, dose
timing, when the day starts, mood and new symptoms come from voice. When several shift together (night wandering,
slipping routines, low mood), the family gets a "concern" insight with the numbers behind it, and Claude on Amazon
Bedrock explains it in plain language without diagnosing.

**MCP Apps on Echo Show.** Tools declare `ui://` views. Margaret sees big "I took it" buttons that call an app-only
tool. Priya sees a care-circle card with routine signals and one-tap "I'll do it" family tasks.

**Proactive, escalating care.** Doses are announced on Margaret's Echo, with a softer check-in after 30 minutes and a
family alert after 60 (Echo, dashboard and optionally Amazon SNS text or email). Low medication supply and
appointments that need a ride become family tasks that siblings claim by voice.

**Safety in the server, not the prompt.** Falls, chest pain and breathing trouble are caught by deterministic rules
and alert the family instantly. A double-dose guard stops a repeated "I took my Metformin" from logging the evening
dose early, tells Margaret she doesn't need another, and lets the family know.

**Built with:** MCP TypeScript SDK (Streamable HTTP, protocol 2025-11-25, stateless, annotations, structuredContent,
icons), MCP Apps (`@modelcontextprotocol/ext-apps`), an Agent Skill (SKILL.md) that the agent loads as its
instructions, Ring Partner API webhooks v1.1 (HMAC-verified, de-duplicated), Claude on Amazon Bedrock (agent loop,
drift explanation, weekly digest, doctor-visit brief, pill-bottle label vision), Amazon SNS, and a Docker image ready
for AgentCore Runtime.

**Built during the hackathon window:** everything in the repository.

---

## Demo video script (target 2:50)

Two hosts show the same MCP server:
- **Claude desktop app**: a real, independent MCP host. The AI picks CareCircle's tools itself and renders the MCP Apps views in the chat.
- **Echo Show simulator** (`/echo.html`): shows what only a home device can, such as spoken reminders popping up, the same server serving three family Echos, and Ring events arriving live.

**Before recording**
1. Run `npm run demo`. It starts fresh demo data with the clock pinned to 1:30 PM, so one dose is overdue.
2. One time only: quit the Claude desktop app completely (including the tray icon), run `npm run install-claude`, then reopen Claude. That adds the `carecircle-priya` and `carecircle-margaret` connectors. In each new chat, enable only the one you need from the connectors menu.
3. Open three windows: the dashboard (`/`), the Echo simulator (`/echo.html`) and Claude.
4. Rehearse once, then run `npm run demo` again so the data is fresh for the real take.

| Time | Show | Say |
|---|---|---|
| 0:00–0:15 | Dashboard, routine check card in red | "Amazon retired Alexa Together in 2024. Families still need it. CareCircle brings it back as an Alexa+ MCP server for the whole family." |
| 0:15–0:40 | Echo simulator as **Margaret**: the 8 AM reminder pops up and is spoken (click **Reset demo** on the dashboard to replay it). Click "What do I take today?" → Today view → tap **I took it** | "Margaret's Echo reminds her and shows her medicines. One tap, or one sentence, and it's logged. That screen is an MCP Apps view calling an app-only tool." |
| 0:40–0:55 | Margaret: "I took my Metformin" again | "Older adults repeat themselves. CareCircle won't log the evening dose five hours early. It reassures her and quietly tells the family." |
| 0:55–1:45 | **Claude desktop**, `carecircle-priya` enabled: type "How's Mum doing?" → care-circle view renders in chat. Then "Has anything changed with her routine? Should I be worried?" | "Here's the same server in a completely independent MCP host. Priya gets a different toolset. The AI pulls her status, and the server's drift detector has spotted that Ring saw the front door open at 2 or 3 AM three nights running, her evening doses slipped and her mornings got later." |
| 1:45–2:10 | In Claude: "I'll drive her to the cardiology appointment, and tell her I'll call tonight." Cut to the Echo simulator on Margaret: the announcement arrives | "Family tasks get claimed by voice, and Mum hears about it on her own Echo." |
| 2:10–2:30 | Dashboard: **Motion at 2:47 AM** → live alert. Echo as Margaret: "I fell in the kitchen" → urgent alert on Priya's devices | "Real Ring webhooks, HMAC-verified. Emergencies are caught by rules on the server, not left to the model." |
| 2:30–2:50 | Dashboard **Visit brief** dialog, then README architecture and `npm run smoke` passing | "And the doctor gets a one-page brief. MCP 2025-11-25 over Streamable HTTP, role-scoped tools, MCP Apps, an Agent Skill and Ring. Open source. CareCircle." |

The views are verified in the official MCP Apps reference host (see README). If MCP Apps views don't render in your Claude desktop version, the tools still work and reply in text. Show the views
in the Echo simulator instead.

---

## AWS Builder: integration details (only if you enable Bedrock)

- **Claude on Amazon Bedrock** (`@anthropic-ai/bedrock-sdk`, Mantle Messages API), in [src/bedrock.js](src/bedrock.js) and [src/agent.js](src/agent.js):
  agent loop over MCP-discovered tools, routine-drift explanations, weekly digest, doctor-visit brief, and pill-bottle
  label reading (vision).
- **Amazon SNS** ([src/notify.js](src/notify.js)): urgent alerts, escalations and drift insights to caregivers.
- **AgentCore Runtime-ready** container ([Dockerfile](Dockerfile), [docs/DEPLOY.md](docs/DEPLOY.md)): stateless
  Streamable HTTP on `0.0.0.0:8000/mcp`.

## Open Source: fields

- Repo: https://github.com/mokshit007/carecircle (MIT)
- GitHub username: mokshit007
- What, how and why: *(write 2–3 sentences in your own words)*

---

## Product feedback (draft: rewrite with your own experience)

**MCP TypeScript SDK 1.32**: Used for the role-scoped server, stateless Streamable HTTP and the simulator's client.
Worked well: `registerTool` with annotations, `_meta` and `structuredContent`; 2025-11-25 negotiated with no
configuration. Needs work: the localhost Host-header check returns a bare 403 behind a tunnel until `allowedHosts`
is set.

**MCP Apps (`@modelcontextprotocol/ext-apps` 1.7)**: Used for the Today and Care-circle views and the simulator's host
bridge. Worked well: the `App` class (`ontoolresult`, `callServerTool`, `updateModelContext`) is small and clear.
Needs work: 2.x requires SDK v2 peers, so v1 servers must stay on ext-apps 1.x; a single-file "classic script" build
would make self-contained views easier.

**Ring Partner API**: Used for webhook v1.1 payloads and HMAC verification. Worked well: clear payload examples,
`meta.request_id` for idempotency. Needs work: no device-free sandbox or webhook replay tool for developers without
hardware.

**Claude on Amazon Bedrock**: *(fill in: model access, credentials, latency for voice)*

**Alexa+ MCP**: *(fill in: what registering the endpoint was like, how you tested)*

## Friction log (up to 10% bonus; fill in as you go)

| Task | Steps | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|
| Test Ring webhooks without a device | Read API docs, looked for a sandbox | A way to trigger signed test events | None documented | Medium | Built a signer that sends real v1.1 payloads to our own endpoint | A portal button that sends a signed test event |
| Test views in the MCP Apps reference host (basic-host) | Cloned ext-apps, `npm run start` in examples/basic-host | Host starts | `serve` needs Bun; host can't send auth headers; browser host needs CORS on /mcp | Medium | Built with `npx vite`, ran `node serve.ts`; added CORS; picked the person via env var | Document a Node path and support custom headers per server |
| Use MCP Apps with an SDK v1 server | Installed latest ext-apps | Works with the current SDK | 2.x needs SDK v2 peers | Low | Pinned ext-apps 1.7.5 | Document the version matrix on the landing page |
| | | | | | | |

## Feature requests

- **Critical:** Proactive notifications from an MCP server to an Echo (spoken reminders and family announcements). Medication reminders depend on it.
- **Important:** Speaker identity passed to MCP servers (who is talking), so role-scoped tools work on shared devices.
- **Nice-to-have:** An official Alexa+ MCP test console that shows tool selection and MCP Apps rendering on an Echo Show frame.

---

## Checklist

- [ ] Quit Claude, run `npm run install-claude`, reopen Claude and check the CareCircle connectors appear
- [ ] (Optional) AWS account + Bedrock → `BEDROCK_ENABLED=true`, then add the AWS Builder mini challenge
- [ ] Record the video (under 3 min, English, public on YouTube or Vimeo, no copyrighted music)
- [ ] Rewrite the feedback and friction log in your own words
- [ ] Devpost: Alexa+ track, AWS Builder and Open Source mini challenges, repo link, video link

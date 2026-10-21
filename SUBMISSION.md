# Submission kit (Amazon Developer Hackathon)

**Primary track:** Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP, plus MCP Apps views and an Agent Skill)
**Mini challenges:** AWS Builder (Claude on Amazon Bedrock, Amazon SNS, AgentCore-ready container) · Open Source (MIT repo)
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

Before recording: `.env` with `BEDROCK_ENABLED=true` and `CARECIRCLE_CLOCK=13:30`, `npm start`, open the dashboard and
the Echo simulator side by side, and click **Reset demo** (this replays the 8 AM reminder).

| Time | Show | Say |
|---|---|---|
| 0:00–0:15 | Dashboard, routine check card in red | "Amazon retired Alexa Together in 2024. Families still need it. CareCircle brings it back with Alexa+ and MCP, for the whole family." |
| 0:15–0:45 | Echo simulator as **Margaret**: the reminder pops up and is spoken. Say "What do I take today?" → Today view on screen → tap **I took it** | "Margaret's Echo reminds her and shows her medicines. One tap, or one sentence, and it's logged. Under the hood: an MCP Apps view calling an app-only tool." |
| 0:45–1:05 | Margaret: "I took my Metformin" again | "Older adults repeat themselves. CareCircle won't log the evening dose five hours early; it reassures her and quietly tells the family." |
| 1:05–1:50 | Switch to **Priya's** Echo: "How's Mum doing?" → care-circle view. Then "Has anything changed?" | "Same MCP server, different tools. Priya hears that Mum's routine has shifted: Ring saw the front door open at 2 or 3 AM three nights running, her evening doses slipped and her mornings got later. Claude on Bedrock explains it, without diagnosing." |
| 1:50–2:15 | Priya: "I'll drive her to cardiology" → Sam's view updates; Margaret's Echo announces it. Then "Prepare a brief for the cardiology visit" → dashboard brief dialog | "Family tasks get claimed by voice, and the doctor gets a one-page brief." |
| 2:15–2:35 | Dashboard: click **Motion at 2:47 AM** → live alert; Margaret: "I fell in the kitchen" → urgent alert | "Real Ring webhooks, HMAC-verified. Emergencies are caught by rules on the server, not left to the model." |
| 2:35–2:50 | README architecture + `npm run smoke` passing | "MCP 2025-11-25 over Streamable HTTP, MCP Apps, an Agent Skill, Ring, and Claude on Amazon Bedrock. Open source. CareCircle." |

---

## AWS Builder: integration details

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
| Use MCP Apps with an SDK v1 server | Installed latest ext-apps | Works with the current SDK | 2.x needs SDK v2 peers | Low | Pinned ext-apps 1.7.5 | Document the version matrix on the landing page |
| | | | | | | |

## Feature requests

- **Critical:** Proactive notifications from an MCP server to an Echo (spoken reminders and family announcements). Medication reminders depend on it.
- **Important:** Speaker identity passed to MCP servers (who is talking), so role-scoped tools work on shared devices.
- **Nice-to-have:** An official Alexa+ MCP test console that shows tool selection and MCP Apps rendering on an Echo Show frame.

---

## Checklist

- [ ] Run once with `BEDROCK_ENABLED=true` and capture the Claude explanations in the video
- [ ] Record the video (under 3 min, English, public on YouTube or Vimeo, no copyrighted music)
- [ ] Rewrite the feedback and friction log in your own words
- [ ] Devpost: Alexa+ track, AWS Builder and Open Source mini challenges, repo link, video link

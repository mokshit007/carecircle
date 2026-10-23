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
dose early, tells Margaret she doesn't need another, and lets the family know. A quiet-morning wellness check covers
the most worrying case, silence: no voice, no medicine and no check-in by 10:30 means her Echo checks in, and if
she doesn't answer, the family is told.

**Ready for real account linking.** Assistants link with OAuth 2.1 (discovery, dynamic client registration, PKCE,
refresh rotation). The consent page binds each token to one person and role, and tokens are stored only as hashes.
Locked-down mode requires sign-in everywhere. 15 unit tests and an end-to-end test (including the full OAuth flow)
run in GitHub Actions.

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
| 2:10–2:30 | Dashboard: **Motion at 2:47 AM** → live alert. Then **Simulate a quiet morning** → Margaret's Echo shows the check-in, and the family alert lands | "Real Ring webhooks, HMAC-verified. And the scariest case is silence: if Mum hasn't spoken to Alexa by mid-morning, her Echo checks in, and if she doesn't answer, the family knows." |
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
- What, how and why: CareCircle is a new MIT-licensed open-source project: an Alexa+ MCP server that lets one care
  circle (an older adult and their family) share medication reminders, check-ins, family tasks and early-warning
  insights. It runs as a stateless Streamable HTTP MCP server with role-scoped tools, MCP Apps views, OAuth account
  linking and Ring webhooks, with unit tests and CI. It matters because families caring for an older relative have
  had no voice-first, open tool since Alexa Together was retired, and anyone can now self-host or extend this one.

---

## Product feedback

*Drafted from the build log (what actually happened while building). Edit anything that doesn't match your experience.*

**Alexa+ (MCP integration path)**
- *Used for:* the primary target. CareCircle implements MCP 2025-11-25 over Streamable HTTP as the track asks.
- *Worked well:* building on open standards (MCP, MCP Apps, Agent Skills) meant every part could be built and tested
  with existing open tools before preview access.
- *Needs work:* the resources page for Alexa+ links to the generic MCP Apps and transport docs, but nothing
  Alexa+-specific. We couldn't find: how to register an endpoint, which MCP features Alexa+ supports (MCP Apps on
  Echo Show? elicitation? `structuredContent`?), how account linking maps to OAuth, or how speaker identity is passed.
  We had to design for all cases and build our own simulator.
- *Onboarding:* without a preview account or a test console there was no way to see how Alexa+ would choose our tools.
- *Would build again:* yes, especially with a proactive-notification path (see feature requests).

**MCP TypeScript SDK (1.32)**
- *Used for:* the server (`McpServer`, `registerTool`, `registerResource`, `registerPrompt`), stateless
  `StreamableHTTPServerTransport`, the OAuth authorization-server router (`mcpAuthRouter`), and clients in the simulator,
  the stdio bridge and tests.
- *Worked well:* annotations, `_meta` and `structuredContent` on tools; 2025-11-25 negotiated with no configuration;
  stateless mode is a few lines; `mcpAuthRouter` gave discovery, dynamic registration, PKCE and rate limiting for free,
  so a full OAuth flow took one provider class.
- *Needs work:* `createMcpExpressApp` installs `express.json()` for the whole app, so routes that need the raw body
  (HMAC-signed webhooks) can't use it, and we rebuilt the middleware by hand. The localhost Host-header check returns a
  bare 403 with no hint about `allowedHosts`.
- *Would build again:* yes.

**MCP Apps (`@modelcontextprotocol/ext-apps` 1.7.5)**
- *Used for:* the Today and Care-circle views (an app-only tool for "I took it", `updateModelContext`, `ui/message`),
  and the host bridge in our Echo simulator.
- *Worked well:* the `App` class is small and clear; our 1.x views worked unchanged in the 2.x reference host.
- *Needs work:* 2.x requires SDK v2 peers, so v1 servers must pin 1.x, and that isn't stated on the landing page. Views
  must be single self-contained HTML, but the published runtime is an ES module ending in `export {…}`, so we
  rewrote its exports into a global to inline it. A ready-to-inline build would help. The reference host needs Bun,
  can't send auth headers, and needs CORS on the server; none of this is in its README.
- *Would build again:* yes. It's the best way we found to give a voice tool a real screen.

**Ring Partner API**
- *Used for:* webhook v1.1 payloads (`motion_detected`, `button_press`), `X-Signature` HMAC verification over the raw
  body, and `meta.request_id` de-duplication.
- *Worked well:* the payload examples are concrete and the retry/idempotency rules are clearly stated.
- *Needs work:* the reference is one very long page, and the payload schema sits deep inside it. There's no sandbox,
  simulated device or "send test webhook" button for developers without hardware.
- *Would build again:* yes, for caretaking signals like night-time door activity.

**Claude on Amazon Bedrock (and AWS generally)**
- *Used for:* the agent loop over MCP-discovered tools, routine-drift explanations, the digest, the visit brief and
  pill-label reading, all via `@anthropic-ai/bedrock-sdk`.
- *Needs work:* we didn't have an AWS account, and the hackathon's AWS credit codes had run out (7 October update), so
  this path was implemented but couldn't be run. Every AI feature has a deterministic fallback for that reason.
- *Would build again:* yes, with credits.

## Friction log

| Task | Steps | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|
| Find Alexa+-specific MCP guidance | Read the hackathon resources page; followed the Alexa+ links | How to register an endpoint, supported features, auth | Links go to generic MCP Apps and transport docs only | High | Built to the open specs, plus our own Echo Show simulator acting as an MCP Apps host | One Alexa+ page: endpoint registration, supported MCP features, OAuth/account-linking mapping, speaker identity |
| Use Claude on Bedrock | Planned AWS Builder integration; checked credits | Hackathon credits for Bedrock | Credit codes ran out on 7 October; no AWS account | High | Implemented the Bedrock path plus deterministic fallbacks; demoed AI through the Claude desktop app | Reserve credits per team, or provide a shared sandbox model endpoint |
| Verify signed Ring webhooks without a device | Read API docs; looked for a sandbox or test sender | A way to send signed test events | None documented | Medium | Wrote a signer that sends real v1.1 payloads to our own endpoint | A "send test webhook" button in the Developer Portal |
| Read the raw body for HMAC with `createMcpExpressApp` | Used the SDK's Express helper | Add a raw-body route | The helper applies `express.json()` globally first | Medium | Assembled the middleware by hand (host validation + JSON) | An option to skip or scope the JSON parser |
| Run the MCP Apps reference host | Cloned ext-apps; `npm run start` in examples/basic-host | Host starts | `serve` needs Bun; no auth headers; server needs CORS | Medium | `npx vite build`, `node serve.ts`, added CORS, chose the person by env var | Document a Node path; allow headers per server |
| Inline the MCP Apps runtime in a self-contained view | Used `app-with-deps` | A drop-in script | ES module ending in `export {…}` | Low | Rewrote the exports into a global at build time | Publish a ready-to-inline (IIFE) build |
| Use ext-apps with an SDK v1 server | Installed latest ext-apps | Works with the current SDK | 2.x needs SDK v2 peers | Low | Pinned ext-apps 1.7.5 | Version matrix on the landing page |
| Add an MCP server to the Claude desktop app by editing its config | Edited `claude_desktop_config.json` while the app ran | Change is kept | The app rewrote the file and dropped it | Low | Installer script that refuses to run while the app is open | Reload config on change, or warn in the file |

## Feature requests

- **Critical:** Proactive notifications from an MCP server to an Echo (spoken reminders, check-ins, family announcements). Medication reminders and wellness checks depend on it.
- **Important:** Speaker identity (voice ID) passed to MCP servers, so role-scoped tools work on shared devices.
- **Important:** An Alexa+ MCP test console showing tool selection, spoken output and MCP Apps rendering on an Echo Show frame.
- **Nice-to-have:** A Ring developer sandbox with simulated devices and a "send test webhook" button.

---

## Checklist

- [ ] Quit Claude, run `npm run install-claude`, reopen Claude and check the CareCircle connectors appear
- [ ] (Optional) AWS account + Bedrock → `BEDROCK_ENABLED=true`, then add the AWS Builder mini challenge
- [ ] Record the video (under 3 min, English, public on YouTube or Vimeo, no copyrighted music)
- [ ] Rewrite the feedback and friction log in your own words
- [ ] Devpost: Alexa+ track, AWS Builder and Open Source mini challenges, repo link, video link

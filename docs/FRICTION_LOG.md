# CareCircle: friction log

Recorded while building CareCircle (Alexa+ track) during the Amazon Developer Hackathon, October 2026.
Severity: **High** blocked or reshaped the plan · **Medium** cost real time · **Low** minor.

## 1. No Alexa+-specific MCP guidance (High)
- **Task:** Find out how to connect an MCP server to Alexa+ and which MCP features it supports.
- **Steps:** Read the hackathon resources page; followed the Alexa+ links ("Build with Agent Skills", "Streamable HTTP transport").
- **Expected:** How to register an endpoint, which MCP features Alexa+ supports (MCP Apps on Echo Show, elicitation, `structuredContent`), how account linking maps to OAuth, and whether speaker identity is passed.
- **Actual:** The links go to the generic MCP Apps and MCP transport docs. Nothing was Alexa+-specific.
- **Workaround:** Built strictly to the open specs (MCP 2025-11-25, MCP Apps 2026-01-26, OAuth 2.1) and wrote our own Echo Show simulator that acts as an MCP Apps host.
- **Suggestion:** One Alexa+ developer page covering endpoint registration, supported MCP features, account-linking/OAuth mapping and speaker identity, plus a test console.

## 2. AWS credits unavailable (High)
- **Task:** Use Claude on Amazon Bedrock for the agent, routine-change explanations, digest and pill-label reading.
- **Steps:** Implemented the Bedrock integration; looked for hackathon credits.
- **Expected:** Credits to run Bedrock during the hackathon.
- **Actual:** The credit codes had run out (7 October update) and we had no AWS account, so the Bedrock path couldn't be run.
- **Workaround:** Kept the Bedrock code but gave every AI feature a deterministic fallback; showed real AI through the Claude desktop app via a stdio bridge.
- **Suggestion:** Reserve credits per registered team, or offer a shared sandbox model endpoint.

## 3. No way to send test Ring webhooks without a device (Medium)
- **Task:** Verify our Ring webhook receiver (v1.1 payload, `X-Signature` HMAC).
- **Steps:** Read the Partner API reference; looked for a sandbox, simulated device or "send test webhook" option.
- **Expected:** A way to trigger signed test events.
- **Actual:** None documented; the payload schema is deep inside a very long single page.
- **Workaround:** Wrote a signer that builds real v1.1 payloads and posts them, signed, to our own endpoint.
- **Suggestion:** A "send test webhook" button in the Developer Portal and a simulated device for developers without hardware.

## 4. `createMcpExpressApp` blocks raw-body routes (Medium)
- **Task:** Add an HMAC-verified webhook route next to the MCP endpoint.
- **Steps:** Used the SDK's `createMcpExpressApp` helper.
- **Expected:** Able to add a route that reads the raw request body.
- **Actual:** The helper applies `express.json()` to the whole app, so the raw bytes are gone before our route runs.
- **Workaround:** Assembled the middleware by hand (host-header validation + JSON parsing) after the webhook route.
- **Suggestion:** An option to skip or scope the JSON parser.

## 5. Running the MCP Apps reference host (Medium)
- **Task:** Test our views in the official `basic-host`.
- **Steps:** Cloned ext-apps; `npm run start` in `examples/basic-host`.
- **Expected:** The host starts and connects to our server.
- **Actual:** `serve` requires Bun; the host can't send auth headers; a browser host needs CORS on `/mcp`. None of this is in its README.
- **Workaround:** Built with `npx vite build`, ran `node serve.ts`, added CORS, and chose the person through an environment variable.
- **Suggestion:** Document a Node-only path and allow custom headers per server.

## 6. Inlining the MCP Apps runtime (Low)
- **Task:** Ship self-contained HTML views (no external scripts, as the sandbox CSP requires).
- **Steps:** Used `@modelcontextprotocol/ext-apps/app-with-deps`.
- **Expected:** A drop-in script for an inline `<script>`.
- **Actual:** It's an ES module ending in `export {…}`.
- **Workaround:** Rewrote the exports into a global at load time.
- **Suggestion:** Publish a ready-to-inline (IIFE) build.

## 7. ext-apps 2.x needs SDK v2 (Low)
- **Task:** Add MCP Apps to a server on MCP SDK 1.32.
- **Steps:** Installed the latest ext-apps.
- **Expected:** Works with the current stable SDK.
- **Actual:** 2.x requires SDK v2 peer packages.
- **Workaround:** Pinned ext-apps 1.7.5; its views still worked in the 2.x reference host.
- **Suggestion:** A version matrix on the MCP Apps landing page.

## 8. Claude desktop config overwritten while the app runs (Low)
- **Task:** Add CareCircle as an MCP server in the Claude desktop app.
- **Steps:** Edited `claude_desktop_config.json` while the app was open.
- **Expected:** The change is kept.
- **Actual:** The app rewrote the file from memory and dropped the entry.
- **Workaround:** An installer script (`npm run install-claude`) that refuses to run while the app is open.
- **Suggestion:** Reload the config when it changes, or warn inside the file.

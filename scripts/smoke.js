// End-to-end check against a running server: node scripts/smoke.js [http://127.0.0.1:3000]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] || 'http://127.0.0.1:3000';
const UI_EXT = { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } };
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? '  ✓' : '  ✗'} ${label}`); if (!ok) failures++; };

async function connect(token) {
  const client = new Client({ name: 'carecircle-smoke', version: '2.0.0' }, { capabilities: { extensions: UI_EXT } });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, transport };
}

const say = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  console.log(`\n> ${name} ${JSON.stringify(args)}\n  ${result.content[0].text}`);
  return result;
};

// --- Care recipient ---
console.log('\n=== Margaret (care recipient) ===');
const m = await connect('margaret-echo-demo');
check(m.transport.protocolVersion === '2025-11-25', `protocol ${m.transport.protocolVersion}`);
const mTools = (await m.client.listTools()).tools;
console.log(`Tools (${mTools.length}): ${mTools.map((t) => t.name).join(', ')}`);
check(mTools.some((t) => t.name === 'log_dose') && !mTools.some((t) => t.name === 'claim_task'), 'recipient toolset is role-scoped');
const today = mTools.find((t) => t.name === 'get_today_schedule');
check(today?._meta?.ui?.resourceUri === 'ui://carecircle/today.html', 'get_today_schedule declares an MCP Apps view');
check(mTools.find((t) => t.name === 'confirm_dose_from_screen')?._meta?.ui?.visibility?.join() === 'app', 'app-only tool is marked visibility ["app"]');

const sched = await say(m.client, 'get_today_schedule');
check(Array.isArray(sched.structuredContent?.slots), 'structuredContent carries the schedule');
await say(m.client, 'log_dose', { medication: 'my blood sugar pill' });
await say(m.client, 'log_dose', { medication: 'metformin' });
await say(m.client, 'check_missed_doses');
const fall = await say(m.client, 'log_wellbeing', { note: 'I fell in the bathroom', mood: 2 });
check(fall.structuredContent?.urgent === true, 'fall is flagged urgent');
await say(m.client, 'message_family', { message: 'Can someone bring milk?', to: 'Sam' });

const view = await m.client.readResource({ uri: 'ui://carecircle/today.html' });
check(view.contents[0].mimeType === 'text/html;profile=mcp-app', 'UI resource uses the MCP Apps mime type');
check(view.contents[0].text.includes('globalThis.McpApps'), 'UI resource is self-contained (App runtime inlined)');
await m.client.close();

// --- Caregiver ---
console.log('\n=== Priya (caregiver) ===');
const p = await connect('priya-echo-demo');
const pTools = (await p.client.listTools()).tools;
console.log(`Tools (${pTools.length}): ${pTools.map((t) => t.name).join(', ')}`);
check(pTools.some((t) => t.name === 'get_circle_status') && !pTools.some((t) => t.name === 'log_dose'), 'caregiver toolset is role-scoped');
const status = await say(p.client, 'get_circle_status');
check(['watch', 'concern'].includes(status.structuredContent?.drift?.level), `routine drift detected (${status.structuredContent?.drift?.level})`);
await say(p.client, 'get_routine_insights');
await say(p.client, 'list_family_tasks');
const claim = await say(p.client, 'claim_task', { task: 'cardiology' });
check(!claim.isError, 'caregiver can claim the ride task');
await say(p.client, 'message_recipient', { message: "I'll pick you up at ten on Saturday" });
const brief = await say(p.client, 'prepare_visit_brief', {});
check(brief.structuredContent?.brief?.length > 100, 'visit brief generated');
const plan = await p.client.readResource({ uri: 'carecircle://care-plan' });
check(plan.contents[0].text.startsWith('#'), 'care-plan resource readable');
await p.client.close();

// --- Ring webhook ---
console.log('\n=== Ring webhook ===');
const bad = await fetch(`${base}/webhooks/ring`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 'sha256=deadbeef' }, body: '{}' });
check(bad.status === 401, 'unsigned webhook rejected');
const sim = await fetch(`${base}/api/simulate/ring`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'button_press' }) });
check(sim.ok, 'signed Ring v1.1 button_press accepted');

// --- Auth ---
const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
check(unauth.status === 401, 'unknown token rejected with 401');
check(/resource_metadata="[^"]+oauth-protected-resource/.test(unauth.headers.get('www-authenticate') || ''), '401 points clients at OAuth discovery');

// --- OAuth 2.1 account linking, end to end over HTTP ---
console.log('\n=== OAuth account linking ===');
const { createHash, randomBytes } = await import('node:crypto');
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
check(prm.authorization_servers?.length > 0, `protected resource metadata → ${prm.authorization_servers?.[0]}`);
const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
check(asm.code_challenge_methods_supported?.includes('S256'), 'authorization server supports PKCE S256');
const redirectUri = 'http://localhost:9999/callback';
const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Smoke Test Assistant', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }) })).json();
check(Boolean(reg.client_id), 'dynamic client registration');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorizeUrl = new URL(`${base}/authorize`);
Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge,
  code_challenge_method: 'S256', state: 'xyz', resource: `${base.replace('127.0.0.1', 'localhost')}/mcp` }).forEach(([k, v]) => authorizeUrl.searchParams.set(k, v));
const consentHtml = await (await fetch(authorizeUrl)).text();
const requestId = consentHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
check(Boolean(requestId), 'consent page shown');
const consent = await fetch(`${base}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ request_id: requestId, person_id: 'priya', pin: '2222', decision: 'allow' }) });
const location = new URL(consent.headers.get('location'));
check(location.searchParams.get('state') === 'xyz' && location.searchParams.get('code'), 'consent redirects back with code + state');
const tokenRes = await (await fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), code_verifier: verifier,
    redirect_uri: redirectUri, client_id: reg.client_id }) })).json();
check(Boolean(tokenRes.access_token && tokenRes.refresh_token), 'token exchange with PKCE');
const linked = await connect(tokenRes.access_token);
const linkedTools = (await linked.client.listTools()).tools.map((t) => t.name);
check(linkedTools.includes('get_circle_status'), 'linked assistant acts as Priya (caregiver tools)');
await linked.client.close();

console.log(failures ? `\n${failures} check(s) failed.` : '\nSmoke test passed.');
process.exit(failures ? 1 : 0);

// HTTP entry point:
//   /mcp             CareCircle MCP server (Streamable HTTP, protocol 2025-11-25), bound to a person by bearer token
//   OAuth 2.1        /.well-known/*, /register, /authorize, /token, /revoke (account linking, see oauth.js)
//   /webhooks/ring   Ring Partner API webhooks (v1.1, HMAC-verified)
//   /api/*           family dashboard + Echo Show simulator
import path from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { Store } from './store.js';
import { createNotifier } from './notify.js';
import { createCareServer } from './mcp.js';
import { startEscalationEngine, runOnce, wellnessCheck } from './escalation.js';
import { ringWebhookHandler, buildRingPayload, sign } from './ring.js';
import { circleStatus } from './status.js';
import { upcomingAppointments, supplyStatus, now, recordInteraction } from './care.js';
import { converse, appToolCall, resetConversations } from './agent.js';
import { bedrockEnabled, BEDROCK_MODEL, readPillLabel } from './bedrock.js';
import { localParts, addDays, inWindow, parseTime } from './time.js';
import { randomBytes } from 'node:crypto';
import { newId, secretEquals } from './store.js';
import { setupOAuth } from './oauth.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
// Open access is for local demos only. Set ALLOW_ANONYMOUS=false whenever the server is reachable by others.
const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS !== 'false';
// Demo controls (reset, simulated Ring events, choosing who you are in the simulator) default to on only when open.
const DEMO_MODE = process.env.DEMO_MODE ? process.env.DEMO_MODE === 'true' : ALLOW_ANONYMOUS;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SELF = `http://127.0.0.1:${PORT}`;
// The built-in assistant talks to our own /mcp as a person; this per-process secret lets it do so
// without relying on demo tokens (which production turns off).
const INTERNAL_SECRET = randomBytes(24).toString('hex');
const internalToken = (person) => `cc-internal.${person.id}.${INTERNAL_SECRET}`;

const store = new Store();
const notifier = createNotifier(store);
const engine = startEscalationEngine(store, { intervalMs: Number(process.env.ESCALATION_INTERVAL_MS || 15_000) });

const app = express();

// Ring signs the raw bytes, so this route must see the body before any JSON parser.
app.post('/webhooks/ring', express.raw({ type: '*/*', limit: '1mb' }), ringWebhookHandler(store));

// DNS-rebinding protection for local use; explicit allow-list when exposed through a tunnel or domain.
if (ALLOWED_HOSTS?.length) app.use(hostHeaderValidation(ALLOWED_HOSTS));
else if (['127.0.0.1', 'localhost', '::1'].includes(HOST)) app.use(localhostHostValidation());
// Only the label scan carries a photo; everything else stays small.
const smallJson = express.json({ limit: '256kb' });
app.use((req, res, next) => (req.path === '/api/scan-label' ? express.json({ limit: '12mb' })(req, res, next) : smallJson(req, res, next)));
app.use('/oauth', express.urlencoded({ extended: false, limit: '16kb' }));

const { provider: oauth, resourceMetadataUrl } = setupOAuth(app, store, { publicUrl: PUBLIC_URL });

// Resolves the caller from a bearer token: a linked assistant's OAuth token, or a fixed demo token.
// EventSource can't send headers, so the live-updates stream may pass the token as ?access_token=.
async function authenticate(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.path === '/api/events' ? req.query.access_token : null);
  if (!token) return { token: null, person: null };
  if (token.startsWith('cc-internal.')) {
    const [, personId, secret] = token.split('.');
    return { token, person: secretEquals(secret, INTERNAL_SECRET) ? store.person(personId) ?? null : null };
  }
  const demo = store.personByToken(token);
  if (demo) return { token, person: demo };
  try {
    const info = await oauth.verifyAccessToken(token);
    return { token, person: store.person(info.extra.personId) ?? null };
  } catch {
    return { token, person: null };
  }
}

const unauthorized = (res, message = 'Unauthorized') => res.status(401)
  .set('WWW-Authenticate', `Bearer realm="carecircle", resource_metadata="${resourceMetadataUrl}"`)
  .json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

// ---------- MCP ----------

// Browser-based MCP hosts (e.g. the MCP Apps reference host) call /mcp cross-origin.
// Auth is a bearer token, not cookies, so a permissive origin policy is safe here.
app.use('/mcp', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Stateless Streamable HTTP: a fresh server + transport per request, scoped to the caller. Scales
// horizontally (or on AgentCore Runtime / Lambda) without sticky sessions.
app.post('/mcp', async (req, res) => {
  const { token, person: authed } = await authenticate(req);
  if (token && !authed) return unauthorized(res, 'Invalid or expired CareCircle token');
  const person = authed ?? (ALLOW_ANONYMOUS ? store.person(process.env.CARECIRCLE_DEFAULT_PERSON || store.recipient.id) : null);
  if (!person) return unauthorized(res, 'Sign in to CareCircle to use this server');
  const server = createCareServer(store, person);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

const methodNotAllowed = (req, res) =>
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

// ---------- Dashboard + simulator API ----------

const publicPerson = ({ token, pin, ...p }) => p;

// Every /api route knows who is calling. Signed-in callers act as themselves; in open demo mode the
// simulator and dashboard may pick a person (that's how one browser plays three family members).
app.use('/api', async (req, res, next) => {
  const { person } = await authenticate(req);
  if (person) req.person = person;
  else if (!ALLOW_ANONYMOUS) return res.status(401).json({ error: 'Sign in with your CareCircle access code.' });
  next();
});
const demoOnly = (req, res, next) => (DEMO_MODE ? next() : res.status(404).json({ error: 'Demo controls are turned off.' }));
const actor = (req, fallback) => req.person ?? (DEMO_MODE ? store.person(req.body?.personId || req.query.as || fallback) : null);
const viewer = (req) => {
  const p = actor(req, store.caregivers[0]?.id);
  return p?.role === 'caregiver' ? p : (DEMO_MODE ? store.caregivers[0] : p);
};

app.get('/api/me', (req, res) => res.json({ person: req.person ? publicPerson(req.person) : null, demo: DEMO_MODE, open: ALLOW_ANONYMOUS }));

function nightActivity(days = 14) {
  const tz = store.circle.timezone;
  const out = [];
  for (let d = days - 1; d >= 0; d--) {
    const { date } = localParts(addDays(new Date(), -d), tz);
    const events = store.ringEvents.filter((e) => e.date === date);
    out.push({
      date,
      night: events.filter((e) => inWindow(e.time, store.circle.nightWindow)).map((e) => e.time),
      day: events.filter((e) => !inWindow(e.time, store.circle.nightWindow)).length,
    });
  }
  return out;
}

app.get('/api/state', async (req, res) => {
  const v = viewer(req);
  const status = await circleStatus(store, v, { useAi: req.query.ai === '1' });
  res.json({
    ...status,
    alerts: store.alerts.slice(0, 30),
    circle: store.circle,
    people: store.people.map(publicPerson),
    medications: store.medications.filter((m) => m.active),
    supply: supplyStatus(store),
    appointments: upcomingAppointments(store, 30),
    wellbeing: store.wellbeing.slice(-12).reverse(),
    nightActivity: nightActivity(14),
    ringDevices: store.ringDevices,
    announcements: store.announcements.slice(-30).reverse(),
    now: now(store),
    assistant: { bedrock: bedrockEnabled(), model: BEDROCK_MODEL, protocolVersion: LATEST_PROTOCOL_VERSION, sns: Boolean(process.env.SNS_TOPIC_ARN) },
  });
});

// Server-sent events: live announcements for a device, and "something changed" pings for dashboards.
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  // A signed-in person only receives their own announcements.
  const personId = req.person?.id ?? req.query.person;
  const send =(event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onAnnouncement = (a) => { if (!personId || a.to === personId) send('announcement', a); };
  let pending;
  const onChanged = () => { clearTimeout(pending); pending = setTimeout(() => send('changed', {}), 250); };
  notifier.bus.on('announcement', onAnnouncement);
  notifier.bus.on('changed', onChanged);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    notifier.bus.off('announcement', onAnnouncement);
    notifier.bus.off('changed', onChanged);
  });
});

app.post('/api/assistant', async (req, res) => {
  const { utterance, conversationId = 'default' } = req.body ?? {};
  const person = actor(req, store.recipient.id);
  if (!person || !utterance?.trim()) return res.status(400).json({ error: 'A signed-in person and an utterance are required' });
  try {
    res.json(await converse({ mcpUrl: `${SELF}/mcp`, person, token: internalToken(person), conversationId, utterance: utterance.trim().slice(0, 1000), recipientName: store.recipient.name }));
  } catch (err) {
    console.error('Assistant failed:', err);
    res.status(502).json({ reply: "Sorry, I'm having trouble right now. Please try again in a moment.", error: err.message, trace: [] });
  }
});

app.post('/api/app-tool', async (req, res) => {
  const { name, arguments: args = {} } = req.body ?? {};
  const person = actor(req);
  if (!person) return res.status(400).json({ error: 'unknown person' });
  try {
    res.json(await appToolCall({ mcpUrl: `${SELF}/mcp`, person, token: internalToken(person), name, args }));
  } catch (err) {
    res.status(502).json({ content: [{ type: 'text', text: err.message }], isError: true });
  }
});

app.post('/api/announcements/:id/heard', (req, res) => {
  const a = store.announcements.find((x) => x.id === req.params.id);
  if (!a || (req.person && req.person.id !== a.to)) return res.status(404).json({ ok: false });
  a.heard = true;
  // Answering the Echo counts as the recipient being up and about (feeds the wellness check).
  if (a.to === store.recipient.id) recordInteraction(store, a.to);
  store.save();
  res.json({ ok: true });
});

app.post('/api/alerts/:id/ack', (req, res) => {
  if (req.person && req.person.role !== 'caregiver') return res.status(403).end();
  const alert = store.alerts.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).end();
  alert.acknowledged = true;
  alert.acknowledgedBy = req.person?.id;
  store.save();
  res.json(alert);
});

app.post('/api/reset', demoOnly, (req, res) => {
  store.reset();
  resetConversations();
  runOnce(store);
  res.json({ ok: true });
});

// Replays a morning with no sign of the recipient: the Echo check-in goes unanswered and the family is told.
// Skips the real 45-minute wait by back-dating the check-in.
app.post('/api/simulate/quiet-morning', demoOnly, (req, res) => {
  const n = now(store);
  const rid = store.recipient.id;
  store.data.interactions = store.interactions.filter((i) => !(i.date === n.date && i.personId === rid));
  store.data.doseLogs = store.doseLogs.filter((l) => l.date !== n.date);
  store.data.wellbeing = store.wellbeing.filter((w) => w.date !== n.date);
  delete store.data.wellnessState?.[n.date];
  store.alerts.splice(0, store.alerts.length, ...store.alerts.filter((a) => !String(a.key).startsWith(`wellness`)));
  store.save();
  wellnessCheck(store, n, false);
  store.data.wellnessState[n.date].at -= store.circle.wellnessCheck.alertFamilyAfter;
  wellnessCheck(store, n, false);
  res.json({ ok: true });
});

app.post('/api/tick', demoOnly, (req, res) => {
  runOnce(store);
  res.json({ ok: true });
});

// Sends a real, signed Ring v1.1 webhook to our own endpoint, exercising the full production path.
app.post('/api/simulate/ring', demoOnly, async (req, res) => {
  const { type = 'motion_detected', subType = 'human', at } = req.body ?? {};
  const device = store.ringDevices[0];
  let timestamp = Date.now();
  if (at === 'last-night') {
    // 2:47 AM today in the household's timezone (real clock, so the event lands on today's date).
    const real = localParts(new Date(), store.circle.timezone);
    timestamp = Date.now() - ((real.minutes - (2 * 60 + 47)) * 60_000);
  }
  const body = JSON.stringify(buildRingPayload({ deviceId: device.id, type, subType, timestamp }));
  const r = await fetch(`${SELF}/webhooks/ring`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sign(body) }, body,
  });
  res.status(r.status).json({ ok: r.ok, sent: JSON.parse(body) });
});

const caregiverOnly = (req, res, next) => {
  const p = actor(req, store.caregivers[0]?.id);
  return p?.role === 'caregiver' ? next() : res.status(403).json({ error: 'Only family caregivers can change the medication plan.' });
};

app.post('/api/scan-label', caregiverOnly, async (req, res) => {
  if (!bedrockEnabled()) return res.status(503).json({ error: 'Label reading uses Claude on Amazon Bedrock. Set BEDROCK_ENABLED=true.' });
  const match = String(req.body?.image || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Send a PNG, JPEG, WebP or GIF image as a data URL.' });
  try {
    res.json({ label: await readPillLabel(match[2], match[1]) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/medications', caregiverOnly, (req, res) => {
  const { name, dose, times = [], purpose = '', instructions = '', withFood = false, quantity = null, prescriber = '' } = req.body ?? {};
  const addedBy = actor(req, store.caregivers[0]?.id).id;
  const parsed = (Array.isArray(times) ? times : []).map(parseTime).filter(Boolean);
  if (typeof name !== 'string' || typeof dose !== 'string' || !name.trim() || !dose.trim() || !parsed.length) {
    return res.status(400).json({ error: 'name, dose and at least one valid time are required' });
  }
  if (name.length > 80 || dose.length > 40) return res.status(400).json({ error: 'name or dose is too long' });
  const med = {
    id: newId(), name, dose, purpose, times: [...new Set(parsed)].sort(), instructions, withFood, active: true,
    supply: quantity ? { count: Number(quantity), perDose: 1 } : null, prescriber,
  };
  store.medications.push(med);
  store.save();
  const by = store.person(addedBy)?.name ?? 'The family';
  notifier.alertFamily({ type: 'plan_change', topic: 'tasks', exclude: addedBy, message: `${by} added ${name} ${dose} (scanned from the label).` });
  notifier.announce(store.recipient.id, `${by} added ${name} to your medicines.`, 'family');
  res.json(med);
});

app.use(express.static(path.resolve('public')));

app.listen(PORT, HOST, () => {
  console.log(`CareCircle running on http://${HOST}:${PORT}`);
  console.log(`  MCP endpoint (Streamable HTTP, ${LATEST_PROTOCOL_VERSION}): http://${HOST}:${PORT}/mcp`);
  console.log(`  Family dashboard:     http://${HOST}:${PORT}/`);
  console.log(`  Echo Show simulator:  http://${HOST}:${PORT}/echo.html`);
  console.log(`  Ring webhook:         http://${HOST}:${PORT}/webhooks/ring`);
  console.log(`  Claude on Bedrock:    ${bedrockEnabled() ? BEDROCK_MODEL : 'off (offline demo router)'}`);
  console.log(`  OAuth (account link): ${PUBLIC_URL}/.well-known/oauth-authorization-server`);
  console.log(`  Access:               ${ALLOW_ANONYMOUS ? 'OPEN (local demo; set ALLOW_ANONYMOUS=false before exposing)' : 'sign-in required'}${DEMO_MODE ? ', demo controls on' : ''}`);
  if (process.env.DEMO_TOKENS !== 'false') console.log(`  Demo tokens:          ${store.people.map((p) => `${p.name}=${p.token}`).join(', ')}`);
});

export { engine };

// HTTP entry point:
//   /mcp             CareCircle MCP server (Streamable HTTP, protocol 2025-11-25), bound to a person by bearer token
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
import { startEscalationEngine, runOnce } from './escalation.js';
import { ringWebhookHandler, buildRingPayload, sign } from './ring.js';
import { circleStatus } from './status.js';
import { upcomingAppointments, supplyStatus, now } from './care.js';
import { converse, appToolCall, resetConversations } from './agent.js';
import { bedrockEnabled, BEDROCK_MODEL, readPillLabel } from './bedrock.js';
import { localParts, addDays, inWindow, parseTime } from './time.js';
import { newId } from './store.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS !== 'false';
const SELF = `http://127.0.0.1:${PORT}`;

const store = new Store();
const notifier = createNotifier(store);
const engine = startEscalationEngine(store, { intervalMs: Number(process.env.ESCALATION_INTERVAL_MS || 15_000) });

const app = express();

// Ring signs the raw bytes, so this route must see the body before any JSON parser.
app.post('/webhooks/ring', express.raw({ type: '*/*', limit: '1mb' }), ringWebhookHandler(store));

// DNS-rebinding protection for local use; explicit allow-list when exposed through a tunnel or domain.
if (ALLOWED_HOSTS?.length) app.use(hostHeaderValidation(ALLOWED_HOSTS));
else if (['127.0.0.1', 'localhost', '::1'].includes(HOST)) app.use(localhostHostValidation());
app.use(express.json({ limit: '12mb' }));

// ---------- MCP ----------

function personFor(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (token) return store.personByToken(token) ?? null;
  return ALLOW_ANONYMOUS ? store.person(process.env.CARECIRCLE_DEFAULT_PERSON || store.recipient.id) : null;
}

// Stateless Streamable HTTP: a fresh server + transport per request, scoped to the caller. Scales
// horizontally (or on AgentCore Runtime / Lambda) without sticky sessions.
app.post('/mcp', async (req, res) => {
  const person = personFor(req);
  if (!person) {
    return res.status(401).set('WWW-Authenticate', 'Bearer realm="carecircle"')
      .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: unknown or missing CareCircle token' }, id: null });
  }
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

const publicPerson = ({ token, ...p }) => p;
const viewer = (req) => store.person(req.query.as || req.body?.personId || 'priya') ?? store.caregivers[0];

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
  const personId = req.query.person;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
  const { utterance, personId = store.recipient.id, conversationId = 'default' } = req.body ?? {};
  const person = store.person(personId);
  if (!person || !utterance?.trim()) return res.status(400).json({ error: 'personId and utterance are required' });
  try {
    res.json(await converse({ mcpUrl: `${SELF}/mcp`, person, conversationId, utterance: utterance.trim() }));
  } catch (err) {
    console.error('Assistant failed:', err);
    res.status(502).json({ reply: "Sorry, I'm having trouble right now. Please try again in a moment.", error: err.message, trace: [] });
  }
});

app.post('/api/app-tool', async (req, res) => {
  const { personId, name, arguments: args = {} } = req.body ?? {};
  const person = store.person(personId);
  if (!person) return res.status(400).json({ error: 'unknown person' });
  try {
    res.json(await appToolCall({ mcpUrl: `${SELF}/mcp`, person, name, args }));
  } catch (err) {
    res.status(502).json({ content: [{ type: 'text', text: err.message }], isError: true });
  }
});

app.post('/api/announcements/:id/heard', (req, res) => {
  const a = store.announcements.find((x) => x.id === req.params.id);
  if (a) { a.heard = true; store.save(); }
  res.json({ ok: Boolean(a) });
});

app.post('/api/alerts/:id/ack', (req, res) => {
  const alert = store.alerts.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).end();
  alert.acknowledged = true;
  store.save();
  res.json(alert);
});

app.post('/api/reset', (req, res) => {
  store.reset();
  resetConversations();
  runOnce(store);
  res.json({ ok: true });
});

app.post('/api/tick', (req, res) => {
  runOnce(store);
  res.json({ ok: true });
});

// Sends a real, signed Ring v1.1 webhook to our own endpoint, exercising the full production path.
app.post('/api/simulate/ring', async (req, res) => {
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

app.post('/api/scan-label', async (req, res) => {
  if (!bedrockEnabled()) return res.status(503).json({ error: 'Label reading uses Claude on Amazon Bedrock. Set BEDROCK_ENABLED=true.' });
  const match = String(req.body?.image || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Send a PNG, JPEG, WebP or GIF image as a data URL.' });
  try {
    res.json({ label: await readPillLabel(match[2], match[1]) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/medications', (req, res) => {
  const { name, dose, times = [], purpose = '', instructions = '', withFood = false, quantity = null, prescriber = '', addedBy = 'priya' } = req.body ?? {};
  const parsed = times.map(parseTime).filter(Boolean);
  if (!name || !dose || !parsed.length) return res.status(400).json({ error: 'name, dose and at least one valid time are required' });
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
  console.log(`  Demo tokens:          ${store.people.map((p) => `${p.name}=${p.token}`).join(', ')}`);
});

export { engine };

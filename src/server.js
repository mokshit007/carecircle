// HTTP entry point: the MCP endpoint (Streamable HTTP, protocol 2025-11-25), the caregiver dashboard,
// and the simulated Alexa+ voice console.
import path from 'node:path';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { Store } from './store.js';
import { createCareServer } from './mcp.js';
import { todaySchedule, adherence, upcomingAppointments, missedDoses } from './care.js';
import { converse, resetConversation } from './agent.js';
import { bedrockEnabled, BEDROCK_MODEL } from './bedrock.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const allowedHosts = process.env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);

const store = new Store();
const app = createMcpExpressApp({ host: HOST, ...(allowedHosts?.length ? { allowedHosts } : {}) });

function requireToken(req, res, next) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token || req.get('authorization') === `Bearer ${token}`) return next();
  res.status(401).set('WWW-Authenticate', 'Bearer').json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

// Stateless Streamable HTTP: a fresh server + transport per request, so it scales horizontally
// (or on Lambda) without sticky sessions.
app.post('/mcp', requireToken, async (req, res) => {
  const server = createCareServer(store);
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

// ---- Caregiver dashboard API ----
app.get('/api/state', (req, res) => {
  missedDoses(store); // keeps the alert feed current even if nobody asked Alexa
  res.json({
    household: store.household,
    caregivers: store.caregivers,
    today: todaySchedule(store),
    adherence: adherence(store, 7),
    appointments: upcomingAppointments(store, 30),
    wellbeing: store.wellbeing.slice(-10).reverse(),
    alerts: store.alerts.slice(0, 20),
    medications: store.medications.filter((m) => m.active),
    assistant: { bedrock: bedrockEnabled(), model: BEDROCK_MODEL, protocolVersion: LATEST_PROTOCOL_VERSION },
  });
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
  resetConversation(req.body?.conversationId);
  res.json({ ok: true });
});

// ---- Simulated Alexa+ voice console ----
app.post('/api/assistant', async (req, res) => {
  const { utterance, conversationId = 'default' } = req.body ?? {};
  if (!utterance?.trim()) return res.status(400).json({ error: 'utterance is required' });
  try {
    const result = await converse({
      mcpUrl: `http://127.0.0.1:${PORT}/mcp`,
      recipient: store.household.recipient,
      conversationId,
      utterance: utterance.trim(),
    });
    res.json(result);
  } catch (err) {
    console.error('Assistant failed:', err);
    res.status(502).json({ reply: "Sorry, I'm having trouble right now. Please try again in a moment.", error: err.message, trace: [] });
  }
});

app.use(express.static(path.resolve('public')));

app.listen(PORT, HOST, () => {
  console.log(`CareCircle running on http://${HOST}:${PORT}`);
  console.log(`  MCP endpoint (Streamable HTTP, ${LATEST_PROTOCOL_VERSION}): http://${HOST}:${PORT}/mcp`);
  console.log(`  Caregiver dashboard: http://${HOST}:${PORT}/`);
  console.log(`  Alexa+ voice console: http://${HOST}:${PORT}/voice.html`);
  console.log(`  Claude on Bedrock: ${bedrockEnabled() ? BEDROCK_MODEL : 'off (offline demo router)'}`);
});

// Unit tests for CareCircle's care logic. Run with: npm test
// Each test gets its own data file and the household clock is pinned to 1:30 PM UTC.
process.env.CARECIRCLE_CLOCK = '13:30';
process.env.CARECIRCLE_TZ = 'UTC';
delete process.env.BEDROCK_ENABLED;
delete process.env.SNS_TOPIC_ARN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const { Store, secretEquals } = await import('../src/store.js');
const { createNotifier } = await import('../src/notify.js');
const care = await import('../src/care.js');
const { detectDrift } = await import('../src/drift.js');
const { runOnce, wellnessCheck } = await import('../src/escalation.js');
const ring = await import('../src/ring.js');
const { CareCircleAuthProvider } = await import('../src/oauth.js');
const { parseTime, spokenTime, inWindow } = await import('../src/time.js');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carecircle-test-'));
  const store = new Store(path.join(dir, 'data.json'));
  createNotifier(store);
  return store;
}
const today = (store) => care.now(store).date;

test('time helpers parse and speak times', () => {
  assert.equal(parseTime('7pm'), '19:00');
  assert.equal(parseTime('8:30 a.m.'), '08:30');
  assert.equal(parseTime('12am'), '00:00');
  assert.equal(parseTime('25:00'), null);
  assert.equal(spokenTime('19:00'), '7 PM');
  assert.equal(spokenTime('08:05'), '8:05 AM');
  assert.ok(inWindow('23:00', { start: '22:30', end: '07:00' }));
  assert.ok(!inWindow('12:00', { start: '22:30', end: '07:00' }));
});

test('secretEquals compares in constant time and rejects empties', () => {
  assert.ok(secretEquals('abc', 'abc'));
  assert.ok(!secretEquals('abc', 'abd'));
  assert.ok(!secretEquals('', ''));
  assert.ok(!secretEquals(undefined, 'x'));
});

test('logging a dose picks the overdue slot, decrements supply and explains what is next', () => {
  const store = freshStore();
  const metf = store.medications.find((m) => m.id === 'metf');
  const before = metf.supply.count;
  const r = care.logDose(store, { medication: 'my blood sugar pill', by: 'margaret' });
  assert.ok(r.ok, r.message);
  assert.equal(r.entry.time, '08:00');
  assert.equal(metf.supply.count, before - 1);
  assert.match(r.message, /Next up is/);
});

test('double-dose guard refuses a repeat "I took it" and tells the family', () => {
  const store = freshStore();
  care.logDose(store, { medication: 'metformin', by: 'margaret' });
  const again = care.logDose(store, { medication: 'metformin', by: 'margaret' });
  assert.equal(again.ok, false);
  assert.ok(again.possibleDoubleDose);
  assert.match(again.message, /no need to take another/);
  assert.ok(store.alerts.some((a) => a.type === 'possible_double_dose'));
  // The evening dose is still open.
  assert.ok(!store.doseLogs.some((l) => l.medId === 'metf' && l.date === today(store) && l.time === '19:00'));
});

test('an explicit time can still log a dose early', () => {
  const store = freshStore();
  care.logDose(store, { medication: 'metformin', by: 'margaret' });
  const r = care.logDose(store, { medication: 'metformin', slotTime: '7pm', by: 'margaret' });
  assert.ok(r.ok);
  assert.equal(r.entry.time, '19:00');
});

test('unknown medication lists the plan instead of guessing', () => {
  const store = freshStore();
  const r = care.logDose(store, { medication: 'aspirin', by: 'margaret' });
  assert.equal(r.ok, false);
  assert.match(r.message, /Lisinopril/);
});

test('emergency phrases are flagged urgent and alert the family', () => {
  const store = freshStore();
  const { urgent } = care.logWellbeing(store, { note: 'I fell in the bathroom', by: 'margaret' });
  assert.ok(urgent);
  assert.ok(store.alerts.some((a) => a.type === 'urgent_symptom' && a.urgency === 'urgent'));
  assert.ok(store.announcements.some((a) => a.to === 'priya' && a.kind === 'urgent'));
  const calm = care.logWellbeing(store, { note: 'Lovely walk in the park', mood: 4, by: 'margaret' });
  assert.equal(calm.urgent, false);
});

test('routine drift flags the seeded change, and each signal is explainable', () => {
  const store = freshStore();
  const drift = detectDrift(store);
  assert.equal(drift.level, 'concern');
  for (const id of ['night_activity', 'evening_doses', 'dose_delay', 'mood']) assert.ok(drift.flagged.includes(id), id);
  assert.ok(drift.signals.every((s) => s.label && s.baseline !== undefined && s.recent !== undefined && s.source));
});

test('without night-time Ring activity that signal is not flagged', () => {
  const store = freshStore();
  store.data.ringEvents = store.ringEvents.filter((e) => e.time >= '05:00');
  const drift = detectDrift(store);
  assert.ok(!drift.flagged.includes('night_activity'));
});

test('escalation reminds once, alerts the family once, and opens refill and ride tasks', () => {
  const store = freshStore();
  runOnce(store);
  runOnce(store);
  const reminders = store.announcements.filter((a) => a.to === 'margaret' && a.kind === 'reminder');
  assert.equal(reminders.length, 1, 'one reminder for the 8 AM dose, not repeated');
  assert.match(reminders[0].text, /don't have your 8 AM medicine logged/);
  assert.equal(store.alerts.filter((a) => a.type === 'missed_dose').length, 1);
  assert.ok(store.tasks.some((t) => t.type === 'refill' && /Lisinopril/.test(t.title)));
  assert.ok(store.tasks.some((t) => t.type === 'ride'));
  assert.equal(store.tasks.length, 2, 'tasks are not duplicated');
});

test('claiming a ride assigns the driver and tells the recipient', () => {
  const store = freshStore();
  runOnce(store);
  const r = care.claimTask(store, 'cardiology', 'priya');
  assert.ok(r.ok, r.message);
  assert.equal(store.appointments.find((a) => a.needsRide).driverId, 'priya');
  assert.ok(store.announcements.some((a) => a.to === 'margaret' && /Priya will drive you/.test(a.text)));
  assert.equal(care.claimTask(store, 'cardiology', 'sam').ok, false, 'Sam cannot take a claimed task');
});

test('wellness check: silence → Echo check-in → family alert; activity resolves it', () => {
  const store = freshStore();
  const n = care.now(store);
  store.data.interactions = store.interactions.filter((i) => i.date !== n.date);
  store.data.doseLogs = store.doseLogs.filter((l) => l.date !== n.date);
  wellnessCheck(store, n, false);
  assert.ok(store.announcements.some((a) => a.to === 'margaret' && a.kind === 'checkin'));
  wellnessCheck(store, { ...n, minutes: n.minutes + 50 }, false);
  assert.ok(store.alerts.some((a) => a.type === 'no_activity'));
  care.logWellbeing(store, { note: 'Slept in, all fine', mood: 4, by: 'margaret' });
  wellnessCheck(store, { ...n, minutes: n.minutes + 55 }, false);
  assert.ok(store.alerts.some((a) => a.type === 'resolved' && /up and about/.test(a.message)));
});

test('Ring webhooks: signature check, and night motion alerts the family', () => {
  const store = freshStore();
  const body = JSON.stringify({ hello: 'ring' });
  assert.ok(ring.verifySignature(Buffer.from(body), ring.sign(body)));
  assert.ok(!ring.verifySignature(Buffer.from(body), 'sha256=00'));
  assert.ok(!ring.verifySignature(Buffer.from(body + ' '), ring.sign(body)));

  const twoAm = Date.parse(`${today(store)}T02:47:00Z`);
  const payload = ring.buildRingPayload({ deviceId: store.ringDevices[0].id, type: 'motion_detected', subType: 'human', timestamp: twoAm });
  const event = ring.handleRingEvent(store, payload);
  assert.equal(event.time, '02:47');
  assert.ok(store.alerts.some((a) => a.type === 'night_activity'));
});

test('OAuth: code exchange issues tokens bound to the chosen person, refresh rotates', async () => {
  const store = freshStore();
  const provider = new CareCircleAuthProvider(store, { resourceUrl: new URL('http://localhost:3000/mcp') });
  const client = await provider.clientsStore.registerClient({ client_id: 'test-client', redirect_uris: ['http://localhost/cb'] });
  const verifier = 'v'.repeat(50);
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // authorize → consent page
  let html = '';
  await provider.authorize(client, { redirectUri: 'http://localhost/cb', codeChallenge: challenge, state: 's1' }, { type() { return this; }, send(h) { html = h; } });
  const requestId = html.match(/name="request_id" value="([^"]+)"/)[1];

  // wrong PIN is rejected
  let status = 0;
  const res = { status(s) { status = s; return this; }, type() { return this; }, send() {}, redirect(u) { this.location = u; } };
  await provider.consent({ body: { request_id: requestId, person_id: 'priya', pin: '0000', decision: 'allow' } }, res);
  assert.equal(status, 401);

  await provider.consent({ body: { request_id: requestId, person_id: 'priya', pin: '2222', decision: 'allow' } }, res);
  const redirect = new URL(res.location);
  assert.equal(redirect.searchParams.get('state'), 's1');
  const code = redirect.searchParams.get('code');
  assert.equal(await provider.challengeForAuthorizationCode(client, code), challenge);

  const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, 'http://localhost/cb');
  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.extra.personId, 'priya');
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, verifier), /Invalid authorization code/, 'codes are single-use');

  // Only hashes are stored.
  assert.ok(!JSON.stringify(store.data.oauth).includes(tokens.access_token));

  const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token);
  assert.equal((await provider.verifyAccessToken(refreshed.access_token)).extra.personId, 'priya');
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token), /Invalid refresh token/, 'refresh tokens rotate');
});

test('data file survives a reset with linked accounts kept', () => {
  const store = freshStore();
  store.data.oauth.clients.keep = { client_id: 'keep' };
  store.reset();
  assert.ok(store.data.oauth.clients.keep);
  const reread = new Store(store.file);
  assert.equal(reread.data.version, store.data.version);
});

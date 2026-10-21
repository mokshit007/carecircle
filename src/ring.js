// Ring Partner API webhook receiver (payload v1.1). Verifies the X-Signature HMAC over the raw body,
// de-duplicates on meta.request_id, and turns front-door events into care signals:
//   button_press during the day   -> "someone's at the door" on the recipient's Echo
//   motion/press in the night window -> family alert + input to routine-drift detection
import crypto from 'node:crypto';
import { newId } from './store.js';
import { localParts, householdNow, inWindow, spokenTime } from './time.js';

const SECRET = () => process.env.RING_WEBHOOK_SECRET || 'carecircle-demo-ring-secret';

export function sign(rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET()).update(rawBody).digest('hex');
}

export function verifySignature(rawBody, header) {
  if (!header) return false;
  const expected = Buffer.from(sign(rawBody));
  const given = Buffer.from(String(header));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Express handler; mount with express.raw() so the body is the exact bytes Ring signed.
export function ringWebhookHandler(store) {
  const seen = new Set();
  return (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!verifySignature(raw, req.get('x-signature'))) return res.status(401).json({ error: 'invalid signature' });
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid JSON' }); }

    const requestId = payload?.meta?.request_id;
    if (requestId && (seen.has(requestId) || store.ringEvents.some((e) => e.requestId === requestId))) {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (requestId) seen.add(requestId);
    // Ring expects a 2xx within 5 seconds; acknowledge first, process after.
    res.status(200).json({ ok: true });
    setImmediate(() => {
      try { handleRingEvent(store, payload); } catch (err) { console.error('Ring event failed:', err); }
    });
  };
}

export function handleRingEvent(store, payload) {
  const data = payload?.data;
  if (!data || !['motion_detected', 'button_press'].includes(data.type)) return null;
  const attrs = data.attributes || {};
  const device = store.ringDevices.find((d) => d.id === attrs.source) || { id: attrs.source, name: 'Ring device' };
  const when = new Date(attrs.timestamp || Date.now());
  // Live events use the household clock (which a demo may pin); historical ones use their own timestamp.
  const live = Math.abs(Date.now() - when.getTime()) < 120_000;
  const { date, time } = live ? householdNow(store.circle.timezone) : localParts(when, store.circle.timezone);

  const event = {
    id: newId(), requestId: payload.meta?.request_id, deviceId: device.id, deviceName: device.name,
    type: data.type, subType: attrs.sub_type || null, date, time, source: 'ring-webhook',
  };
  store.ringEvents.push(event);
  store.save();

  const recipient = store.recipient;
  const night = inWindow(time, store.circle.nightWindow);
  if (night) {
    store.notify.alertFamily({
      type: 'night_activity', urgency: 'attention', topic: 'urgent', key: `ring-night:${date}:${time.slice(0, 4)}`,
      message: `${device.name} ${data.type === 'button_press' ? 'doorbell was pressed' : 'camera saw movement'} at ${spokenTime(time)}. ` +
        `It's the middle of the night. You may want to check on ${recipient.name}.`,
    });
  } else if (data.type === 'button_press') {
    store.notify.announce(recipient.id, `Someone is at the ${device.name.toLowerCase()}.`, 'doorbell');
  }
  return event;
}

// Builds a payload exactly as Ring would send it (used by the simulator and tests).
export function buildRingPayload({ deviceId, type = 'motion_detected', subType = 'human', timestamp = Date.now() }) {
  return {
    meta: { version: '1.1', time: new Date().toISOString(), request_id: crypto.randomUUID(), account_id: 'ava1.ring.account.CARECIRCLEDEMO' },
    data: {
      id: `${deviceId}_${type === 'button_press' ? 'button_press' : subType || 'motion'}_${timestamp}`,
      type,
      attributes: {
        source: deviceId, source_type: 'devices', timestamp,
        ...(type === 'motion_detected' ? { sub_type: subType } : {}),
      },
      relationships: { devices: { links: { self: `/v1/devices/${deviceId}` } } },
    },
  };
}

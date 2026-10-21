// JSON-file store for one care circle. Small and transparent on purpose; swap for DynamoDB in production.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { localParts, householdNow, toMinutes, fromMinutes, addDays } from './time.js';

const DATA_FILE = process.env.CARECIRCLE_DATA || path.resolve('data', 'carecircle.json');
const SCHEMA_VERSION = 3;

export const newId = () => randomUUID().slice(0, 8);
export const sha256 = (value) => createHash('sha256').update(String(value)).digest();

// Constant-time comparison of secrets (tokens, PINs), so response timing can't leak them.
export function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return timingSafeEqual(sha256(a), sha256(b));
}

export class Store {
  constructor(file = DATA_FILE) {
    this.file = file;
    this.listeners = new Set();
    let existing = null;
    try {
      existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    } catch (err) {
      // A damaged file is kept for inspection rather than silently overwritten.
      const damaged = `${file}.damaged-${Date.now()}`;
      fs.renameSync(file, damaged);
      console.error(`Data file was unreadable (${err.message}); moved to ${damaged} and starting fresh.`);
    }
    this.data = existing?.version === SCHEMA_VERSION ? existing : seedDemo();
    this.data.oauth ??= { clients: {}, tokens: {} };
    if (this.data !== existing) this.save();
  }

  // Write to a temp file, then rename over the original, so a crash mid-write never leaves a half-written file.
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) fn();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Resets the demo story but keeps linked accounts, so connected assistants stay connected.
  reset() {
    const oauth = this.data.oauth;
    this.data = seedDemo();
    this.data.oauth = oauth ?? { clients: {}, tokens: {} };
    this.save();
  }

  get circle() { return this.data.circle; }
  get people() { return this.data.people; }
  get medications() { return this.data.medications; }
  get doseLogs() { return this.data.doseLogs; }
  get wellbeing() { return this.data.wellbeing; }
  get appointments() { return this.data.appointments; }
  get alerts() { return this.data.alerts; }
  get tasks() { return this.data.tasks; }
  get announcements() { return this.data.announcements; }
  get ringEvents() { return this.data.ringEvents; }
  get ringDevices() { return this.data.ringDevices; }
  get interactions() { return this.data.interactions; }
  get reminderState() { return this.data.reminderState; }

  get recipient() { return this.people.find((p) => p.role === 'recipient'); }
  get caregivers() { return this.people.filter((p) => p.role === 'caregiver'); }
  person(id) { return this.people.find((p) => p.id === id); }
  // Fixed per-person tokens are for the demo simulator and local tools; real devices link with OAuth.
  personByToken(token) {
    if (process.env.DEMO_TOKENS === 'false') return null;
    return this.people.find((p) => secretEquals(p.token, token)) ?? null;
  }
}

// Deterministic PRNG so the demo history is identical on every reset.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A two-week story: a steady routine for ten days, then three nights of front-door activity in the
// small hours, slipping evening doses, later mornings and lower mood — the kind of drift families miss.
export function seedDemo() {
  const tz = process.env.CARECIRCLE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const rand = rng(42);
  const now = new Date();
  const today = householdNow(tz);
  const dayAgo = (d) => localParts(addDays(now, -d), tz).date;
  const jitter = (base, spread) => Math.round(base + (rand() - 0.5) * 2 * spread);

  const people = [
    // `pin` is the demo PIN each person enters when linking an assistant to CareCircle (OAuth consent page).
    { id: 'margaret', name: 'Margaret', role: 'recipient', device: 'Kitchen Echo Show', token: 'margaret-echo-demo', pin: '1111' },
    { id: 'priya', name: 'Priya', role: 'caregiver', relation: 'daughter', device: "Priya's Echo Show", token: 'priya-echo-demo', pin: '2222',
      phone: '', email: '', notify: ['urgent', 'escalation', 'drift', 'tasks', 'messages', 'wellness'] },
    { id: 'sam', name: 'Sam', role: 'caregiver', relation: 'grandson', device: "Sam's Echo Dot", token: 'sam-echo-demo', pin: '3333',
      phone: '', email: '', notify: ['urgent', 'tasks', 'messages', 'wellness'] },
  ];

  const medications = [
    { id: 'lisin', name: 'Lisinopril', dose: '10 mg', purpose: 'blood pressure', times: ['08:00'], instructions: '', withFood: false, active: true,
      supply: { count: 5, perDose: 1 }, prescriber: 'Dr. Alvarez' },
    { id: 'metf', name: 'Metformin', dose: '500 mg', purpose: 'blood sugar', times: ['08:00', '19:00'], instructions: 'Take with a meal', withFood: true, active: true,
      supply: { count: 46, perDose: 1 }, prescriber: 'Dr. Okafor' },
    { id: 'vitd', name: 'Vitamin D', dose: '1000 IU', purpose: 'bone health', times: ['12:00'], instructions: '', withFood: false, active: true,
      supply: { count: 60, perDose: 1 }, prescriber: '' },
    { id: 'ator', name: 'Atorvastatin', dose: '20 mg', purpose: 'cholesterol', times: ['21:00'], instructions: 'At bedtime', withFood: false, active: true,
      supply: { count: 24, perDose: 1 }, prescriber: 'Dr. Alvarez' },
  ];

  const doseLogs = [];
  const wellbeing = [];
  const interactions = [];
  const ringEvents = [];
  const FRONT = 'ava1.ring.device.FRONTDOOR01';
  const ringDevices = [
    { id: FRONT, name: 'Front Door', kind: 'doorbell', location: 'front door' },
  ];

  const ring = (date, minutes, type, subType) => ringEvents.push({
    id: newId(), requestId: newId(), deviceId: FRONT, deviceName: 'Front Door', type, subType,
    date, time: fromMinutes(minutes), source: 'seed',
  });

  for (let d = 13; d >= 1; d--) {
    const date = dayAgo(d);
    const drifting = d <= 3;
    const wake = drifting ? jitter(8 * 60 + 50, 25) : jitter(7 * 60 + 10, 15);
    interactions.push({ date, time: fromMinutes(wake), personId: 'margaret', kind: 'first' });

    for (const med of medications) {
      for (const time of med.times) {
        const evening = toMinutes(time) >= 17 * 60;
        const missed = drifting
          ? (med.id === 'metf' && evening && d !== 2) || (med.id === 'ator' && d === 1)
          : (med.id === 'vitd' && d === 9) || (med.id === 'metf' && evening && d === 6);
        if (missed) continue;
        const delay = drifting ? jitter(70, 25) : Math.abs(jitter(8, 10));
        const logged = Math.max(toMinutes(time), wake) + delay;
        doseLogs.push({ id: newId(), medId: med.id, date, time, status: 'taken',
          loggedAt: `${date}T${fromMinutes(Math.min(logged, 23 * 60 + 50))}`, source: 'voice', by: 'margaret' });
      }
    }

    const moods = drifting ? [2, 3, 2] : [4, 3, 4, 4, 3, 4, 5, 4, 3, 4];
    const notes = drifting
      ? ['Felt a bit muddled this afternoon.', "Couldn't get back to sleep, wandered about.", 'Tired. Did not feel like cooking.']
      : ['Walked to the mailbox and back.', 'Did the crossword.', 'Sam came by for lunch.', 'Knee a little sore.',
        'Watered the roses.', 'Choir practice, lovely.', 'Quiet day, read my book.', 'Phoned my sister.',
        'Bit tired after shopping.', 'Baked scones.'];
    wellbeing.push({
      id: newId(), at: `${date}T${fromMinutes(wake + 120)}`, date, mood: moods[d % moods.length], by: 'margaret',
      symptoms: drifting ? (d === 3 ? ['trouble sleeping'] : d === 2 ? ['trouble sleeping', 'forgetfulness'] : ['tiredness']) : d === 8 ? ['knee pain'] : [],
      note: notes[d % notes.length], urgent: false,
    });

    // Daytime front-door life: the mail carrier, and Sam's Sunday visits.
    ring(date, jitter(11 * 60 + 20, 30), 'motion_detected', 'human');
    if (d === 7 || d === 14) ring(date, 12 * 60 + 30, 'button_press', null);
    // The drift signal: front-door motion between midnight and 5 AM.
    if (drifting) ring(date, [0, 2 * 60 + 41, 3 * 60 + 12, 1 * 60 + 55][d], 'motion_detected', 'human');
  }

  // Today: morning doses taken late, except the morning Metformin, which is still outstanding.
  interactions.push({ date: today.date, time: '08:55', personId: 'margaret', kind: 'first' });
  for (const med of medications) {
    for (const time of med.times) {
      if (toMinutes(time) > today.minutes - 60 || (med.id === 'metf' && time === '08:00')) continue;
      doseLogs.push({ id: newId(), medId: med.id, date: today.date, time, status: 'taken',
        loggedAt: `${today.date}T${fromMinutes(Math.min(toMinutes(time) + 75, today.minutes))}`, source: 'voice', by: 'margaret' });
    }
  }

  const appt = (days, time, title, location, extra = {}) => ({
    id: newId(), title, date: dayAgo(-days), time, location, notes: '', needsRide: false, driverId: null, ...extra,
  });

  return {
    version: SCHEMA_VERSION,
    circle: {
      name: "Margaret's Care Circle",
      timezone: tz,
      missedGraceMinutes: 60,
      escalation: { secondReminderAfter: 30, alertFamilyAfter: 60 },
      quietHours: { start: '22:30', end: '07:00' },
      nightWindow: { start: '00:00', end: '05:00' },
      refillWarningDays: 7,
      // If the recipient hasn't interacted at all by this time, check in on the Echo; tell the family if still silent.
      wellnessCheck: { by: '10:30', alertFamilyAfter: 45 },
    },
    people,
    medications,
    doseLogs,
    wellbeing,
    interactions,
    appointments: [
      appt(2, '10:30', 'Cardiology check-up with Dr. Alvarez', 'Riverside Clinic, 2nd floor',
        { notes: 'Bring blood pressure log', needsRide: true }),
      appt(9, '14:00', 'Eye exam', 'Main Street Optometry'),
    ],
    tasks: [],
    alerts: [],
    announcements: [],
    ringDevices,
    ringEvents,
    reminderState: {},
    wellnessState: {},
    oauth: { clients: {}, tokens: {} },
  };
}

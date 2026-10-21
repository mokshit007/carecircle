// Domain logic shared by the MCP tools and the caregiver dashboard API.
import { newId } from './store.js';
import { localParts, householdNow, toMinutes, addDays, spokenTime, parseTime, daysBetween } from './time.js';

const DUE_WINDOW_BEFORE = 30; // minutes before a slot when it counts as "due now"

// Phrases that should never be handled as a routine journal entry.
const URGENT_PATTERNS = [
  /chest pain/, /can'?t breathe/, /short(ness)? of breath/, /trouble breathing/, /\bfell\b/, /\bfall(en)?\b/,
  /faint(ed)?/, /pass(ed)? out/, /stroke/, /numb/, /slurr/, /confus/, /bleeding/, /unconscious/, /overdose/,
  /took (too many|double|extra)/,
];

export function now(store) {
  return householdNow(store.household.timezone);
}

const EARLY_LIMIT = 120; // minutes ahead of schedule a dose can be logged without a warning

export function findMedication(store, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;
  const active = store.medications.filter((m) => m.active);
  return (
    active.find((m) => m.name.toLowerCase() === q) ||
    active.find((m) => q.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(q)) ||
    // Speech recognition mangles drug names; fall back to a shared 4-letter prefix.
    active.find((m) => q.length >= 4 && m.name.toLowerCase().startsWith(q.slice(0, 4))) ||
    null
  );
}

function slotStatus(log, slotMinutes, nowMinutes, grace) {
  if (log) return log.status;
  if (nowMinutes > slotMinutes + grace) return 'missed';
  if (nowMinutes >= slotMinutes - DUE_WINDOW_BEFORE) return 'due';
  return 'upcoming';
}

export function scheduleFor(store, date, nowMinutes = Infinity) {
  const grace = store.household.missedGraceMinutes;
  const slots = [];
  for (const med of store.medications.filter((m) => m.active)) {
    for (const time of med.times) {
      const log = store.doseLogs.find((l) => l.medId === med.id && l.date === date && l.time === time);
      slots.push({
        medId: med.id, medication: med.name, dose: med.dose, time, spokenTime: spokenTime(time),
        withFood: med.withFood, instructions: med.instructions,
        status: slotStatus(log, toMinutes(time), nowMinutes, grace),
        loggedAt: log?.loggedAt ?? null,
      });
    }
  }
  return slots.sort((a, b) => a.time.localeCompare(b.time) || a.medication.localeCompare(b.medication));
}

export function todaySchedule(store) {
  const n = now(store);
  return { date: n.date, weekday: n.weekday, now: n.time, slots: scheduleFor(store, n.date, n.minutes) };
}

export function logDose(store, { medication, status = 'taken', slotTime }) {
  const med = findMedication(store, medication);
  if (!med) {
    const names = store.medications.filter((m) => m.active).map((m) => m.name).join(', ');
    return { ok: false, message: `I couldn't find a medication called "${medication}". The current list is: ${names}.` };
  }
  const n = now(store);
  const open = med.times.filter(
    (t) => !store.doseLogs.some((l) => l.medId === med.id && l.date === n.date && l.time === t),
  );

  let time = parseTime(slotTime);
  if (time && !med.times.includes(time)) {
    // Snap a spoken time ("around seven") to the closest scheduled slot.
    time = med.times.reduce((best, t) =>
      Math.abs(toMinutes(t) - toMinutes(time)) < Math.abs(toMinutes(best) - toMinutes(time)) ? t : best);
  }
  if (!time) {
    if (open.length === 0) {
      return { ok: false, alreadyLogged: true, message: `All of today's ${med.name} doses are already logged. No need to take another.` };
    }
    // Pick the open slot closest to now.
    time = open.reduce((best, t) =>
      Math.abs(toMinutes(t) - n.minutes) < Math.abs(toMinutes(best) - n.minutes) ? t : best);
  } else if (!open.includes(time)) {
    return { ok: false, alreadyLogged: true, message: `The ${spokenTime(time)} ${med.name} dose was already logged today.` };
  }
  const early = toMinutes(time) - n.minutes > EARLY_LIMIT;

  const entry = { id: newId(), medId: med.id, date: n.date, time, status, loggedAt: `${n.date}T${n.time}`, source: 'voice', early };
  store.doseLogs.push(entry);
  store.save();
  if (early && status === 'taken') {
    store.addAlert({
      type: 'early_dose', urgency: 'info',
      message: `${store.household.recipient} logged the ${spokenTime(time)} ${med.name} early, at ${spokenTime(n.time)}.`,
    });
  }

  const remaining = scheduleFor(store, n.date, n.minutes).filter((s) => s.status === 'upcoming' || s.status === 'due');
  const next = remaining[0];
  const verb = status === 'taken' ? 'Logged' : 'Noted that you skipped';
  return {
    ok: true,
    entry: { ...entry, medication: med.name, dose: med.dose },
    message: `${verb} your ${spokenTime(time)} ${med.name}, ${med.dose}.` +
      (early && status === 'taken' ? ` That's earlier than usual, so I've let the family know.` : '') +
      (next ? ` Next up is ${next.medication} at ${next.spokenTime}.` : ' That was the last dose for today.'),
  };
}

export function missedDoses(store, { notify = true } = {}) {
  const today = todaySchedule(store);
  const missed = today.slots.filter((s) => s.status === 'missed');
  if (missed.length && notify) {
    const already = new Set(store.alerts.filter((a) => a.type === 'missed_dose').map((a) => a.key));
    for (const s of missed) {
      const key = `${today.date}:${s.medId}:${s.time}`;
      if (already.has(key)) continue;
      const alert = store.addAlert({
        type: 'missed_dose', urgency: 'info',
        message: `${store.household.recipient} has not logged the ${s.spokenTime} ${s.medication} (${s.dose}).`,
      });
      alert.key = key;
      store.save();
    }
  }
  return { date: today.date, missed };
}

export function logWellbeing(store, { mood, symptoms = [], note = '' }) {
  const n = now(store);
  const text = `${symptoms.join(' ')} ${note}`.toLowerCase();
  const urgent = URGENT_PATTERNS.some((re) => re.test(text));
  const entry = {
    id: newId(), at: `${n.date}T${n.time}`, date: n.date,
    mood: mood ?? null, symptoms, note, urgent,
  };
  store.wellbeing.push(entry);
  store.save();

  if (urgent) {
    store.addAlert({
      type: 'urgent_symptom', urgency: 'urgent',
      message: `${store.household.recipient} reported: "${[...symptoms, note].filter(Boolean).join('; ')}"`,
    });
  }
  return { entry, urgent };
}

export function addAppointment(store, { title, date, time, location = '', notes = '' }) {
  const appt = { id: newId(), title, date, time: parseTime(time) || time, location, notes };
  store.appointments.push(appt);
  store.save();
  return appt;
}

export function upcomingAppointments(store, days = 14) {
  const n = now(store);
  return store.appointments
    .map((a) => ({ ...a, inDays: daysBetween(n.date, a.date), spokenTime: a.time ? spokenTime(a.time) : '' }))
    .filter((a) => a.inDays >= 0 && a.inDays <= days)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export function adherence(store, days = 7) {
  const tz = store.household.timezone;
  const n = now(store);
  const perDay = [];
  for (let d = days - 1; d >= 0; d--) {
    const { date } = localParts(addDays(new Date(), -d), tz);
    // Today only counts slots whose time has passed, so the morning doesn't look like a failure.
    const slots = scheduleFor(store, date, d === 0 ? n.minutes : Infinity)
      .filter((s) => s.status !== 'upcoming' && s.status !== 'due');
    const taken = slots.filter((s) => s.status === 'taken').length;
    perDay.push({ date, scheduled: slots.length, taken, missed: slots.filter((s) => s.status === 'missed').map((s) => `${s.medication} ${s.spokenTime}`) });
  }
  const scheduled = perDay.reduce((sum, d) => sum + d.scheduled, 0);
  const taken = perDay.reduce((sum, d) => sum + d.taken, 0);
  return { days, scheduled, taken, rate: scheduled ? Math.round((taken / scheduled) * 100) : 100, perDay };
}

export function digestFacts(store, days = 7) {
  const adh = adherence(store, days);
  const since = adh.perDay[0].date;
  const entries = store.wellbeing.filter((w) => w.date >= since);
  const moods = entries.map((w) => w.mood).filter((m) => typeof m === 'number');
  const symptomCounts = {};
  for (const w of entries) for (const s of w.symptoms) symptomCounts[s] = (symptomCounts[s] || 0) + 1;
  const missedByMed = {};
  for (const d of adh.perDay) for (const m of d.missed) {
    const name = m.replace(/ \d.*$/, '');
    missedByMed[name] = (missedByMed[name] || 0) + 1;
  }
  return {
    recipient: store.household.recipient,
    period: `${since} to ${adh.perDay.at(-1).date}`,
    adherenceRate: adh.rate,
    dosesTaken: adh.taken,
    dosesScheduled: adh.scheduled,
    missedByMedication: missedByMed,
    averageMood: moods.length ? Math.round((moods.reduce((a, b) => a + b, 0) / moods.length) * 10) / 10 : null,
    moodTrend: moods,
    symptoms: symptomCounts,
    journalNotes: entries.map((w) => `${w.date}: ${w.note}`).filter((s) => !s.endsWith(': ')),
    urgentEvents: entries.filter((w) => w.urgent).map((w) => `${w.at}: ${w.note || w.symptoms.join(', ')}`),
    upcomingAppointments: upcomingAppointments(store, 14).map((a) => `${a.title} in ${a.inDays} day(s) at ${a.spokenTime}`),
  };
}

export function templateDigest(f) {
  const lines = [
    `${f.recipient} took ${f.dosesTaken} of ${f.dosesScheduled} scheduled doses (${f.adherenceRate}%) over the last week.`,
  ];
  const missed = Object.entries(f.missedByMedication);
  if (missed.length) lines.push(`Missed doses: ${missed.map(([m, c]) => `${m} ×${c}`).join(', ')}.`);
  if (f.averageMood) lines.push(`Average mood was ${f.averageMood} out of 5.`);
  const sym = Object.keys(f.symptoms);
  if (sym.length) lines.push(`Reported symptoms: ${sym.join(', ')}.`);
  if (f.urgentEvents.length) lines.push(`⚠ ${f.urgentEvents.length} urgent report(s) this week.`);
  if (f.upcomingAppointments.length) lines.push(`Coming up: ${f.upcomingAppointments[0]}.`);
  return lines.join(' ');
}

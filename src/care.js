// Domain logic shared by the MCP tools, the escalation engine and the family dashboard.
import { newId } from './store.js';
import { localParts, householdNow, toMinutes, addDays, spokenTime, parseTime, daysBetween } from './time.js';

const DUE_WINDOW_BEFORE = 30; // minutes before a slot when it counts as "due now"
const EARLY_LIMIT = 120;      // minutes ahead of schedule a dose can be logged without a warning

// Phrases that must never be treated as a routine journal entry. Deterministic on purpose:
// an emergency should not depend on how a language model reads the sentence.
const URGENT_PATTERNS = [
  /chest pain/, /can'?t breathe/, /short(ness)? of breath/, /trouble breathing/, /\bfell\b/, /\bfall(en)?\b/,
  /faint(ed)?/, /pass(ed)? out/, /stroke/, /numb/, /slurr/, /bleeding/, /unconscious/, /overdose/,
  /took (too many|double|extra)/, /can'?t get up/,
];

export const now = (store) => householdNow(store.circle.timezone);

export function recordInteraction(store, personId) {
  if (personId !== store.recipient.id) return;
  const n = now(store);
  if (!store.interactions.some((i) => i.date === n.date && i.personId === personId)) {
    store.interactions.push({ date: n.date, time: n.time, personId, kind: 'first' });
  }
}

export function findMedication(store, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;
  const active = store.medications.filter((m) => m.active);
  return (
    active.find((m) => m.name.toLowerCase() === q) ||
    active.find((m) => q.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(q)) ||
    active.find((m) => m.purpose && q.includes(m.purpose)) || // "my blood pressure pill"
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
  const grace = store.circle.missedGraceMinutes;
  const slots = [];
  for (const med of store.medications.filter((m) => m.active)) {
    for (const time of med.times) {
      const log = store.doseLogs.find((l) => l.medId === med.id && l.date === date && l.time === time);
      slots.push({
        key: `${date}:${med.id}:${time}`,
        medId: med.id, medication: med.name, dose: med.dose, purpose: med.purpose, time, spokenTime: spokenTime(time),
        withFood: med.withFood, instructions: med.instructions,
        status: slotStatus(log, toMinutes(time), nowMinutes, grace),
        minutesLate: log ? null : Math.max(0, nowMinutes - toMinutes(time)),
        loggedAt: log?.loggedAt ?? null,
      });
    }
  }
  return slots.sort((a, b) => a.time.localeCompare(b.time) || a.medication.localeCompare(b.medication));
}

export function todaySchedule(store) {
  const n = now(store);
  const slots = scheduleFor(store, n.date, n.minutes);
  const next = slots.find((s) => s.status === 'due' || s.status === 'upcoming');
  return {
    date: n.date, weekday: n.weekday, now: n.time, recipient: store.recipient.name,
    taken: slots.filter((s) => s.status === 'taken').length,
    total: slots.length,
    overdue: slots.filter((s) => s.status === 'missed').length,
    next: next ? { medication: next.medication, time: next.spokenTime } : null,
    slots,
  };
}

export function logDose(store, { medication, status = 'taken', slotTime, by }) {
  const med = typeof medication === 'object' ? medication : findMedication(store, medication);
  if (!med) {
    const names = store.medications.filter((m) => m.active).map((m) => m.name).join(', ');
    return { ok: false, message: `I couldn't find a medication called "${medication}". The current list is: ${names}.` };
  }
  const n = now(store);
  const open = med.times.filter((t) => !store.doseLogs.some((l) => l.medId === med.id && l.date === n.date && l.time === t));

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
    time = open.reduce((best, t) =>
      Math.abs(toMinutes(t) - n.minutes) < Math.abs(toMinutes(best) - n.minutes) ? t : best);
  } else if (!open.includes(time)) {
    return { ok: false, alreadyLogged: true, message: `The ${spokenTime(time)} ${med.name} dose was already logged today. No need to take another.` };
  }
  const early = toMinutes(time) - n.minutes > EARLY_LIMIT;

  // Double-dose guard: "I took my Metformin" said again soon after logging one is far more likely a repeat
  // (or a memory slip) than the evening dose taken hours early. Only an explicit time logs it.
  if (early && !slotTime && status === 'taken') {
    const recent = store.doseLogs.filter((l) => l.medId === med.id && l.date === n.date && l.status === 'taken')
      .find((l) => n.minutes - toMinutes(l.loggedAt.slice(11, 16)) < 240);
    if (recent) {
      store.notify?.alertFamily({ type: 'possible_double_dose', urgency: 'attention', topic: 'escalation', key: `double:${n.date}:${med.id}:${n.time}`,
        message: `${store.recipient.name} said they took ${med.name} again, ${n.minutes - toMinutes(recent.loggedAt.slice(11, 16))} minutes after logging the ${spokenTime(recent.time)} dose. Nothing was logged; you may want to check in.` });
      return {
        ok: false, possibleDoubleDose: true,
        message: `I already have your ${spokenTime(recent.time)} ${med.name} logged at ${spokenTime(recent.loggedAt.slice(11, 16))}. ` +
          `Your next one isn't until ${spokenTime(time)}, so there's no need to take another now. If you're unsure, your pharmacist can advise.`,
      };
    }
  }

  const entry = { id: newId(), medId: med.id, date: n.date, time, status, loggedAt: `${n.date}T${n.time}`, source: 'voice', by, early };
  store.doseLogs.push(entry);
  if (status === 'taken' && med.supply) med.supply.count = Math.max(0, med.supply.count - (med.supply.perDose || 1));
  recordInteraction(store, by);
  store.save();

  const wasEscalated = store.reminderState[`${n.date}:${med.id}:${time}`]?.stage >= 3;
  if (wasEscalated) {
    store.notify?.alertFamily({ type: 'resolved', urgency: 'info', topic: 'escalation',
      message: `${store.recipient.name} has now taken the ${spokenTime(time)} ${med.name}.` });
  }
  if (early && status === 'taken') {
    store.notify?.alertFamily({ type: 'early_dose', urgency: 'info', topic: 'escalation',
      message: `${store.recipient.name} logged the ${spokenTime(time)} ${med.name} early, at ${spokenTime(n.time)}.` });
  }

  const remaining = scheduleFor(store, n.date, n.minutes).filter((s) => s.status === 'upcoming' || s.status === 'due');
  const next = remaining[0];
  const verb = status === 'taken' ? 'Logged' : 'Noted that you skipped';
  return {
    ok: true,
    entry: { ...entry, medication: med.name, dose: med.dose },
    message: `${verb} your ${spokenTime(time)} ${med.name}, ${med.dose}.` +
      (early && status === 'taken' ? " That's earlier than usual, so I've let the family know." : '') +
      (next ? ` Next up is ${next.medication} at ${next.spokenTime}.` : ' That was the last dose for today.'),
  };
}

export function missedDoses(store) {
  const today = todaySchedule(store);
  return { date: today.date, missed: today.slots.filter((s) => s.status === 'missed') };
}

export function logWellbeing(store, { mood, symptoms = [], note = '', by }) {
  const n = now(store);
  const text = `${symptoms.join(' ')} ${note}`.toLowerCase();
  const urgent = URGENT_PATTERNS.some((re) => re.test(text));
  const entry = { id: newId(), at: `${n.date}T${n.time}`, date: n.date, mood: mood ?? null, symptoms, note, urgent, by };
  store.wellbeing.push(entry);
  recordInteraction(store, by);
  store.save();
  if (urgent) {
    store.notify?.alertFamily({
      type: 'urgent_symptom', urgency: 'urgent', topic: 'urgent',
      message: `${store.recipient.name} reported: "${[...symptoms, note].filter(Boolean).join('; ')}"`,
    });
  }
  return { entry, urgent };
}

export function addAppointment(store, { title, date, time, location = '', notes = '', needsRide = false }) {
  const appt = { id: newId(), title, date, time: parseTime(time) || time || '', location, notes, needsRide, driverId: null };
  store.appointments.push(appt);
  store.save();
  return appt;
}

export function upcomingAppointments(store, days = 14) {
  const n = now(store);
  return store.appointments
    .map((a) => ({
      ...a, inDays: daysBetween(n.date, a.date), spokenTime: a.time ? spokenTime(a.time) : '',
      driver: a.driverId ? store.person(a.driverId)?.name : null,
    }))
    .filter((a) => a.inDays >= 0 && a.inDays <= days)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export function adherence(store, days = 7) {
  const tz = store.circle.timezone;
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

export function supplyStatus(store) {
  return store.medications.filter((m) => m.active && m.supply).map((m) => {
    const perDay = m.times.length * (m.supply.perDose || 1);
    const daysLeft = Math.floor(m.supply.count / perDay);
    return { medId: m.id, medication: m.name, count: m.supply.count, daysLeft, low: daysLeft <= store.circle.refillWarningDays };
  });
}

// ---- Family tasks: refills, rides to appointments, visits ----

export function openTasks(store) {
  return store.tasks.filter((t) => t.status !== 'done')
    .map((t) => ({ ...t, claimedByName: t.claimedBy ? store.person(t.claimedBy)?.name : null }));
}

export function createTask(store, { type, title, ref, dueDate, createdBy = 'carecircle' }) {
  if (ref && store.tasks.some((t) => t.ref === ref && t.status !== 'done')) return null;
  const task = { id: newId(), type, title, ref, dueDate, status: 'open', claimedBy: null, createdBy, createdAt: new Date().toISOString() };
  store.tasks.push(task);
  store.save();
  store.notify?.alertFamily({ type: 'task', urgency: 'info', topic: 'tasks', message: `New family task: ${title}. Who can take it?` });
  return task;
}

export function findTask(store, query) {
  const q = String(query || '').toLowerCase();
  const open = store.tasks.filter((t) => t.status !== 'done');
  return open.find((t) => t.id === query) ||
    open.find((t) => t.title.toLowerCase().includes(q)) ||
    open.find((t) => q.split(/\W+/).filter((w) => w.length > 3).some((w) => t.title.toLowerCase().includes(w))) ||
    null;
}

export function claimTask(store, query, personId) {
  const task = findTask(store, query);
  if (!task) return { ok: false, message: "I couldn't find an open family task like that." };
  const person = store.person(personId);
  if (task.claimedBy && task.claimedBy !== personId) {
    return { ok: false, task, message: `${store.person(task.claimedBy).name} has already taken "${task.title}".` };
  }
  task.status = 'claimed';
  task.claimedBy = personId;
  if (task.type === 'ride') {
    const appt = store.appointments.find((a) => a.id === task.ref);
    if (appt) appt.driverId = personId;
  }
  store.save();
  store.notify?.alertFamily({ type: 'task', urgency: 'info', topic: 'tasks', exclude: personId,
    message: `${person.name} is taking care of: ${task.title}.` });
  if (task.type === 'ride') {
    store.notify?.announce(store.recipient.id, `${person.name} will drive you to your ${task.title.replace(new RegExp(`^Drive ${store.recipient.name} to (the )?`, 'i'), '').replace(/ \(.*\)$/, '')}.`, 'family');
  }
  return { ok: true, task, message: `Thanks, ${person.name}. You're down for "${task.title}". I've let the rest of the family know.` };
}

export function completeTask(store, query, personId) {
  const task = findTask(store, query);
  if (!task) return { ok: false, message: "I couldn't find an open family task like that." };
  task.status = 'done';
  task.completedBy = personId;
  task.completedAt = new Date().toISOString();
  if (task.type === 'refill') {
    const med = store.medications.find((m) => m.id === task.ref?.split(':')[1]);
    if (med?.supply) med.supply.count += 30 * med.times.length;
  }
  store.save();
  store.notify?.alertFamily({ type: 'task', urgency: 'info', topic: 'tasks', exclude: personId,
    message: `${store.person(personId).name} finished: ${task.title}.` });
  return { ok: true, task, message: `Marked "${task.title}" as done.` };
}

// ---- Digest and visit-brief facts (fed to Claude, or to the template fallback) ----

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
    recipient: store.recipient.name,
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
    lowSupply: supplyStatus(store).filter((s) => s.low).map((s) => `${s.medication}: ${s.daysLeft} days left`),
  };
}

export function templateDigest(f) {
  const lines = [`${f.recipient} took ${f.dosesTaken} of ${f.dosesScheduled} scheduled doses (${f.adherenceRate}%) this period.`];
  const missed = Object.entries(f.missedByMedication);
  if (missed.length) lines.push(`Missed: ${missed.map(([m, c]) => `${m} ×${c}`).join(', ')}.`);
  if (f.averageMood) lines.push(`Average mood ${f.averageMood} out of 5.`);
  const sym = Object.keys(f.symptoms);
  if (sym.length) lines.push(`Reported: ${sym.join(', ')}.`);
  if (f.urgentEvents.length) lines.push(`${f.urgentEvents.length} urgent report(s).`);
  if (f.lowSupply?.length) lines.push(`Running low: ${f.lowSupply.join(', ')}.`);
  if (f.upcomingAppointments.length) lines.push(`Coming up: ${f.upcomingAppointments[0]}.`);
  return lines.join(' ');
}

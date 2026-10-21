// The proactive engine. Runs every few seconds and turns the care plan into gentle, escalating action:
//   dose due      -> spoken reminder on the recipient's Echo
//   +30 min       -> second, softer check-in
//   +60 min       -> the family is told (feed, their Echos, SNS)
// It also opens family tasks for low medication supply and appointments that need a ride,
// and raises routine-drift insights once a day.
import { todaySchedule, supplyStatus, createTask, upcomingAppointments, now } from './care.js';
import { detectDrift } from './drift.js';
import { inWindow, spokenTime } from './time.js';

export function startEscalationEngine(store, { intervalMs = 15_000 } = {}) {
  const tick = () => {
    try { runOnce(store); } catch (err) { console.error('Escalation tick failed:', err); }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return { tick, stop: () => clearInterval(timer) };
}

export function runOnce(store) {
  const n = now(store);
  const { escalation, quietHours } = store.circle;
  const recipient = store.recipient;
  const quiet = inWindow(n.time, quietHours);
  const today = todaySchedule(store);

  // Group slots due at the same time so "8 AM" is one reminder, not three.
  const pending = today.slots.filter((s) => s.status === 'due' || s.status === 'missed').filter((s) => s.minutesLate >= 0);
  const byTime = Map.groupBy ? Map.groupBy(pending, (s) => s.time) : groupBy(pending, (s) => s.time);

  for (const [time, slots] of byTime) {
    const late = slots[0].minutesLate;
    const names = slots.map((s) => `${s.medication} ${s.dose}${s.withFood ? ', with food' : ''}`).join(' and ');
    let stage = Math.min(...slots.map((s) => store.reminderState[s.key]?.stage ?? 0));
    const setStage = (value) => {
      for (const s of slots) store.reminderState[s.key] = { stage: value, at: new Date().toISOString() };
      store.save();
      stage = value;
    };

    if (stage < 1 && !quiet) {
      store.notify.announce(recipient.id, `${recipient.name}, it's time for your ${spokenTime(time)} medicine: ${names}. Just tell me when you've taken it.`);
      // If we're already past the second-reminder point (e.g. server just started), don't repeat ourselves.
      setStage(late >= escalation.secondReminderAfter ? 2 : 1);
    }
    if (stage < 2 && late >= escalation.secondReminderAfter && !quiet) {
      store.notify.announce(recipient.id, `Just checking in, ${recipient.name}. Have you had your ${spokenTime(time)} ${slots.map((s) => s.medication).join(' and ')} yet?`);
      setStage(2);
    }
    if (stage < 3 && late >= escalation.alertFamilyAfter) {
      const hours = late >= 120 ? `${Math.floor(late / 60)} hours` : `${late} minutes`;
      store.notify.alertFamily({
        type: 'missed_dose', urgency: 'info', topic: 'escalation', key: `missed:${today.date}:${time}`,
        message: `${recipient.name} hasn't confirmed the ${spokenTime(time)} ${slots.map((s) => s.medication).join(' and ')} (${hours} overdue). Reminders were given on the Echo.`,
      });
      setStage(3);
    }
  }

  // Refills: open a family task when a medication is about to run out.
  for (const s of supplyStatus(store).filter((x) => x.low)) {
    createTask(store, {
      type: 'refill', ref: `refill:${s.medId}`,
      title: `Pick up a refill of ${s.medication} (${s.daysLeft} days left)`,
    });
  }

  // Rides: appointments in the next week that need a driver.
  for (const a of upcomingAppointments(store, 7).filter((x) => x.needsRide && !x.driverId)) {
    createTask(store, {
      type: 'ride', ref: a.id, dueDate: a.date,
      title: `Drive ${recipient.name} to the ${a.title} (${a.inDays === 1 ? 'tomorrow' : `in ${a.inDays} days`}, ${a.spokenTime})`,
    });
  }

  // Routine drift: at most one insight per day, only when the level is worth a family's attention.
  const drift = detectDrift(store);
  if (drift.level !== 'steady') {
    store.notify.alertFamily({
      type: 'drift', urgency: drift.level === 'concern' ? 'attention' : 'info', topic: 'drift', key: `drift:${today.date}`,
      message: drift.summary,
    });
  }
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

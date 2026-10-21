// Routine-drift detection: compares the last few days with the person's own baseline across
// independent signals (medication timing, missed evening doses, Ring front-door activity at night,
// when the day starts, mood, new symptoms). Each signal is simple and explainable on its own;
// together they surface the slow changes families tend to notice too late.
import { localParts, addDays, toMinutes, inWindow, spokenTime, fromMinutes } from './time.js';
import { scheduleFor } from './care.js';

const RECENT_DAYS = 3;
const BASELINE_DAYS = 10;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, p = 1) => (x == null ? null : Math.round(x * 10 ** p) / 10 ** p);

function windows(store) {
  const tz = store.circle.timezone;
  const recent = [];
  const baseline = [];
  // Yesterday backwards; today is still in progress so it would bias every signal.
  for (let d = 1; d <= RECENT_DAYS + BASELINE_DAYS; d++) {
    const { date } = localParts(addDays(new Date(), -d), tz);
    (d <= RECENT_DAYS ? recent : baseline).push(date);
  }
  return { recent, baseline };
}

function perDay(dates, fn) {
  return dates.map(fn).filter((v) => v != null);
}

export function detectDrift(store) {
  const { recent, baseline } = windows(store);
  const night = store.circle.nightWindow;
  const signals = [];

  // 1. Front-door activity in the night window (Ring motion / doorbell).
  const nightEvents = (date) => store.ringEvents.filter((e) => e.date === date && inWindow(e.time, night));
  const nightRecent = recent.map((d) => nightEvents(d).length);
  const nightBase = mean(baseline.map((d) => nightEvents(d).length));
  const nightsWithActivity = nightRecent.filter((c) => c > 0).length;
  const lastNightEvents = recent.flatMap(nightEvents).sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  signals.push({
    id: 'night_activity', label: 'Front-door activity at night', source: 'Ring',
    baseline: `${round(nightBase)} events/night`, recent: `${nightsWithActivity} of last ${RECENT_DAYS} nights`,
    flagged: nightsWithActivity >= 2 && nightBase < 0.3,
    weight: 2,
    detail: lastNightEvents.length
      ? `Ring ${lastNightEvents[0].deviceName} saw motion at ${lastNightEvents.slice(0, 3).map((e) => spokenTime(e.time)).join(', ')}.`
      : 'No night-time front-door events.',
  });

  // 2. Evening doses being missed.
  const eveningMissRate = (dates) => {
    const slots = dates.flatMap((d) => scheduleFor(store, d).filter((s) => toMinutes(s.time) >= 17 * 60));
    return slots.length ? slots.filter((s) => s.status === 'missed').length / slots.length : null;
  };
  const eveRecent = eveningMissRate(recent);
  const eveBase = eveningMissRate(baseline);
  signals.push({
    id: 'evening_doses', label: 'Evening doses missed', source: 'Alexa voice log',
    baseline: `${Math.round((eveBase ?? 0) * 100)}%`, recent: `${Math.round((eveRecent ?? 0) * 100)}%`,
    flagged: eveRecent != null && eveRecent >= 0.4 && eveRecent - (eveBase ?? 0) >= 0.3,
    weight: 2,
    detail: 'Share of doses scheduled after 5 PM that were never confirmed.',
  });

  // 3. Doses confirmed later than scheduled.
  const delay = (dates) => mean(dates.flatMap((d) => store.doseLogs
    .filter((l) => l.date === d && l.status === 'taken')
    .map((l) => toMinutes(l.loggedAt.slice(11, 16)) - toMinutes(l.time))));
  const delRecent = delay(recent);
  const delBase = delay(baseline);
  signals.push({
    id: 'dose_delay', label: 'Doses taken later than usual', source: 'Alexa voice log',
    baseline: `${Math.round(delBase ?? 0)} min late`, recent: `${Math.round(delRecent ?? 0)} min late`,
    flagged: delRecent != null && delBase != null && delRecent - delBase >= 40,
    weight: 1,
    detail: 'Average gap between the scheduled time and the voice confirmation.',
  });

  // 4. When the day starts (first interaction with Alexa).
  const first = (d) => store.interactions.find((i) => i.date === d && i.kind === 'first');
  const wakeRecent = mean(perDay(recent, (d) => first(d) && toMinutes(first(d).time)));
  const wakeBase = mean(perDay(baseline, (d) => first(d) && toMinutes(first(d).time)));
  signals.push({
    id: 'day_start', label: 'Day starting later', source: 'Alexa interactions',
    baseline: wakeBase != null ? spokenTime(fromMinutes(wakeBase)) : 'n/a',
    recent: wakeRecent != null ? spokenTime(fromMinutes(wakeRecent)) : 'n/a',
    flagged: wakeRecent != null && wakeBase != null && wakeRecent - wakeBase >= 60,
    weight: 1,
    detail: 'Time of the first conversation with Alexa each morning.',
  });

  // 5. Mood from voice check-ins.
  const mood = (dates) => mean(store.wellbeing.filter((w) => dates.includes(w.date) && typeof w.mood === 'number').map((w) => w.mood));
  const moodRecent = mood(recent);
  const moodBase = mood(baseline);
  signals.push({
    id: 'mood', label: 'Lower mood', source: 'Voice check-ins',
    baseline: moodBase != null ? `${round(moodBase)}/5` : 'n/a', recent: moodRecent != null ? `${round(moodRecent)}/5` : 'n/a',
    flagged: moodRecent != null && moodBase != null && moodBase - moodRecent >= 1,
    weight: 1,
    detail: 'Self-reported mood, 1 (very low) to 5 (great).',
  });

  // 6. Symptoms that weren't reported before.
  const symptomsIn = (dates) => new Set(store.wellbeing.filter((w) => dates.includes(w.date)).flatMap((w) => w.symptoms));
  const baseSym = symptomsIn(baseline);
  const newSym = [...symptomsIn(recent)].filter((s) => !baseSym.has(s));
  signals.push({
    id: 'new_symptoms', label: 'New symptoms mentioned', source: 'Voice check-ins',
    baseline: [...baseSym].join(', ') || 'none', recent: newSym.join(', ') || 'none',
    flagged: newSym.length > 0,
    weight: 1,
    detail: 'Symptoms mentioned in the last few days that were not in the baseline.',
  });

  const flagged = signals.filter((s) => s.flagged);
  const score = flagged.reduce((sum, s) => sum + s.weight, 0);
  const level = score >= 4 ? 'concern' : score >= 2 ? 'watch' : 'steady';
  return {
    level, score,
    recentDays: recent, baselineDays: baseline,
    flagged: flagged.map((s) => s.id),
    signals,
    summary: templateDriftSummary(store.recipient.name, level, flagged),
  };
}

export function templateDriftSummary(name, level, flagged) {
  if (level === 'steady') return `${name}'s routine looks steady compared with the usual pattern.`;
  const parts = flagged.map((s) => `${s.label.toLowerCase()} (${s.recent}, usually ${s.baseline})`);
  return `${name}'s routine has shifted over the last ${RECENT_DAYS} days: ${parts.join('; ')}. ` +
    (level === 'concern'
      ? `Changes like these together are worth a check-in call today, and worth mentioning to ${name}'s doctor.`
      : 'Worth keeping an eye on.');
}

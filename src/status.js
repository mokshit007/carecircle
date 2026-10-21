// Composite views of the circle, shared by the MCP tools (and their MCP Apps views) and the dashboard.
import { todaySchedule, adherence, openTasks, upcomingAppointments, supplyStatus } from './care.js';
import { detectDrift } from './drift.js';
import { bedrockEnabled, explainDrift } from './bedrock.js';

const narratives = new Map(); // drift fingerprint -> Claude's explanation

export async function driftWithNarrative(store, { useAi = true } = {}) {
  const drift = detectDrift(store);
  if (drift.level === 'steady' || !useAi || !bedrockEnabled()) return { ...drift, narrative: null, narrativeBy: 'template' };
  const fingerprint = `${drift.recentDays[0]}:${drift.flagged.join(',')}`;
  if (!narratives.has(fingerprint)) {
    try {
      const context = {
        recipient: store.recipient.name,
        medications: store.medications.filter((m) => m.active).map((m) => `${m.name} ${m.dose} at ${m.times.join(', ')}`),
        upcomingAppointments: upcomingAppointments(store, 14).map((a) => `${a.title} in ${a.inDays} days`),
        recentJournal: store.wellbeing.filter((w) => drift.recentDays.includes(w.date)).map((w) => `${w.date}: ${w.note} ${w.symptoms.join(', ')}`),
      };
      narratives.set(fingerprint, await explainDrift(drift, context));
    } catch (err) {
      console.warn('Drift narrative failed:', err.message);
      return { ...drift, narrative: null, narrativeBy: 'template' };
    }
  }
  return { ...drift, narrative: narratives.get(fingerprint), narrativeBy: 'claude' };
}

export async function circleStatus(store, viewer, opts) {
  const today = todaySchedule(store);
  const drift = await driftWithNarrative(store, opts);
  const next = upcomingAppointments(store, 30)[0];
  return {
    recipient: store.recipient.name,
    viewer: viewer?.name ?? 'family',
    today,
    adherence: adherence(store, 7),
    drift,
    tasks: openTasks(store),
    alerts: store.alerts.slice(0, 4).map(({ id, at, type, urgency, message }) => ({ id, at, type, urgency, message })),
    supply: supplyStatus(store),
    nextAppointment: next ? `${next.title} (${next.inDays === 0 ? 'today' : next.inDays === 1 ? 'tomorrow' : `in ${next.inDays} days`})` : null,
  };
}

export function spokenCircleSummary(s) {
  const parts = [`${s.recipient} has taken ${s.today.taken} of ${s.today.total} doses today`];
  if (s.today.overdue) parts[0] += `, and ${s.today.overdue} ${s.today.overdue === 1 ? 'is' : 'are'} overdue`;
  parts[0] += '.';
  if (s.drift.level !== 'steady') {
    const flagged = s.drift.signals.filter((x) => x.flagged).map((x) => x.label.toLowerCase());
    parts.push(`I've noticed a change in the routine over the last few days: ${flagged.slice(0, 3).join(', ')}.`);
  } else {
    parts.push('The routine looks steady.');
  }
  const open = s.tasks.filter((t) => !t.claimedBy);
  if (open.length) parts.push(`${open.length} family task${open.length > 1 ? 's need' : ' needs'} someone: ${open.map((t) => t.title.replace(/ \(.*\)$/, '')).join('; ')}.`);
  return parts.join(' ');
}

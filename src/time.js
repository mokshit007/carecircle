// Timezone helpers. All schedule math happens in the household's local time.

export function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const date_ = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  return { date: date_, time, minutes: toMinutes(time), weekday: parts.weekday };
}

// The household's "now". CARECIRCLE_CLOCK=HH:MM pins the time of day, so demos look the same whenever they're recorded.
export function householdNow(timeZone) {
  const parts = localParts(new Date(), timeZone);
  const pinned = process.env.CARECIRCLE_CLOCK;
  if (pinned && /^\d{2}:\d{2}$/.test(pinned)) return { ...parts, time: pinned, minutes: toMinutes(pinned) };
  return parts;
}

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const addDays = (date, n) => new Date(date.getTime() + n * 86_400_000);

export function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

// "19:00" -> "7 PM", "08:30" -> "8:30 AM" — written for text-to-speech.
export function spokenTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Accepts "7pm", "7:30 pm", "19:00", "8" and returns "HH:MM", or null.
export function parseTime(input) {
  if (!input) return null;
  const match = String(input).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2] || 0);
  const mer = match[3]?.[0];
  if (mer === 'p' && h < 12) h += 12;
  if (mer === 'a' && h === 12) h = 0;
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

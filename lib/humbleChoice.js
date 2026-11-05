'use strict';

// Humble Choice's real end date, from Humble's fixed schedule: a month's Choice is sold until the
// first Tuesday of the next month at 10:00 Pacific. ITAD's ran 2 h early on 2026-11-03 and then
// moved it to its expired list (integrations.md).

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const laHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' });

// When month `m` (0-based) of `year`'s Choice stops being sold, in ms.
function choiceEndMs(year, m) {
  const first = new Date(Date.UTC(year, m + 1, 1));
  const day = 1 + ((2 - first.getUTCDay() + 7) % 7); // first Tuesday
  const pdt = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day, 17); // 10:00 UTC-7
  return Number(laHour.format(pdt)) === 10 ? pdt : pdt + 60 * 60 * 1000;
}

// ITAD's purchase link for a Choice month wraps `humblebundle.com/membership/october-2026`.
function choiceMonth(b) {
  if (b?.page?.name !== 'Humble Bundle' || typeof b.url !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(b.url);
  } catch {
    return null;
  }
  const m = /humblebundle\.com\/membership\/([a-z]+)-(\d{4})\b/i.exec(decoded);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return month === -1 ? null : { year: Number(m[2]), month, key: `${MONTHS[month]}-${m[2]}` };
}

// The Choice month on sale at `now`, with when it went on sale (the previous month's end).
function currentChoice(now) {
  const d = new Date(now);
  let [year, month] = [d.getUTCFullYear(), d.getUTCMonth()];
  if (now < choiceEndMs(year, month - 1)) [year, month] = month ? [year, month - 1] : [year - 1, 11];
  return { key: `${MONTHS[month]}-${year}`, startMs: choiceEndMs(year, month - 1) };
}

// Each Humble Choice bundle with Humble's end date instead of ITAD's; others untouched.
function withChoiceEnd(bundles) {
  return bundles.map((b) => {
    const c = choiceMonth(b);
    return c ? { ...b, expiry: new Date(choiceEndMs(c.year, c.month)).toISOString() } : b;
  });
}

module.exports = { choiceEndMs, choiceMonth, currentChoice, withChoiceEnd };

// An ISO timestamp shown as the viewer's local date and time, flat or as a stacked table cell.

import { fmtLocalDate, pad2 } from './utils.ts';

// Local getters, not `toISOString()`: a late-evening local time is the next day in UTC.
// The time shows because rows sort on it: same-day rows would otherwise look arbitrarily ordered.
export function parseIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtDatePart(iso: string | null | undefined): string {
  const d = parseIsoDate(iso);
  return d ? fmtLocalDate(d) : '—';
}

// Empty (not '—') for a missing date — the stacked cell renders no second line at all in that
// case, rather than a second em dash under the first.
export function fmtTimePart(iso: string | null | undefined): string {
  const d = parseIsoDate(iso);
  return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
}

// The flat one-line form, still what the column's own `format` returns — it's the text the table's
// search matches against and the fallback whenever a cell isn't rendered through `render`.
export function fmtDateTime(iso: string | null | undefined): string {
  const time = fmtTimePart(iso);
  return time ? `${fmtDatePart(iso)} ${time}` : fmtDatePart(iso);
}

// Date over a dimmed time, so the column costs only the date's width; `extra` (a countdown) joins the time.
export function renderDateTime(value: unknown, extra?: Node): Node {
  const wrap = document.createElement('div');
  wrap.className = 'datetime';
  const first = document.createElement('span');
  first.textContent = fmtDatePart(value as string | null);
  wrap.appendChild(first);
  const time = fmtTimePart(value as string | null);
  // No second line for a missing date, rather than an em dash under an em dash.
  if (time || extra) {
    const timeEl = document.createElement('span');
    timeEl.className = 'datetime-time';
    timeEl.textContent = time;
    if (extra) timeEl.appendChild(extra);
    wrap.appendChild(timeEl);
  }
  return wrap;
}

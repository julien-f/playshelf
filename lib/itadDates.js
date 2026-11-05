'use strict';

// ITAD's bundle end dates run early, so a better source overrides them (integrations.md#bundles).
// ITAD takes no trackable issues for that: the tally below tells, via an alert, when it agrees again.

const AGREE_MS = 60 * 1000;
// `${source}:${bundleId}` → whether ITAD's expiry matched ours, latest verdict wins.
const verdicts = new Map();

// `bundle` with `source`'s `expiry`; tallied only while on sale, since ITAD won't fix past bundles.
function overrideExpiry(bundle, expiry, source, now = Date.now()) {
  const ours = Date.parse(expiry);
  if (ours > now) verdicts.set(`${source}:${bundle.id}`, Math.abs(Date.parse(bundle.expiry) - ours) < AGREE_MS);
  return { ...bundle, expiry };
}

// `[{ source, agree, seen }]`, for GET /api/metrics' alerts.
function itadDateAgreement() {
  const bySource = new Map();
  for (const [key, agrees] of verdicts) {
    const source = key.slice(0, key.lastIndexOf(':'));
    const s = bySource.get(source) ?? { source, agree: 0, seen: 0 };
    s.seen++;
    if (agrees) s.agree++;
    bySource.set(source, s);
  }
  return [...bySource.values()];
}

// Test-only.
function _reset() {
  verdicts.clear();
}

module.exports = { overrideExpiry, itadDateAgreement, _reset };

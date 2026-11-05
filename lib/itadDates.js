'use strict';

// ITAD's bundle end dates run early (integrations.md#bundles), so a better source overrides them.
// ITAD takes corrections as edits on its site, not as trackable issues: say when it agrees again.

const AGREE_MS = 60 * 1000;
const agreed = new Set();

// `bundle`'s expiry replaced by `expiry` (from `source`); logs once per bundle when ITAD's already matches.
function overrideExpiry(bundle, expiry, source) {
  const itad = Date.parse(bundle.expiry);
  if (Math.abs(itad - Date.parse(expiry)) < AGREE_MS && !agreed.has(bundle.id)) {
    agreed.add(bundle.id);
    console.log(
      `[itad-dates] ITAD's end date for bundle ${bundle.id} (${bundle.title}) matches ${source}'s: its override may be removable`,
    );
  }
  return { ...bundle, expiry };
}

module.exports = { overrideExpiry };

// "Buy on Fanatical": a pick-and-mix basket can only be filled from fanatical.com itself (it's keyed
// to that site's own anonymous id), so the selection rides to its page in the URL and a
// bookmarklet clicks each game's own "Add" button there. See docs/dev/bundles-and-prices.md.

const PARAM = 'scg';

// ITAD's purchase link with `scg=<names>` added to the Fanatical address it wraps (Awin's `ued`),
// every other byte left as is. Inside `ued` it survives both Awin's redirect, which appends its
// tracking after it, and a URL cleaner that skips Awin for `ued`; a fragment on the outer link is
// lost to the latter. A link with no `ued` gets the parameter itself.
export function fanaticalBuyUrl(url: string, names: readonly string[]): string {
  const param = `${PARAM}=${encodeURIComponent(JSON.stringify(names))}`;
  const add = (target: string) => {
    const [base, hash] = target.split('#');
    return `${base}${base.includes('?') ? '&' : '?'}${param}${hash == null ? '' : `#${hash}`}`;
  };
  const ued = /([?&]ued=)([^&#]*)/.exec(url);
  if (!ued) return add(url);
  let target: string;
  try {
    target = decodeURIComponent(ued[2]);
  } catch {
    return add(url);
  }
  return url.slice(0, ued.index) + ued[1] + encodeURIComponent(add(target)) + url.slice(ued.index + ued[0].length);
}

// Runs on fanatical.com as a bookmarklet, so it must stay self-contained: no imports, no outer
// references. The parameters only exist so tests can stand in for the page.
export async function addFanaticalPicks(
  doc: Document = document,
  wait: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
  report: (message: string) => void = (message) => alert(message),
): Promise<void> {
  const match = /[?&#]scg=([^&#]*)/.exec(doc.location.search + doc.location.hash);
  let names: string[] = [];
  try {
    names = match ? JSON.parse(decodeURIComponent(match[1])) : [];
  } catch {
    names = [];
  }
  if (!Array.isArray(names) || !names.length) {
    report('No selection here — open the bundle from steam.isonoe.net with "Buy on Fanatical", then click this again.');
    return;
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const card = (name: string) =>
    Array.from(doc.querySelectorAll('article.PickAndMixCard')).find(
      (c) => norm(c.querySelector('img')?.getAttribute('alt') ?? '') === norm(name),
    );
  const button = (name: string) => card(name)?.querySelector<HTMLButtonElement>('button.select-btn') ?? null;
  const selected = (b: HTMLButtonElement) => b.classList.contains('btn-selected');
  // The cards render before the basket loads, so wait for them, then for the basket to settle.
  for (let i = 0; i < 40 && !doc.querySelector('article.PickAndMixCard'); i++) await wait(250);
  await wait(1500);

  let added = 0;
  let already = 0;
  const missing: string[] = [];
  const soldOut: string[] = [];
  for (const name of names) {
    let b = button(name);
    if (!b) {
      missing.push(name);
      continue;
    }
    // A sold-out card keeps its Add button, but clicking it adds nothing.
    if (/sold out/i.test(card(name)?.textContent ?? '')) {
      soldOut.push(name);
      continue;
    }
    if (selected(b)) {
      already++;
      continue;
    }
    // Clicking a game that was in the basket after all removes it, so check and re-click.
    for (let attempt = 0; attempt < 2 && b && !selected(b); attempt++) {
      b.click();
      for (let i = 0; i < 12 && b && !selected(b); i++) {
        await wait(250);
        b = button(name);
      }
    }
    if (b && selected(b)) added++;
    else missing.push(name);
  }
  report(
    [
      `Added ${added} game${added === 1 ? '' : 's'} to the bundle.`,
      already ? `${already} already in it.` : '',
      soldOut.length ? `Sold out on Fanatical:\n• ${soldOut.join('\n• ')}` : '',
      missing.length ? `Not added — pick these by hand:\n• ${missing.join('\n• ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

export const FANATICAL_BOOKMARKLET = `javascript:${encodeURIComponent(`(${addFanaticalPicks.toString()})()`)}`;

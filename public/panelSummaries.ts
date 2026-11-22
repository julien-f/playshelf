// Each panel card's one-line folded answer, as plain data: no JSX, no signals, so tests cover every case.

import {
  computeSteamdbRating,
  dealRecordTier,
  fmtH,
  fmtLastPlayed,
  fmtPlaytime,
  fmtReleaseDate,
  formatMoney,
  metaOrBasics,
  noStorePage,
  PROTON_TIER_COLORS,
  PROTON_TIER_UNKNOWN,
  scoreColor,
} from './utils.ts';
import { fmtDatePart } from './dateTime.ts';
import { PRICES_UNAVAILABLE } from './priceLoading.ts';
import type { DlcEntry, PanelAchievements, PanelNews, PanelOffers, PanelPrice } from './panelData.ts';
import type { GameOwner } from './accountData.ts';
import type { ReadonlyGame } from './types.ts';

export interface CardSummary {
  kind: 'figure' | 'text';
  state: 'loading' | 'failed' | 'empty' | 'ready';
  fig?: string;
  qualifier?: string; // under the figure; an empty card's reason
  text?: string; // a text card's line; an empty card's reason
  tone?: string; // the figure's (or a failed text's) CSS colour
  bar?: number; // a progress bar under the figure, 0–1
}

type SummaryGame = Pick<ReadonlyGame, 'loading' | 'details' | 'pendingSources' | 'failedSources'>;

const loading = (kind: CardSummary['kind']): CardSummary => ({ kind, state: 'loading' });
const failed = (kind: CardSummary['kind']): CardSummary =>
  kind === 'figure'
    ? { kind, state: 'failed', fig: '⚠', qualifier: "didn't answer", tone: 'var(--warn)' }
    : { kind, state: 'failed', text: "didn't answer", tone: 'var(--warn)' };
const empty = (kind: CardSummary['kind'], reason: string): CardSummary =>
  kind === 'figure' ? { kind, state: 'empty', qualifier: reason } : { kind, state: 'empty', text: reason };

// A details source with no value: still coming, errored, or answered with nothing (null).
function missing(game: SummaryGame, sources: string[], kind: CardSummary['kind']): CardSummary | null {
  if (game.loading || !game.details || sources.some((s) => game.pendingSources?.includes(s))) return loading(kind);
  if (sources.every((s) => game.failedSources?.includes(s))) return failed(kind);
  return null;
}

// Compact count, e.g. 465234 -> "465k", 2100000 -> "2.1m"; from what would round to "1000k", in millions.
export function fmtCompactCount(n: number) {
  if (n >= 999_500) return `${+(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// The tier's badge colour, lightened to read as text on the panel's dark ground.
export function protonTierColor(tier: string) {
  return `color-mix(in srgb, ${PROTON_TIER_COLORS[tier] || PROTON_TIER_UNKNOWN} 60%, var(--text))`;
}

// ProtonDB's tier names are display words already: capitalised, not remapped, so a new tier still shows.
export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const spacedHours = (h: number) => fmtH(h).replace(/h$/, ' h');

const plural = (n: number, word: string) => `${fmtCompactCount(n)} ${word}${n === 1 ? '' : 's'}`;

export function ratingSummary(game: SummaryGame): CardSummary {
  const r = game.details?.rating;
  if (!r) return missing(game, ['rating'], 'figure') ?? empty('figure', 'no rating');
  const rating = Math.round(computeSteamdbRating(r.positive, r.total) ?? 0);
  return {
    kind: 'figure',
    state: 'ready',
    fig: String(rating),
    qualifier: `Weighted · ${plural(r.total, 'review')}`, // the tile is titled "Rating": "Weighted Rating" is cut at 390 px
    tone: scoreColor(rating),
  };
}

// ProtonDB only: the data carries no Deck verification.
export function linuxDeckSummary(game: SummaryGame): CardSummary {
  const pd = game.details?.protondb;
  if (!pd?.tier) return missing(game, ['protondb'], 'figure') ?? empty('figure', 'no reports');
  // A pending tier is ProtonDB's provisional one, too few reports to be confident (extractProtonDb, lib/steam.js).
  const qualifier = [pd.total ? plural(pd.total, 'report') : '', pd.pending ? 'provisional' : '']
    .filter(Boolean)
    .join(' · ');
  return {
    kind: 'figure',
    state: 'ready',
    fig: pd.pending ? `${capitalize(pd.tier)} ?` : capitalize(pd.tier),
    ...(qualifier && { qualifier }),
    tone: protonTierColor(pd.tier),
  };
}

export function toBeatSummary(game: SummaryGame): CardSummary {
  const h = game.details?.hltb;
  if (h?.main)
    return {
      kind: 'figure',
      state: 'ready',
      fig: spacedHours(h.main),
      qualifier: h.completionist ? `main · ${spacedHours(h.completionist)} for 100%` : 'main',
    };
  if (h?.all) return { kind: 'figure', state: 'ready', fig: spacedHours(h.all), qualifier: 'all playstyles' };
  return missing(game, ['hltb'], 'figure') ?? empty('figure', 'no times');
}

// `whose`: the account's label; several players' progress is what any of them unlocked (server.js).
export function achievementsSummary(data: PanelAchievements | undefined, whose: string | null): CardSummary {
  if (data === undefined) return loading('figure');
  if (data === null) return failed('figure');
  if (!data.total) return empty('figure', 'no achievements');
  // With no player, `unlocked` is 0 by construction, not a result.
  if (!data.playerCount) return { kind: 'figure', state: 'ready', fig: String(data.total), qualifier: 'achievements' };
  if (data.private) return { kind: 'figure', state: 'ready', fig: String(data.total), qualifier: 'progress private' };
  const done = data.unlocked / data.total;
  return {
    kind: 'figure',
    state: 'ready',
    fig: `${data.unlocked} / ${data.total}`,
    qualifier: !whose ? 'unlocked' : data.playerCount > 1 ? `${whose} combined` : whose,
    tone: scoreColor(Math.round(done * 100)),
    bar: done,
  };
}

// `price`: the row's price fields or the panel's own lookup (panelPriceFields); `itadOff`: isItadOff().
export function priceSummary(
  price: PanelPrice | undefined,
  offers: PanelOffers | undefined,
  itadOff: boolean,
): CardSummary {
  if (itadOff) return empty('figure', PRICES_UNAVAILABLE);
  if (price === undefined) return loading('figure');
  const sub = offers?.subscriptions?.[0];
  const bundles = offers?.bundles.length ?? 0;
  const deal = price?.bestDealPrice;
  const qualifier = [
    sub ? `in ${sub.name}${sub.leaving ? ` until ${fmtDatePart(sub.leaving)}` : ''}` : '',
    deal != null && price?.bestDealCut ? `-${price.bestDealCut}%` : '',
    bundles ? plural(bundles, 'bundle') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (deal == null) {
    if (sub || bundles) return { kind: 'figure', state: 'ready', fig: '—', qualifier };
    return price === null || price.pricesFailed ? failed('figure') : empty('figure', 'no price');
  }
  const rec = dealRecordTier(deal, price);
  return {
    kind: 'figure',
    state: 'ready',
    fig: formatMoney(deal, price!.priceCurrency) + (rec ? ` ${rec.icon}` : ''),
    ...(qualifier && { qualifier }),
    ...(rec && { tone: rec.color }),
  };
}

// `entries`: the DLC resolved so far; "latest" waits for every one, a partial list could miss it.
export function dlcSummary(game: SummaryGame, entries: readonly DlcEntry[] | null | undefined): CardSummary {
  const ids = game.details?.meta?.dlc;
  if (!ids) return missing(game, ['meta'], 'figure') ?? empty('figure', 'no DLC');
  if (!ids.length) return empty('figure', 'no DLC');
  const ready: CardSummary = { kind: 'figure', state: 'ready', fig: String(ids.length) };
  if (entries?.length !== ids.length) return ready;
  const latest = entries
    .filter((d) => !d.comingSoon && !Number.isNaN(Date.parse(d.releaseDate)))
    .reduce<DlcEntry | null>((a, d) => (a && Date.parse(a.releaseDate) >= Date.parse(d.releaseDate) ? a : d), null);
  return latest ? { ...ready, qualifier: `latest ${fmtReleaseDate(latest.releaseDate)}` } : ready;
}

// `members`: every member's display name, to name who doesn't own it.
export function ownedBySummary(owners: readonly GameOwner[] | undefined, members: readonly string[]): CardSummary {
  if (owners === undefined) return loading('figure');
  if (!owners.length)
    return members.length > 1
      ? { kind: 'figure', state: 'empty', fig: `0 / ${members.length}`, qualifier: 'not owned' }
      : empty('figure', 'not owned');
  if (owners.length === 1)
    return {
      kind: 'figure',
      state: 'ready',
      fig: owners[0].name,
      qualifier: fmtPlaytime(owners[0].minutes) || 'not played',
    };
  const lacking = members.filter((m) => !owners.some((o) => o.name === m));
  return {
    kind: 'figure',
    state: 'ready',
    fig: `${owners.length} / ${members.length}`,
    qualifier: lacking.length ? `not ${lacking.join(', ')}` : 'everyone',
  };
}

// `decode`: turns the store's HTML entities into text (the browser's DOMParser).
export function aboutSummary(game: SummaryGame, decode: (html: string) => string): CardSummary {
  const description = metaOrBasics(game.details)?.description;
  if (description) return { kind: 'text', state: 'ready', text: decode(description).split('\n')[0].trim() };
  return (
    missing(game, ['meta'], 'text') ?? empty('text', noStorePage(game) ? 'Delisted: no description' : 'no description')
  );
}

export function tagsSummary(game: SummaryGame): CardSummary {
  const top = game.details?.tags?.[0];
  const meta = game.details?.meta;
  const items = [...new Set([top, ...(meta?.genres ?? [])].filter((v): v is string => !!v))];
  const line = items.length ? items : (meta?.categories ?? []);
  if (line.length) return { kind: 'text', state: 'ready', text: line.join(' · ') };
  return missing(game, ['tags', 'meta'], 'text') ?? empty('text', 'no tags');
}

// `closest`: the account's closest owned games (a taste profile cached), null without one cached,
// undefined when not asked (no account, on Owned, a tagless game). `account`: its label.
export function similarSummary(
  game: SummaryGame,
  { closest, account }: { closest: readonly string[] | null | undefined; account: string | null },
): CardSummary {
  if (game.loading || !game.details) return loading('text');
  const ready = (text: string): CardSummary => ({ kind: 'text', state: 'ready', text });
  if (closest) return ready(closest.length ? closest.join(', ') : 'No close match in this library');
  if (closest === null && account) return ready(`needs ${account}'s Owned list`);
  const basics = metaOrBasics(game.details);
  // The meta line names the developer: a different publisher is the new information.
  const publisher = basics?.publishers?.find((p) => !basics.developers?.includes(p));
  return ready(publisher ? `More from ${publisher}` : 'More like this on Steam');
}

// No official posts: no card (null).
export function newsSummary(news: PanelNews | undefined): CardSummary | null {
  if (news === undefined) return loading('text');
  if (news === null) return failed('text');
  const [latest] = news;
  return latest ? { kind: 'text', state: 'ready', text: `${fmtLastPlayed(latest.date)} · ${latest.title}` } : null;
}

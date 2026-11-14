// The source-picker/op form shared by HomeRoute.tsx (creating a dynamic list) and ListRoute.tsx
// (editing one's sources in place via updateDynamicList) — see docs/dev/lists-and-accounts.md's
// Combine section. Kept dumb: it only assembles { name, op, sources } and hands them to onSubmit,
// which does the actual create/update and decides what happens next (close, navigate, reload).
import { createSignal, For, Show } from 'solid-js';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import ChevronUp from 'lucide-solid/icons/chevron-up';
import { getRecentAccounts } from './accountsStore.ts';
import { getLists } from './listsStore.ts';
import { describeListRef, createDefaultNaming, formatCombine, OP_DESCRIPTIONS } from './listLabels.ts';
import { OP_LABELS } from './combine.ts';
import type { ListRef, CombineOp } from './types.ts';

export interface SourceOption {
  key: string;
  label: string;
  ref: ListRef;
}

// Wording comes from listLabels.ts, shared with the hero card that later has to name the very
// same op back to the user on the list's own page (ListRoute.tsx) — two hand-maintained copies
// were one edit from disagreeing about what a combine does.
const COMBINE_OPS: { value: CombineOp; label: string }[] = (Object.keys(OP_LABELS) as CombineOp[]).map((op) => ({
  value: op,
  label: `${OP_LABELS[op]} (${OP_DESCRIPTIONS[op]})`,
}));

export function refKey(ref: ListRef): string {
  return [ref.kind, ref.accountId ?? ref.listId ?? ref.bundleId ?? ref.name].filter(Boolean).join(':');
}

// Every source a combine can currently be built from — any recent account's Owned/Wishlist,
// Recently Looked Up, or any existing user list. A bundle arrives only as an existing list's
// source, when editing it (see HomeRoute.tsx's header comment), which is what `keep` is for: a
// list's current sources this enumeration doesn't offer (a bundle, a developer/publisher, a `?u=` account), listed first
// so they stay selectable. `excludeListId` keeps a list being edited from being offered as a
// source for itself.
export function sourceOptions(excludeListId?: string, keep: readonly ListRef[] = []): SourceOption[] {
  const naming = createDefaultNaming();
  const refs: ListRef[] = [
    ...getRecentAccounts().flatMap((acc): ListRef[] => [
      { kind: 'account-owned', accountId: acc.id },
      { kind: 'account-wishlist', accountId: acc.id },
    ]),
    { kind: 'recent-games' },
    { kind: 'game-pass' },
    ...getLists()
      .filter((l) => l.id !== excludeListId)
      .map((list): ListRef => ({ kind: 'user', listId: list.id })),
  ];
  const keys = new Set(refs.map(refKey));
  return [...keep.filter((ref) => !keys.has(refKey(ref))), ...refs].map((ref) => ({
    key: refKey(ref),
    label: describeListRef(ref, naming).label,
    ref,
  }));
}

interface CombineFormProps {
  initialOp?: CombineOp;
  initialSources?: ListRef[];
  excludeListId?: string;
  // Hidden when editing an existing dynamic list's sources — renaming has its own action
  // (HomeRoute's Rename) and updateDynamicList takes no name, so a visible-but-inert field would
  // look editable without doing anything.
  showName?: boolean;
  submitLabel: string;
  onSubmit: (input: { name?: string; op: CombineOp; sources: ListRef[] }) => void;
  onCancel?: () => void;
}

export function CombineForm(props: CombineFormProps) {
  const [name, setName] = createSignal('');
  const [op, setOp] = createSignal<CombineOp>(props.initialOp ?? 'union');
  // Pick order, not options()'s fixed enumeration order — significant for `subtract`, where the
  // first source is the base set the rest are removed from (see combine.ts's subtract).
  const [selected, setSelected] = createSignal<string[]>((props.initialSources ?? []).map(refKey));
  const [error, setError] = createSignal('');

  function showName(): boolean {
    return props.showName ?? true;
  }

  function options(): SourceOption[] {
    return sourceOptions(props.excludeListId, props.initialSources);
  }

  function selectedSources(): ListRef[] {
    const byKey = new Map(options().map((o) => [o.key, o.ref]));
    return selected().flatMap((key) => {
      const ref = byKey.get(key);
      return ref ? [ref] : [];
    });
  }

  // What the list would be called with the name field left empty — the same derivation every
  // surface uses for a saved unnamed list, applied to the not-yet-saved formula on screen.
  function derivedName(): string | null {
    const sources = selectedSources();
    return sources.length >= 2 ? formatCombine(op(), sources, createDefaultNaming()) : null;
  }

  function toggleSource(key: string): void {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function moveSource(index: number, delta: -1 | 1): void {
    setSelected((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function handleSubmit(e: Event): void {
    e.preventDefault();
    setError('');
    const trimmed = name().trim();
    const sources = selectedSources();
    if (sources.length < 2) {
      setError('Pick at least 2 sources.');
      return;
    }
    try {
      props.onSubmit({ name: showName() ? trimmed || undefined : undefined, op: op(), sources });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form class="combine-form" onSubmit={handleSubmit}>
      <Show when={showName()}>
        <input
          type="text"
          placeholder="Combined list name (optional)…"
          aria-label="Combined list name (optional)"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </Show>
      <select
        value={op()}
        aria-label="How to combine the sources"
        onChange={(e) => setOp(e.currentTarget.value as CombineOp)}
      >
        <For each={COMBINE_OPS}>{(o) => <option value={o.value}>{o.label}</option>}</For>
      </select>
      {/* Says what leaving the name empty gets you — otherwise "optional" is invisible until after
          the list is saved. */}
      <Show when={showName() && !name().trim() && derivedName()}>
        {(label) => (
          <p>
            Will be named: <span class="derived-name">{label()}</span>
          </p>
        )}
      </Show>
      {/* Order only affects `subtract` (first source minus the rest — see OP_DESCRIPTIONS), so the
          reorder controls only appear for it; for the other ops pick order is inert. */}
      <Show when={op() === 'subtract' && selected().length > 0}>
        <p>
          {OP_DESCRIPTIONS.subtract[0].toUpperCase()}
          {OP_DESCRIPTIONS.subtract.slice(1)}:
        </p>
        <ol class="combine-sources-ordered">
          <For each={selected()}>
            {(key, i) => {
              const label = () => options().find((o) => o.key === key)?.label ?? key;
              return (
                <li>
                  <span class="combine-source-index">{i() + 1}.</span>
                  <span class="combine-source-label">{label()}</span>
                  <button
                    type="button"
                    disabled={i() === 0}
                    onClick={() => moveSource(i(), -1)}
                    aria-label={`Move ${label()} up`}
                  >
                    <ChevronUp />
                  </button>
                  <button
                    type="button"
                    disabled={i() === selected().length - 1}
                    onClick={() => moveSource(i(), 1)}
                    aria-label={`Move ${label()} down`}
                  >
                    <ChevronDown />
                  </button>
                </li>
              );
            }}
          </For>
        </ol>
      </Show>
      <fieldset class="combine-sources-set">
        <legend>Pick at least 2 sources:</legend>
        <ul class="combine-sources">
          <For each={options()}>
            {(opt) => (
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={selected().includes(opt.key)}
                    onChange={() => toggleSource(opt.key)}
                  />
                  {opt.label}
                </label>
              </li>
            )}
          </For>
        </ul>
      </fieldset>
      {error() && <p class="error">{error()}</p>}
      <div class="combine-form-actions">
        <button type="submit" class="btn btn-primary">
          {props.submitLabel}
        </button>
        <Show when={props.onCancel}>
          {(cancel) => (
            <button type="button" onClick={() => cancel()()}>
              Cancel
            </button>
          )}
        </Show>
      </div>
    </form>
  );
}

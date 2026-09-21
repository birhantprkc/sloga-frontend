/**
 * The READ direction of {@link PauseDisproofVerdict}: which field feeds which
 * public accessor of `Voice`.
 *
 * `state.tsx` holds ONE signal for the whole verdict and derives the two public
 * readers off it, so the alarm and its confidence are written together or not
 * at all. That much is settled. What was NOT settled is the derivation itself —
 * two one-line `createMemo` bodies in a file with no spec, no mutation entry
 * and no import that loads under `node --test`.
 *
 * 🔴 THIS WAS A MEASURED GAP, not a hypothesis. A completion audit swapped
 * those two bodies in place and ran the whole bare gate: `tsc`, `prettier`,
 * `eslint`, the whole suite and both scripts returned exit 0, with zero failing
 * checks. Two same-typed accessors transposed in one keystroke, and nothing
 * could see it.
 *
 * What that swap does TODAY, stated honestly: nothing the user can see. The
 * only runtime consumer of the two readers is `callBanner` — `state.tsx`
 * feeds it both `callPauseDisproved()` and `callPauseDisproofConfirmed()`,
 * and the fold in `mlsCallModePolicy.ts` is `pauseDisproved &&
 * pauseDisproofConfirmed`. A transposition maps `{ value: true, confirmed:
 * false }` to `{ false, true }` and BOTH read `pause: "held"`; `{ false,
 * false }` and `{ true, true }` are fixed points. The banner's pause
 * `<Switch>` hedges "should stay paused" either way, so there is no present
 * false-green to report, and this comment does not claim one.
 *
 * What the module and `pauseVerdict.test.ts` still guarantee is that the two
 * values are NAMED and discriminated BY NAME, so a future consumer that
 * weighs them differently — or a `disproved`-only reader, which is exactly
 * what the wave-1 banner was — cannot be fed a transposed pair. The mutation
 * `pause-verdict-readers-transposed` in `scripts/rtc-mutations.py` stays as
 * that pin.
 *
 * So the derivation lives HERE, in a module a runner can load, where
 * `pauseVerdict.test.ts` asserts it over all four states by name and
 * `scripts/rtc-mutations.py` can re-introduce the swap and demand a red.
 *
 * 🔴 WHAT THIS DOES NOT DO, stated because the opposite claim was written into
 * this slice once and had to be removed from a plan doc and three source files:
 * it does NOT make a transposition a compile error. `disproved` and
 * `disproofConfirmed` are both `() => boolean` and `value` and `confirmed` are
 * both `boolean`, so two same-typed named fields transpose exactly as silently
 * as the two positional parameters they replaced did — measured at the producer
 * (`setPauseDisproved({ value: confirmed, confirmed: true })` compiles) and at
 * every reader alike. There is no type here doing that work, and a comment
 * claiming there is would be the same defect one level up.
 *
 * What stands in its place is `pauseVerdict.test.ts`, which asserts this
 * derivation over all four states, and a `scripts/rtc-mutations.py` entry that
 * re-plants the swap against this file and demands a red. The spec landed with
 * this module; the mutation entry is owned by whoever owns that table, and this
 * comment asserts that it is REQUIRED, not that it is present.
 *
 * 🔴 NO FRAMEWORK IMPORT, deliberately. `state.tsx` keeps the `createMemo`
 * wrapping around these two accessors: a memo's `===` equality is what gives
 * each reader the notification shape the two original separate boolean signals
 * had, so each notifies only when its OWN boolean changes. Moving the memo in
 * here would change when `callBanner()` re-derives the pause clause, and
 * pulling `solid-js` into this module would put it right back out of reach of
 * `node --test`, which is the entire point of the extraction.
 */
import type { PauseDisproofVerdict } from "./publishGateEpisode";

/**
 * The two public readers of `Voice`, under the names `state.tsx` binds them to:
 * `disproved` becomes `callPauseDisproved`, `disproofConfirmed` becomes
 * `callPauseDisproofConfirmed`.
 */
export interface PauseVerdictReaders {
  /** {@link PauseDisproofVerdict.value} — the one-directional alarm. */
  readonly disproved: () => boolean;
  /** {@link PauseDisproofVerdict.confirmed} — how much evidence it rests on. */
  readonly disproofConfirmed: () => boolean;
}

/**
 * Split one verdict accessor into its two field accessors, and nothing else.
 *
 * 🔴 LAZY, per accessor call. `verdict` is not read here, and neither accessor
 * caches: each reads `verdict()` afresh every time it is called. Under Solid
 * that is what makes the read a TRACKED dependency of whatever is calling —
 * `state.tsx` wraps each of these in a `createMemo`, and a value captured at
 * construction time (or memoized in here) would be read once, outside any
 * reactive scope, and never update again. The spec pins both halves.
 */
export function pauseVerdictReaders(
  verdict: () => PauseDisproofVerdict,
): PauseVerdictReaders {
  return {
    disproved: () => verdict().value,
    disproofConfirmed: () => verdict().confirmed,
  };
}

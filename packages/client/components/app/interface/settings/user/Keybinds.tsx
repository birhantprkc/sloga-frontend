import { For, Match, Show, Switch, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import {
  type KeybindArmState,
  keybindArmState,
} from "@revolt/keybinds/armState";
import {
  type BindingConflict,
  type GlobalKeybindAction,
  GLOBAL_KEYBIND_ACTIONS,
  KEYBIND_REQUIREMENT,
  KEYBIND_TIER,
} from "@revolt/keybinds/globalKeybinds";
import { useState } from "@revolt/state";
import {
  CategoryButton,
  ColouredText,
  Column,
  KeyCapture,
  Text,
} from "@revolt/ui";

/* ------------------------------------------------------------------------ *
 * Pure decisions
 *
 * Kept at module scope and exported so they are readable — and, once a lane
 * is allowed to add a file next to them, testable — independently of the
 * markup. They are the only non-trivial logic on this page; everything below
 * is composition.
 * ------------------------------------------------------------------------ */

/**
 * The actions the native hook can fire while Sloga is unfocused, in
 * `GLOBAL_KEYBIND_ACTIONS` order.
 *
 * Derived from `KEYBIND_TIER` rather than listed again. The tier table is the
 * single source of truth for which side of this split an action falls on, and
 * a second hand-written list here would be a copy that silently stops matching
 * it — the failure mode `globalKeybinds.ts` describes for
 * `IN_APP_DEFAULT_SEQUENCES`, without that list's excuse (there is no leaf
 * constraint here; the table is one import away).
 */
export const GLOBAL_TIER_ACTIONS: readonly GlobalKeybindAction[] =
  GLOBAL_KEYBIND_ACTIONS.filter((action) => KEYBIND_TIER[action] === "global");

/** The actions that can only ever be driven by a focused DOM keydown. */
export const IN_APP_TIER_ACTIONS: readonly GlobalKeybindAction[] =
  GLOBAL_KEYBIND_ACTIONS.filter((action) => KEYBIND_TIER[action] === "in-app");

/**
 * What this page is entitled to say about one row.
 *
 * - `"unsupported"` / `"refused"` — the native layer reported that this
 *   action's chord did not arm. Unbindable: the row must say so.
 * - `"probing"` — the capability answer is not in yet. 🔴 Distinct from
 *   `"unavailable"` on purpose: an unanswered probe is not a negative answer,
 *   and it is not a positive one either, so the row makes no claim.
 * - `"unavailable"` — the probe answered, and there is no native hook here.
 *   Nothing in the global tier can fire.
 * - `"armed"` — the id came back in `KeybindsArmResult.armed`. The **only**
 *   positive signal that a binding took, per that type's discharge rule; this
 *   is the one status that earns a "works system-wide" claim.
 * - `"unclaimed"` — no signal in either direction. An unbound row, an
 *   `"in-app"`-tier row (which is never submitted to `keybinds_arm` at all),
 *   or a global row whose last arm did not mention it. The row shows its chord
 *   and promises nothing.
 */
export type KeybindRowStatus =
  | "unsupported"
  | "refused"
  | "probing"
  | "unavailable"
  | "armed"
  | "unclaimed";

/**
 * Decide what one row may claim, from the arm result and the tier.
 *
 * 🔴 **The two refusal lists are checked FIRST, ahead of the tier and probe
 * state.** They are facts about a specific chord that native has already
 * answered on, and they can only be non-empty if native answered at all — so
 * there is no ordering in which a refusal is masked by `"probing"`. They are
 * also not filtered by tier: an `"in-app"` action must never be submitted to
 * `keybinds_arm`, so its id appearing in a result at all is a bug in the
 * arming lane, and swallowing it here would hide that bug behind a row that
 * looks fine.
 *
 * 🔴 **`armed` is the only positive test.** `refused.length === 0 &&
 * unsupported.length === 0` is not evidence of anything — off Windows
 * `keybinds_arm` returns three empty lists and no error, which is
 * indistinguishable from success to a negative check. That is the exact shape
 * of the existing push-to-talk row's lie, which promises "works globally" off
 * `"__TAURI__" in window`.
 */
export function keybindRowStatus(
  action: GlobalKeybindAction,
  arm: KeybindArmState,
): KeybindRowStatus {
  if (arm.unsupported.includes(action)) return "unsupported";
  if (arm.refused.includes(action)) return "refused";

  if (KEYBIND_TIER[action] === "global") {
    if (!arm.probed) return "probing";
    if (!arm.nativeAvailable) return "unavailable";
  }

  if (arm.armed.includes(action)) return "armed";
  return "unclaimed";
}

/**
 * Should the row refuse further capture?
 *
 * 🔴 Only `"unavailable"`. A `"unsupported"` or `"refused"` row is exactly the
 * row the user needs to re-bind — locking it would leave them staring at a
 * chord that cannot work with no way to replace it. And `"probing"` stays open
 * because the store is authoritative regardless of the probe: a chord saved
 * while the answer is in flight arms when it lands.
 */
export function blocksCapture(status: KeybindRowStatus): boolean {
  return status === "unavailable";
}

/* ------------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------------ */

/**
 * Global keybinds settings page.
 *
 * One row per `GLOBAL_KEYBIND_ACTIONS` entry, in that order, split into the
 * two groups `KEYBIND_TIER` defines. The split is the point of the page: a
 * binding the user believes is system-wide and silently is not is worse than
 * one labeled honestly, and the second group says *why* its three actions can
 * never be system-wide instead of reading as a degraded fallback.
 *
 * Nothing is bound by default (`defaultKeybinds()` is twelve `null`s), so the
 * blank state is the normal one, not an error state.
 */
export function KeybindsSettings() {
  const { keybinds } = useState();

  const anyBound = () =>
    GLOBAL_KEYBIND_ACTIONS.some((action) => keybinds.binding(action) !== null);

  return (
    <Column gap="lg">
      <Text class="label">
        <Trans>
          Nothing is bound by default. A global keybind takes its key
          combination away from every other program on this computer while Sloga
          is running, so Sloga ships none of them and you choose the ones you
          want.
        </Trans>
      </Text>

      <GlobalKeybindGroup />
      <InAppKeybindGroup />

      <Show when={anyBound()}>
        <CategoryButton.Group>
          <CategoryButton
            icon="blank"
            description={<Trans>Unbinds every keybind on this page.</Trans>}
            onClick={() => keybinds.resetBindings()}
          >
            <ColouredText colour="var(--md-sys-color-error)">
              <Trans>Clear all keybinds</Trans>
            </ColouredText>
          </CategoryButton>
        </CategoryButton.Group>
      </Show>
    </Column>
  );
}

/**
 * The keybinds that fire while Sloga is unfocused.
 *
 * 🔴 The availability claim is gated on `keybindArmState()`, a real capability
 * probe, and NOT on `"__TAURI__" in window`. The shallow check is what the
 * push-to-talk row in `voice/VoiceProcessingOptions.tsx` uses to promise
 * "Works globally", and the helper's own documentation warns against it: the
 * global half is a Tauri *command* that exists only in the Windows desktop
 * shell, so a Tauri build without it passes `"__TAURI__" in window` and fires
 * nothing.
 *
 * 🔴 An unanswered probe gets its own branch rather than falling into the
 * unavailable copy or the available copy. `probed === false` means "still
 * asking", and flashing either answer before it lands is the same lie in one
 * direction or the other for the width of a frame.
 */
function GlobalKeybindGroup() {
  return (
    <>
      <Text class="title">
        <Trans>Global keybinds</Trans>
      </Text>

      <Text class="label">
        <Trans>
          These fire while Sloga is not the focused app — while you are in a
          game, a browser, or another window.
        </Trans>
      </Text>

      <Switch>
        <Match when={!keybindArmState().probed}>
          <Text class="label">
            <Trans>
              Checking whether this device can register system-wide keys…
            </Trans>
          </Text>
        </Match>
        <Match when={!keybindArmState().nativeAvailable}>
          <ColouredText colour="var(--md-sys-color-error)">
            <Text class="label">
              <Trans>
                This device cannot register system-wide keys, so nothing in this
                group will fire. The Windows desktop app can.
              </Trans>
            </Text>
          </ColouredText>
        </Match>
      </Switch>

      <CategoryButton.Group>
        <For each={GLOBAL_TIER_ACTIONS}>
          {(action) => <KeybindRow action={action} arm={keybindArmState()} />}
        </For>
      </CategoryButton.Group>
    </>
  );
}

/**
 * The keybinds that can only ever fire while Sloga is focused.
 *
 * 🔴 This is not a lesser fallback tier and the copy must not read as one.
 * All three need transient user activation, which a focused keydown grants and
 * a native hook has nothing to offer for — so the limitation is in the
 * browser's activation rules, not in Sloga's shell support, and no amount of
 * native work lifts it. The reasons are stated on the group rather than left
 * implicit, because the push-to-talk row's promise is currently wrong for
 * precisely the opposite omission.
 */
function InAppKeybindGroup() {
  return (
    <>
      <Text class="title">
        <Trans>In-app only</Trans>
      </Text>

      <Text class="label">
        <Trans>
          These fire only while Sloga is focused, and that is not a limitation
          Sloga can lift. Fullscreen, theater mode and starting a screen share
          all need the browser to have seen your keypress itself before it will
          allow them, and a system-wide hook has no keypress to hand over.
          Starting a screen share also always opens the source picker, so an
          unfocused press would send you back to Sloga anyway — and a canceled
          picker fails with nothing shown at all.
        </Trans>
      </Text>

      <CategoryButton.Group>
        <For each={IN_APP_TIER_ACTIONS}>
          {(action) => <KeybindRow action={action} arm={keybindArmState()} />}
        </For>
      </CategoryButton.Group>
    </>
  );
}

/**
 * One action's row.
 *
 * `arm` is taken as a prop rather than read here so the two groups each read
 * `keybindArmState()` once in their own JSX; Solid compiles the attribute to a
 * getter, so the row still tracks it.
 */
function KeybindRow(props: {
  action: GlobalKeybindAction;
  arm: KeybindArmState;
}) {
  const { keybinds, voice } = useState();
  const { t } = useLingui();

  /** The verdict from the last capture, or `null` once retracted. */
  const [conflict, setConflict] = createSignal<BindingConflict | null>(null);
  /** The action this row's chord was taken away from, if any. */
  const [stolenFrom, setStolenFrom] = createSignal<GlobalKeybindAction | null>(
    null,
  );
  /** `setBinding` returned false — it re-validates and can refuse. */
  const [storeRefused, setStoreRefused] = createSignal(false);

  const status = () => keybindRowStatus(props.action, props.arm);
  const binding = () => keybinds.binding(props.action);

  /**
   * 🔴 Push-to-talk IS passed here, deliberately.
   *
   * `findBindingConflict` hard-refuses any chord whose `code` equals it —
   * modifiers not compared, because push-to-talk is matched by a bare
   * `e.code` in `@revolt/rtc/state.tsx` and so `Ctrl+Space` drives it too.
   * That refusal is correct for *these* rows: a keybind must not steal the
   * talk key out from under a held microphone. It is the push-to-talk row's
   * own capture that must pass `undefined`, since a key is not its own
   * conflict.
   *
   * `undefined` while push-to-talk is off, per that function's contract:
   * `voice.pushToTalk === false` leaves the key configured but inert, so
   * there is nothing to collide with.
   */
  const pushToTalkKey = () =>
    voice.pushToTalk ? voice.pushToTalkKey : undefined;

  /**
   * The user-visible name of an action.
   *
   * Takes the action rather than closing over `props.action` so the
   * conflicting-action note can name the *other* row. A `switch` with no
   * `default` and a `string` return type is what makes a thirteenth action a
   * compile error here; a `Record` literal cannot be used because `t` must be
   * called inside a component, under the i18n provider.
   *
   * 🔴 `dismiss-call` is "Dismiss", never "Decline" or "Reject". It sends the
   * caller nothing at all — it stops the local ringtone and clears the local
   * toast — and either of those words would promise the person calling was
   * told something.
   */
  const label = (action: GlobalKeybindAction): string => {
    switch (action) {
      case "toggle-mute":
        return t`Mute and unmute microphone`;
      case "toggle-deafen":
        return t`Deafen and undeafen`;
      case "toggle-camera":
        return t`Turn camera on and off`;
      case "screenshare-stop":
        return t`Stop screen share`;
      case "screenshare-start":
        return t`Start screen share`;
      case "disconnect-call":
        return t`Leave call`;
      case "accept-call":
        return t`Answer incoming call`;
      case "dismiss-call":
        return t`Dismiss incoming call`;
      case "toggle-window":
        return t`Show and hide Sloga`;
      case "toggle-overlay":
        return t`Show and hide the in-game overlay`;
      case "toggle-fullscreen":
        return t`Fullscreen the call`;
      case "toggle-theater":
        return t`Theater mode`;
    }
  };

  /**
   * Accessible name of the capture control.
   *
   * The action name goes through a local `const` so the generated placeholder
   * is named after it rather than positional — the catalog entry a later lane
   * must hand-append is `Keybind for {name}`.
   */
  const captureLabel = () => {
    const name = label(props.action);
    return t`Keybind for ${name}`;
  };

  /**
   * Drop the notes that describe a previous capture's outcome.
   *
   * `KeyCapture` calls `onConflict` before `onChange` on a commit and before
   * `onClear` on a clear, so clearing these from `onConflict` — including on
   * its `null` retraction at the start of every capture — means a stale
   * "taken from" or "could not save" note can never outlive the chord it was
   * about.
   */
  function dropOutcomeNotes() {
    setStolenFrom(null);
    setStoreRefused(false);
  }

  return (
    <CategoryButton
      icon="blank"
      disabled={blocksCapture(status())}
      action={
        <KeyCapture
          value={binding()}
          disabled={blocksCapture(status())}
          pushToTalkKey={pushToTalkKey()}
          copy={{
            label: captureLabel(),
            listening: t`Press a key…`,
            empty: t`Not bound`,
            clear: t`Clear this keybind`,
          }}
          onConflict={(verdict) => {
            dropOutcomeNotes();
            setConflict(verdict);
          }}
          onChange={(candidate) => {
            // 🔴 Read BEFORE the write. `setBinding` resolves a collision by
            // taking the chord — the previous holder is nulled — so asked
            // afterwards there is nothing left to name.
            const held = keybinds.conflictingAction(candidate, props.action);
            const accepted = keybinds.setBinding(props.action, candidate);
            setStolenFrom(accepted ? held : null);
            setStoreRefused(!accepted);
          }}
          onClear={() => {
            dropOutcomeNotes();
            keybinds.clearBinding(props.action);
          }}
        />
      }
      description={
        /* Passed unconditionally, which costs `Content`'s 2px gap under the
           title on the five rows that have nothing to say. The alternative —
           a `hasNotes()` predicate gating the whole block — would be a second
           copy of every condition below, and the failure mode of that copy
           under-reporting is a SUPPRESSED "Unbindable" warning: a row that
           renders as bound and never fires, the one outcome this page exists
           to prevent. 2px is the cheaper side of that trade. */
        <Column gap="sm">
          {/* Facts about the action that the row would otherwise leave the
              user guessing wrong about. */}
          <Switch>
            <Match when={props.action === "dismiss-call"}>
              <Text class="label">
                <Trans>
                  Stops the ringtone and clears the notification on this device.
                  The person calling is not told anything.
                </Trans>
              </Text>
            </Match>
            <Match when={props.action === "screenshare-stop"}>
              <Text class="label">
                <Trans>
                  Stopping works while Sloga is not focused; starting does not,
                  which is why they are separate keybinds.
                </Trans>
              </Text>
            </Match>
            <Match when={props.action === "toggle-theater"}>
              <Text class="label">
                <Trans>
                  Only does anything while the call is already fullscreen.
                </Trans>
              </Text>
            </Match>
          </Switch>

          {/* From KEYBIND_REQUIREMENT, so a row that needs a live call says
              so rather than looking broken when pressed idle. */}
          <Switch>
            <Match when={KEYBIND_REQUIREMENT[props.action] === "room"}>
              <Text class="label">
                <Trans>Does nothing unless you are in a call.</Trans>
              </Text>
            </Match>
            <Match when={KEYBIND_REQUIREMENT[props.action] === "incoming-call"}>
              <Text class="label">
                <Trans>Does nothing unless a call is ringing.</Trans>
              </Text>
            </Match>
          </Switch>

          {/* 🔴 The arm result. A row native would not arm says so instead of
              rendering as bound, which is the obligation
              `KeybindsArmResult` puts on the renderer. */}
          <Switch>
            <Match when={status() === "unsupported"}>
              <ColouredText colour="var(--md-sys-color-error)">
                <Text class="label">
                  <Trans>
                    Unbindable: Sloga cannot register that physical key. Media
                    keys, IME keys and Pause/NumLock are not available. Pick a
                    different key.
                  </Trans>
                </Text>
              </ColouredText>
            </Match>
            <Match when={status() === "refused"}>
              <ColouredText colour="var(--md-sys-color-error)">
                <Text class="label">
                  <Trans>
                    Unbindable: this combination was refused. It is either
                    reserved for a system shortcut, or past the keybind limit.
                    Pick a different key.
                  </Trans>
                </Text>
              </ColouredText>
            </Match>
            <Match when={status() === "armed"}>
              <Text class="label">
                <Trans>Registered system-wide.</Trans>
              </Text>
            </Match>
          </Switch>

          {/* The capture's own verdict. `reserved` and `push-to-talk` are hard
              refusals — nothing was saved. `in-app` is a warning: the chord
              IS saved and both handlers may fire. */}
          <Switch>
            <Match when={conflict()?.kind === "reserved"}>
              <ColouredText colour="var(--md-sys-color-error)">
                <Text class="label">
                  <Trans>
                    Ctrl + Shift + Alt + Q is reserved for the remote-control
                    panic shortcut and cannot be bound.
                  </Trans>
                </Text>
              </ColouredText>
            </Match>
            <Match when={conflict()?.kind === "push-to-talk"}>
              <ColouredText colour="var(--md-sys-color-error)">
                <Text class="label">
                  <Trans>
                    That key is your push-to-talk key. Change push to talk under
                    Voice first, or pick a different key here.
                  </Trans>
                </Text>
              </ColouredText>
            </Match>
            <Match when={conflict()?.kind === "in-app"}>
              <Text class="label">
                <Trans>
                  This is also a Sloga shortcut while the app is focused. It is
                  saved, and both may fire.
                </Trans>
              </Text>
            </Match>
          </Switch>

          {/* The store took the chord off another action. Named in a sibling
              slot rather than interpolated into the sentence: nested JSX
              inside <Trans> is a recorded landmine in this repo. */}
          <Show when={stolenFrom()}>
            {(other) => (
              <Text class="label">
                <Trans>
                  This combination was taken from another keybind, which is now
                  unbound:
                </Trans>{" "}
                {label(other())}
              </Text>
            )}
          </Show>

          <Show when={storeRefused()}>
            <ColouredText colour="var(--md-sys-color-error)">
              <Text class="label">
                <Trans>
                  Sloga could not save that combination. Pick a different key.
                </Trans>
              </Text>
            </ColouredText>
          </Show>
        </Column>
      }
    >
      {label(props.action)}
    </CategoryButton>
  );
}

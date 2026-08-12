import {
  For,
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useUser } from "@revolt/markdown/users";
import {
  REMOTE_CONTROL_CLAIM,
  REMOTE_CONTROL_EXPRESS_NOTE,
  REMOTE_CONTROL_TRUST_NOTE,
  useVoice,
} from "@revolt/rtc";
import { Button } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  identityForUserId,
  remoteParticipantUserIds,
} from "../participantIdentity";

/**
 * "Give control" — the sharer's affordance, on their own screen share.
 *
 * Sharer-initiated only. There is no "request control" from a viewer, which
 * is a deliberate subset of Teams rather than parity: it is the safer half,
 * because the party whose machine is at risk is the one who initiates and
 * there is no inbound channel for a stranger to pester someone into clicking
 * Accept.
 *
 * Every dialog that actually MATTERS here is native and lives in the shell —
 * `RcGive` before the offer goes out, and `RcArm` once the target accepts,
 * which is the one that arms injection and carries the verification code.
 * This picker is a HINT. It cannot write a grant, and it must never present
 * itself as the thing that authorised the session.
 */
export function VoiceGiveControlButton(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const client = useClient();
  const { t } = useLingui();
  const rc = voice.remoteControl;

  const [open, setOpen] = createSignal(false);
  const [display, setDisplay] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  // An offer is out at native and the OS dialog is up.
  const [busy, setBusy] = createSignal(false);
  // "Remember this person." Off every time the picker opens — a standing
  // opt-in that survives between sessions is how someone ends up remembering
  // a stranger they meant to help once.
  const [remember, setRemember] = createSignal(false);
  // The claim + mode-note disclosure. Collapsed every time the picker opens
  // for the same reason `remember` resets: the default view is the short one.
  const [details, setDetails] = createSignal(false);

  // A COMMAND PROBE rather than a shell sniff — see `RemoteControl.supported`.
  const [supported] = createResource(() => rc.supported());
  // Whether Express Connect is switched on for this device. Re-read every
  // time the picker opens rather than once at mount: it is changed in
  // Settings, which is a different screen in the same session, and a stale
  // `false` here would show the wrong warning at the exact moment it counts.
  const [express] = createResource(open, () => rc.expressEnabled());
  const [displays] = createResource(open, async () => {
    const found = await rc.displays();
    // Default the selector to the primary monitor as soon as the list
    // arrives. Leaving it blank meant a two-monitor sharer who did not touch
    // the dropdown silently offered DISPLAY1 — and the `RcArm` dialog then
    // names the wrong screen in the ONE line of that dialog that is not
    // server-asserted. §5(C) catches it, but only after they have answered
    // an OS prompt about the wrong monitor.
    //
    // `?? found[0]` because the selector is HIDDEN at one monitor (see
    // `mustChooseDisplay`): with no dropdown left to fall back on, a machine
    // that reports its only display without the primary flag would leave
    // `display()` unset and every click would refuse with "still reading
    // your displays".
    if (!display())
      setDisplay((found.find((d) => d.primary) ?? found[0])?.device);
    return found;
  });

  /**
   * Whether the sharer has a real choice to make.
   *
   * At one monitor the dropdown is pure noise: one option, already selected,
   * and picking it changes nothing. It is one of the seven interactions
   * slice 6 exists to cut, and dropping it costs no property — native still
   * holds the selection, still refuses to inject when that monitor's rect is
   * unavailable, and still revokes on any topology change. **Kept for 2+
   * monitors**, which is the case §5 was written for.
   */
  const mustChooseDisplay = () => (displays()?.length ?? 0) > 1;

  /**
   * 🔴 REMOTE CONTROL REQUIRES A WHOLE-SCREEN SHARE.
   *
   * Injection is addressed to a MONITOR — native resolves the selected
   * display's rect and maps normalized coordinates into it. Nothing clamps
   * that to a window. So on a window share the controller sees one
   * application and can drive the ENTIRE screen behind it: other windows,
   * the desktop, the taskbar — all invisible to them and all believed
   * private by the sharer. "I'm only sharing Notepad" is the natural reading
   * and it is wrong.
   *
   * Requiring `"monitor"` EXACTLY, so an unreported surface refuses rather
   * than waves it through: a gate that silently no-ops on the platform it
   * was written for is worse than no gate, because it reads as protection.
   * The cost of being wrong in this direction is a visible, explained
   * refusal (below) rather than a silent hole.
   *
   * NOT a security boundary — this is renderer state and a compromised
   * renderer can claim anything. It is an honesty gate for the ordinary
   * user. The security floor is unchanged: the native dialogs on the machine
   * being injected into.
   */
  const surface = () => voice.screenShareSurface();
  const fullScreenShare = () => surface() === "monitor";

  // One named participant, never "anyone who wants it". The dedupe-by-user
  // rule and why it exists now live in `remoteParticipantUserIds`, which the
  // slice-1 rotation panel shares — it cannot reuse this one, because this
  // whole subtree unmounts once `rc.sharing()` is truthy.
  const eligible = () => {
    const room = voice.room();
    const self = client()?.user?.id;
    if (!room || !self) return [];
    return remoteParticipantUserIds(room.remoteParticipants.values(), self);
  };

  // The device-qualified identity per-peer trust binds to. Shared with the
  // rotation panel; the reasoning lives on `identityForUserId`.
  const identityOf = (userId: string) => {
    const room = voice.room();
    if (!room) return "";
    return identityForUserId(room.remoteParticipants.values(), userId);
  };

  // `ENABLE_REMOTE_CONTROL` is already folded into `supported()`, which is
  // where it has to live to darken the inbound direction as well. It is
  // repeated here so that the release gate is visible at the affordance
  // itself rather than only two files away.
  //
  /**
   * The INSTANCE's `remote_control` switch, read LIVE off the client rather
   * than from `rc.serverEnabled()`.
   *
   * The store signal is fed by an effect that can only run as often as its
   * dependencies change, and the 2026-08-06 measurement showed what that
   * costs when it latches: flag off, button shown, offer dead-ending at
   * `400 FeatureDisabled`. This read cannot latch — `canOffer` re-evaluates
   * whenever `screenshare()`/`sharing()`/`supported()` change, and by the
   * time anyone is screensharing the configuration has long since been
   * fetched. The signal remains the gate for the INBOUND direction inside
   * `supported()`, where no such re-evaluation is available.
   *
   * `!== false` because `undefined` means "not read yet", not "off"; the
   * server refuses the offer regardless, so this gate is about not showing a
   * dead button rather than about enforcement.
   */
  const serverAllows = () =>
    (
      client()?.configuration?.features as
        | { remote_control?: boolean }
        | undefined
    )?.remote_control !== false;

  /**
   * The SERVER's view of our screen share (dc0d5946's other half). After a
   * reconnect the OS capture, `voice.screenshare()` and the local LiveKit
   * publication can all report a live share while the SFU has no track — so
   * the button was offered against a dead share and the offer could only
   * come back `400 FailedValidation`. This reads the same `screen_video`
   * the offer route gates on. `undefined` means "server hasn't said" and
   * stays permissive — only an explicit `false` is a refusal.
   */
  const serverSeesShare = () => voice.serverSeesScreenVideo() !== false;

  const canOffer = () =>
    CONFIGURATION.ENABLE_VIDEO &&
    CONFIGURATION.ENABLE_REMOTE_CONTROL &&
    serverAllows() &&
    supported() === true &&
    voice.screenshare() &&
    serverSeesShare() &&
    !rc.sharing() &&
    // A "pass the controller" handoff (slice 1) genuinely has no session
    // for a moment — the old turn is released before the next is offered.
    // Without this the picker would pop back for that instant, which both
    // flashes the wrong control and implies the rotation ended.
    !rc.handingOff();

  async function offer(userId: string, name: string) {
    // One offer in flight at a time. `e2ee_rc_offer` mints an ephemeral and
    // puts a native dialog on screen, so a second click while the first is
    // open would mint a second keypair for an offer nobody can answer.
    if (busy()) return;

    const api = client();
    const channel = voice.channel();
    const self = api?.user?.id;
    const found = displays();
    const monitor =
      display() ?? (found?.find((d) => d.primary) ?? found?.[0])?.device;
    if (!api || !channel || !self) {
      // Was a bare `return` — the same silent dead click the no-monitor
      // branch below already refuses to ship. Not localised, for the reason
      // every other failure state in this feature is not: the text is a
      // diagnostic, and it is rendered by the same <Warning> that renders
      // `rc.error()` raw.
      setError(`cannot offer: ${!channel ? "not in a call" : "no account id"}`);
      return;
    }
    if (!monitor) {
      // The monitor list has not resolved. Say so rather than doing nothing:
      // a picker that silently ignores a click reads as a broken button.
      setError(t`Still reading your displays — try again in a moment.`);
      return;
    }
    // Backstop for the whole-screen rule. The picker already refuses in
    // place of the people list, so this is unreachable through the UI — but
    // the share can change UNDER an open picker (stop a screen share, start
    // a window share, without closing this panel), and the check that
    // matters is the one taken at the moment the offer is minted.
    if (!fullScreenShare()) {
      setError(t`Remote control needs a whole-screen share.`);
      return;
    }
    setError(undefined);
    setBusy(true);
    const offered = await rc.offerControl({
      apiBase: api.options.baseURL,
      authHeader: api.authenticationHeader as [string, string],
      channelId: channel.id,
      sharerId: self,
      controllerId: userId,
      controllerIdentity: identityOf(userId),
      controllerName: name,
      display: monitor,
      // A REQUEST, not a grant. It changes what the native dialog says; the
      // trust row is written inside core only if that dialog returns true.
      remember: remember(),
    });
    setBusy(false);

    // CLOSE ONLY ON SUCCESS. Closing first meant every failure — a declined
    // native dialog, `FeatureDisabled`, "not publishing screen video", an
    // unset local user id — resolved into a panel that had already
    // unmounted, so the picker simply vanished and said nothing. Closing
    // here is belt-and-braces anyway: a live offer makes `rc.sharing()`
    // truthy, which drops `canOffer()` and unmounts this whole subtree.
    if (offered) setOpen(false);
    else setError(rc.error() ?? "offer failed");
  }

  return (
    <Show when={canOffer()}>
      {/* A LABELLED pill, and deliberately not `filled`.

          Shape alone did not carry it: `filled` resolves to the same
          primary/on-primary pair as IconButton's active state, so the first
          attempt rendered as a third lit circle indistinguishable from an
          unmuted mic — observed in a real call. Three things separate it now:
          the tertiary colour (neither a lit toggle nor destructive red), the
          width a label gives it, and the label itself.

          The words matter beyond styling. This hands over a mouse and
          keyboard, and an unlabelled glyph asks someone to recognise that
          from an icon; Teams and Zoom both spell it out. It only mounts while
          a whole-screen share is live, so the extra width is never present on
          an idle call. */}
      <Button
        size={props.size}
        variant="_tertiary"
        onPress={() =>
          setOpen((was) => {
            // Reset on every open, not on close: a checkbox that stayed
            // ticked from the last time is how someone remembers a person
            // they never meant to.
            if (!was) {
              setRemember(false);
              setDetails(false);
            }
            return !was;
          })
        }
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`Give control of this screen`,
          },
        }}
      >
        <Symbol>arrow_selector_tool</Symbol>
        <Trans>Give control</Trans>
      </Button>

      <Show when={open()}>
        <Popover>
          <Sheet>
            <Heading>
              <Trans>Give control of this computer</Trans>
            </Heading>

            {/* The §5 display selector, shown ONLY when there is more than
              one monitor. The captured source is NOT knowable — WebView2
              handles the picker natively and no web API reveals which display
              `getDisplayMedia` took — so the sharer says which one, and the
              next step confirms it by eye. With a single monitor there is
              nothing to say and nothing to confirm, so both steps go. */}
            <Show when={mustChooseDisplay()}>
              <Label>
                <Trans>Which screen are you sharing?</Trans>
              </Label>
              <Select
                value={display() ?? ""}
                onChange={(event) => setDisplay(event.currentTarget.value)}
              >
                <For each={displays() ?? []}>
                  {(monitor) => (
                    <option value={monitor.device}>
                      {monitor.device} — {monitor.width}×{monitor.height}
                      {monitor.primary ? " (primary)" : ""}
                    </option>
                  )}
                </For>
              </Select>
            </Show>

            {/* The window-share refusal. Shown IN PLACE of the people list,
              following §6's rule for ineligible rows: refuse with a reason
              rather than hiding the affordance, because a button that
              vanishes reads as a bug and invites a retry. The reason has to
              name the remedy — "share your whole screen instead" — since
              the share is already running and the fix is not obvious. */}
            <Show
              when={fullScreenShare()}
              fallback={
                <Warning>
                  {surface()
                    ? t`Remote control needs a whole-screen share. You are sharing a single window, and their mouse and keyboard would reach everything else on that screen — including what you have not shared. Stop the share and share your whole screen instead.`
                    : t`Sloga cannot tell which screen you are sharing, so it will not hand over control. Stop the share and share your whole screen again.`}
                </Warning>
              }
            >
              <Label>
                <Trans>Who should get control?</Trans>
              </Label>
              <People>
                <For each={eligible()}>
                  {(userId) => (
                    <PersonRow userId={userId} busy={busy()} onPick={offer} />
                  )}
                </For>
                <Show when={eligible().length === 0}>
                  <Muted>
                    <Trans>Nobody else is in this call yet.</Trans>
                  </Muted>
                </Show>
              </People>
            </Show>

            {/* Per-peer trust. This box only ASKS: what it changes is the
              copy of the native dialog on the next screen, and the trust is
              recorded by that dialog returning true, inside the shell. A
              renderer that could write the list could grant itself a way
              past a consent dialog, so there is no command that does.

              The label itself was reviewed and left ALONE deliberately. It
              never names which confirmation goes, and "one of the two, next
              time" is true in both express states — rc_dialog_plan rows 1→2
              and 3→4 both go from two dialogs to one. What it leaves out,
              that under Express Connect the one skipped is the one carrying
              the code, is covered by the trust note (behind Details since
              the rc-dialog-trim pass) and by the native dialogs, which are
              the consent surface. */}
            <Remember>
              <input
                type="checkbox"
                checked={remember()}
                onChange={(event) => setRemember(event.currentTarget.checked)}
              />
              <Trans>
                Skip one of the two system confirmations for this person next
                time
              </Trans>
            </Remember>
            {/* §8: this is the tech-support scam, near enough verbatim, and the
              warning belongs where the decision is made. ALWAYS visible —
              the rc-dialog-trim pass moved everything else behind Details
              precisely so this sentence is not buried while a victim is
              being talked through the flow on the phone. */}
            <Warning>
              <Trans>
                Anyone you give control to can use your mouse and keyboard, run
                commands and open your files. Nobody from support will ever ask
                you for control.
              </Trans>
            </Warning>

            {/* rc-dialog-trim §5: the pinned claim and the two mode notes sit
              behind a disclosure so the default view is short. No string
              changes — "Details"/"Hide" are the panel's existing msgids, and
              the three texts render verbatim when opened.

              🔴 The trust note and the express note are SECURITY STATEMENTS
              (reviewed 2026-07-29) for modes with a different property than
              the pinned claim — one OS confirmation instead of two. They are
              separate strings on purpose; do not fold them into
              REMOTE_CONTROL_CLAIM, which is still rendered verbatim below.
              The express note shows whenever Express Connect is on, not only
              when it will apply to the person about to be picked — native
              decides that per peer and this component cannot know which rows
              qualify. Over-warning is the safe direction. */}
            <Show
              when={details()}
              fallback={
                <Button size="sm" variant="text" onPress={() => setDetails(true)}>
                  <Trans>Details</Trans>
                </Button>
              }
            >
              <Show when={remember()}>
                <Warning>{REMOTE_CONTROL_TRUST_NOTE}</Warning>
              </Show>
              <Show when={express()}>
                <Warning>{REMOTE_CONTROL_EXPRESS_NOTE}</Warning>
              </Show>

              {/* The approved claim wording, rendered verbatim and never
                paraphrased upward. It concedes keystroke timing in the same
                sentence as confidentiality on purpose. */}
              <Claim>{REMOTE_CONTROL_CLAIM}</Claim>
              <Button size="sm" variant="text" onPress={() => setDetails(false)}>
                <Trans>Hide</Trans>
              </Button>
            </Show>

            <Show when={error()}>
              <Warning>{error()}</Warning>
            </Show>
            <Button size="sm" variant="text" onPress={() => setOpen(false)}>
              <Trans>Cancel</Trans>
            </Button>
          </Sheet>
        </Popover>
      </Show>
    </Show>
  );
}

function PersonRow(props: {
  userId: string;
  busy: boolean;
  onPick: (userId: string, name: string) => void;
}) {
  const user = useUser(props.userId);
  const name = () => user()?.username ?? props.userId;
  // §6: ineligible people are shown DISABLED WITH A REASON rather than
  // hidden, so the sharer understands why someone they can see in the call is
  // not in this list. Hiding them reads as a bug and invites a retry; the
  // server rejects a bot offer with a bare "offer rejected (4xx)" that says
  // nothing about why.
  // `useUser` resolves to display INFORMATION; the underlying user object is
  // where `bot` lives.
  const ineligible = () => (user()?.user?.bot ? "bot" : undefined);
  return (
    <Show
      when={!ineligible()}
      fallback={
        // `Bot` is an EXISTING message id, reused deliberately: `lingui
        // extract` does not run in this tree (the catalogs are hand-appended
        // and precompiled with generated hash ids), so a brand-new string
        // would ship untranslated in every locale to save one word.
        <Button size="sm" variant="tonal" isDisabled>
          {name()} (<Trans>Bot</Trans>)
        </Button>
      }
    >
      <Button
        size="sm"
        variant="tonal"
        isDisabled={props.busy}
        onPress={() => props.onPick(props.userId, name())}
      >
        {name()}
      </Button>
    </Show>
  );
}

/**
 * The sharer's in-call panel once a session exists: the §5(C) calibration
 * step, then an honest running state and a Stop.
 *
 * Everything shown here is read from NATIVE state, never from a server event.
 * Against the threat model this feature admits — a hostile server, and a
 * compromised renderer that is equivalent to one — the server-written audit
 * trail and server-rendered copy are worth nothing; what survives is local.
 * The always-on-top indicator window is the authoritative surface, and this
 * panel is its in-app companion.
 */
export function VoiceGiveControlPanel() {
  const voice = useVoice();
  const { t } = useLingui();
  const rc = voice.remoteControl;
  const [showCode, setShowCode] = createSignal(false);
  // Once the session is ACTIVE, collapse to a compact bar — the controller
  // panel's own pattern. Everything dropped in compact mode is carried by
  // the native indicator (controller name, the panic combo), which is the
  // authoritative surface anyway; the live matrix found the two overlapping
  // and saying the same things. `offered` and `calibrating` keep the full
  // stack — the reader has decisions still to make there.
  const [expanded, setExpanded] = createSignal(false);

  return (
    <Show when={rc.sharing()}>
      {(session) => {
        const compact = () => session().phase === "active" && !expanded();
        return (
          <Sheet>
          <Switch>
            <Match when={session().phase === "offered"}>
              <Heading>
                <Trans>Waiting for them to accept…</Trans>
              </Heading>
              <Muted>{session().controllerName}</Muted>
            </Match>

            <Match when={session().phase === "calibrating"}>
              <Heading>
                <Trans>Check the pointer is on the right screen</Trans>
              </Heading>
              {/* §5(C). Until this is confirmed native injects POINTER MOTION
                  AND NOTHING ELSE, which is exactly enough to run the check
                  and no more. The failure it closes has no attacker in it:
                  with two monitors the sharer can pick the one they are not
                  sharing, and the controller then drives a screen nobody is
                  looking at — blind control, which is worse than none. */}
              <Muted>
                <Trans>
                  Ask them to move their mouse. Their pointer should move on the
                  screen you are sharing. Keys and clicks are still blocked
                  until you confirm.
                </Trans>
              </Muted>
              <Row>
                <Button
                  size="sm"
                  variant="filled"
                  onPress={() => rc.confirmCalibration(true)}
                >
                  <Trans>Yes, that's the right screen</Trans>
                </Button>
                <Button
                  size="sm"
                  variant="_error"
                  onPress={() => rc.confirmCalibration(false)}
                >
                  <Trans>No — stop</Trans>
                </Button>
              </Row>
            </Match>

            <Match when={session().phase === "active"}>
              <Heading>
                <Trans>They can control this computer</Trans>
              </Heading>
              {/* Both lines are the indicator's job while compact — it names
                  the controller and carries the stop affordance. Repeating
                  them here is what produced two colliding surfaces saying
                  the same things. */}
              <Show when={!compact()}>
                <Muted>{session().controllerName}</Muted>
                <Muted>
                  <Trans>Stop at any time with Ctrl+Shift+Alt+Q.</Trans>
                </Muted>
              </Show>
            </Match>
          </Switch>

          {/* Exit FIRST, same as the controller panel's compact bar. */}
          <Show when={compact()}>
            <Row>
              <Button
                size="sm"
                variant="_error"
                onPress={() => rc.endSharing("sharer_stopped")}
              >
                <Trans>Take back control</Trans>
              </Button>
              <Button size="sm" variant="text" onPress={() => setExpanded(true)}>
                <Trans>Details</Trans>
              </Button>
            </Row>
          </Show>

          {/* The Verify affordance. Never on the path to accepting anything,
              and deliberately not a green "verified" state: the authoritative
              comparison is the one printed inside the native Start dialog,
              because a code this page draws is a code a compromised renderer
              chose.

              🔴 …except in Express Connect, where there was no native Start
              dialog carrying a code. The old copy told the user flatly that
              "the copy shown in the system dialog when you pressed Start is
              the one that counts", which in that mode points at a surface
              they never saw and implies they did. Conditional wording until
              native returns `arm_dialog` from the offer record alongside the
              SAS — it knows; the renderer does not, and must NOT infer it
              from the express switch, which is exactly the bit a compromised
              renderer would flip. */}
          <Show when={!compact()}>
            <Show when={session().sas}>
              <Button
                size="sm"
                variant="text"
                onPress={() => setShowCode((v) => !v)}
              >
                <Trans>Verify</Trans>
              </Button>
              <Show when={showCode()}>
                <Code>{session().sas}</Code>
                <Muted>
                  <Trans>
                    Read this aloud. If it does not match their code, stop the
                    session. This panel is drawn by the app. If Sloga showed
                    you this code in a system dialog when you started, that
                    copy is the one that counts.
                  </Trans>
                </Muted>
              </Show>
            </Show>

            <Row>
              <Button
                size="sm"
                variant="_error"
                onPress={() => rc.endSharing("sharer_stopped")}
              >
                <Trans>Take back control</Trans>
              </Button>
              {/* "Hide" is an EXISTING msgid, reused deliberately (the
                  controller panel's disclosure toggle). */}
              <Show when={session().phase === "active"}>
                <Button
                  size="sm"
                  variant="text"
                  onPress={() => setExpanded(false)}
                >
                  <Trans>Hide</Trans>
                </Button>
              </Show>
            </Row>
          </Show>

          {/* Always visible, compact or not: an error, or a stop shortcut
              that may not work, is never detail. */}
          <Show when={rc.error()}>
            <Warning>{rc.error()}</Warning>
          </Show>
          <Show when={rc.status()?.hook?.hotkey_registered === false}>
            <Warning>
              {t`Another program is using Ctrl+Shift+Alt+Q, so that shortcut may not stop the session. Use the Stop button.`}
            </Warning>
          </Show>
        </Sheet>
        );
      }}
    </Show>
  );
}

const Sheet = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    maxWidth: "420px",
    boxShadow: "0 8px 24px #0006",
  },
});

/**
 * The picker, positioned like every other call-card popover
 * (`VoiceSoundboardButton`, `VoiceDeviceSelector`). Laid out inline it would
 * wrap onto a second row INSIDE the rounded controls pill and stretch it,
 * because `Actions` is a `flexWrap: wrap` row with `borderRadius: full`.
 */
const Popover = styled("div", {
  base: {
    position: "absolute",
    // Fixed offset, not `100%`: the containing block is the call Card rather
    // than this wrapper, so grow upward from just above the controls bar.
    bottom: "64px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
    minWidth: "300px",
  },
});

const Heading = styled("div", {
  base: { fontWeight: 600 },
});

const Label = styled("div", {
  base: { fontSize: "0.85em", opacity: 0.8 },
});

const Muted = styled("div", {
  base: { fontSize: "0.85em", opacity: 0.75 },
});

const Warning = styled("div", {
  base: {
    fontSize: "0.85em",
    color: "var(--md-sys-color-error)",
  },
});

const Claim = styled("div", {
  base: { fontSize: "0.75em", opacity: 0.6 },
});

const Code = styled("div", {
  base: {
    fontFamily: "var(--monospace-font), monospace",
    fontSize: "1.05em",
    letterSpacing: "0.06em",
    userSelect: "text",
  },
});

const Row = styled("div", {
  base: { display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap" },
});

const People = styled("div", {
  base: { display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap" },
});

/**
 * The "remember this person" row. A bare `<input type=checkbox>` rather than
 * the design-system `Checkbox`, which is a display-only indicator whose
 * clicks are meant to pass through to a `CategoryButton` row — there is no
 * row here to pass them to.
 */
const Remember = styled("label", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    fontSize: "0.85em",
    cursor: "pointer",
  },
});

const Select = styled("select", {
  base: {
    font: "inherit",
    padding: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface)",
    border: "none",
  },
});

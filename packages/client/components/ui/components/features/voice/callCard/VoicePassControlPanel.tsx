import {
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useUser } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { REMOTE_CONTROL_OFFER_TTL_MS } from "@revolt/rtc/remoteControl";
import { nextInQueue, turnExpired } from "@revolt/rtc/remoteControlQueue";
import { Button } from "@revolt/ui/components/design";

import {
  identityForUserId,
  remoteParticipantUserIds,
} from "../participantIdentity";

/** How often the turn timer is checked. A turn is minutes long; a second of
 *  slop either side of the deadline is invisible and costs nothing. */
const TICK_MS = 1000;

/** Turn lengths offered. `undefined` = no timer, and it is the DEFAULT: an
 *  automatic handoff ends a session on a schedule the person driving did not
 *  choose, so it has to be asked for. */
const TURN_LENGTHS: { label: string; ms: number | undefined }[] = [
  { label: "off", ms: undefined },
  { label: "2m", ms: 2 * 60_000 },
  { label: "5m", ms: 5 * 60_000 },
  { label: "10m", ms: 10 * 60_000 },
];

/**
 * "Pass the controller" — the streamer's rotation panel (slice 1).
 *
 * 🔴 A HANDOFF IS NOT A TRANSFER. Every layer of the stack binds a session to
 * one controller identity permanently, so passing the controller is
 * release → fresh offer → fresh native `RcArm`, with a real gap where nobody
 * is driving. This panel shows that gap rather than hiding it, and every turn
 * still costs one OS-level "yes" on this machine. That dialog is the
 * feature's safety, not friction to be optimised away.
 *
 * The queue is LOCAL to this client and grants nothing. It is a running
 * order the sharer keeps — a server-ordered rotation would be a
 * server-chosen controller, and the pinned claim is precisely that the
 * server's word about who is on the other end proves nothing.
 *
 * Mounted while `rc.sharing()` (or a handoff is in flight) as a SIBLING of
 * `VoiceGiveControlPanel` — deliberately not inside the offer picker, whose
 * subtree is gated on `canOffer()` and therefore unmounts the instant a
 * session goes active, which is exactly when rotation is needed.
 */
export function VoicePassControlPanel() {
  const voice = useVoice();
  const client = useClient();
  const { t } = useLingui();
  const rc = voice.remoteControl;

  const [error, setError] = createSignal<string>();
  // Same discipline as the picker's checkbox: OFF every time. A standing
  // opt-in that survives between sessions is how someone ends up having
  // remembered a stranger they meant to hand the controller to once.
  const [remember, setRemember] = createSignal(false);
  // Re-read on every session change rather than once at mount: both are
  // changed in Settings, which is a different screen in the same session.
  const [trusted] = createResource(
    () => rc.sharing()?.rcSessionId ?? "idle",
    () => rc.trustedPeers(),
  );
  const [express] = createResource(
    () => rc.sharing()?.rcSessionId ?? "idle",
    () => rc.expressEnabled(),
  );

  const self = () => client()?.user?.id;

  /** Everyone else in the call, deduped by user. */
  const present = () => {
    // 🔴 `room.remoteParticipants` is a plain LiveKit Map, NOT a Solid
    // source, so a join/leave alone re-runs nothing. Read the version signal
    // the store bumps on `participantConnected`/`participantDisconnected`
    // (state.tsx) — the same reactive-dependency idiom the encryption chip
    // uses. Without this the prune effect below never fires on a leave, and
    // the turn timer can auto-hand-off to someone who has already left.
    voice.callParticipantsVersion();
    const room = voice.room();
    const me = self();
    if (!room || !me) return [];
    return remoteParticipantUserIds(room.remoteParticipants.values(), me);
  };

  const queue = () => voice.controllerQueue();
  const current = () => rc.sharing()?.controllerId;
  const next = () => nextInQueue(queue(), current());

  const trustedIds = () => new Set((trusted() ?? []).map((p) => p.userId));

  /**
   * 🔴 Express Connect and rotation are a DISALLOWED combination.
   *
   * With a remembered peer and Express off, the one surviving native dialog
   * is `RcArm` — the strong one: it arms injection and carries the
   * verification code. With Express ON the survivor is `RcGive` instead,
   * which by design shows no code. So Express would silently strip the
   * per-handoff verification from every turn in the rotation, which is the
   * one check the claim discipline says is left. Refuse rather than
   * degrade: an implementer optimising clicks for game night is exactly the
   * person who would turn Express on and never notice what it removed.
   */
  const expressBlocks = () => express() === true;

  // Keep the rotation honest about who is actually here. A member who left
  // would stall the rotation at the server's 90 s offer TTL, which reads as
  // the app being stuck on someone who is not in the call.
  createEffect(() => voice.retainPresentControllers(present()));

  // Same for pending "ask for a turn" requests: a raised hand from someone
  // who has since left the call is nothing the streamer can act on.
  createEffect(() => voice.retainPresentTurnRequests(present()));

  /** Requesters not already in the rotation — the actionable ones. */
  const requests = () =>
    voice.pendingTurnRequests().filter((r) => !queue().includes(r.userId));

  // Whoever is driving belongs in the rotation, so that "next" wraps past
  // them instead of treating them as an outsider. Only once the session is
  // ACTIVE — an offer that is never accepted should not reserve a place.
  createEffect(() => {
    const session = rc.sharing();
    if (session?.phase === "active")
      voice.enqueueController(session.controllerId);
  });

  // Start the clock when a turn actually begins. Keyed on the controller so
  // each new turn gets a full length rather than inheriting the last one's
  // remaining time.
  createEffect((previous: string | undefined) => {
    const session = rc.sharing();
    const controller =
      session?.phase === "active" ? session.controllerId : undefined;
    if (controller && controller !== previous)
      voice.armTurnDeadline(Date.now());
    if (!controller) voice.clearTurnDeadline();
    return controller;
  });

  // The turn timer. Deliberately a poll rather than a `setTimeout` armed at
  // the deadline: the deadline moves (the streamer can change the length, or
  // pass early), and a timer that has to be cancelled and re-armed on every
  // one of those is the shape that leaks a stale handoff.
  const [nowMs, setNowMs] = createSignal(Date.now());
  const tick = setInterval(() => setNowMs(Date.now()), TICK_MS);
  onCleanup(() => clearInterval(tick));

  createEffect(() => {
    if (!turnExpired(voice.turnDeadline(), nowMs())) return;
    // Clear the deadline FIRST, so a slow handoff cannot re-trigger on the
    // next tick while the first one is still in flight.
    voice.clearTurnDeadline();
    const target = next();
    if (target) void handoff(target);
  });

  /**
   * 🔴 An offer nobody can answer must not stall the rotation.
   *
   * Both remote-control roles go through a native command probe, so
   * web/Android/Linux participants can NEVER accept — and the roster carries
   * no capability field to tell the streamer that in advance (a beacon is a
   * later slice). Today the offer simply dead-ends at the server's TTL with
   * no event either way, which in a rotation reads as the app being stuck on
   * one person forever. This is the plan's "optimistic offer, fast failure":
   * notice the expiry and SAY so.
   *
   * Deliberately does NOT auto-advance. Rotating on by itself would put an
   * unrequested native dialog on screen; the streamer presses Next.
   */
  createEffect(() => {
    const session = rc.sharing();
    if (session?.phase !== "offered") return;
    const offered = session.rcSessionId;
    const name = session.controllerName;
    const timer = setTimeout(() => {
      // Re-read: the offer may have been accepted, declined or replaced
      // while this was pending, and tearing down THAT session would end a
      // turn somebody is happily driving.
      const still = rc.sharing();
      if (still?.rcSessionId !== offered || still.phase !== "offered") return;
      void rc.endSharing("offer_expired");
      setError(
        t`${name} didn't take the controller. Remote control needs the desktop app — press Next to move on.`,
      );
    }, REMOTE_CONTROL_OFFER_TTL_MS + 5000);
    onCleanup(() => clearTimeout(timer));
  });

  const remaining = () => {
    const deadline = voice.turnDeadline();
    if (deadline === undefined) return undefined;
    return Math.max(0, deadline - nowMs());
  };

  const clock = (ms: number) => {
    const total = Math.ceil(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  /**
   * Hand the controller to `userId`.
   *
   * The monitor is read from the CURRENT session and passed through, so a
   * rotation never silently changes which screen is being handed over. It
   * has to be captured here, before the release: `passControlTo` clears the
   * session as its first step.
   */
  async function handoff(userId: string) {
    // A handoff is already in flight — e.g. the turn timer expired at the
    // same instant a manual Next was pressed. `passControlTo`'s own guard
    // would reject this one and it would then set a misleading "couldn't
    // hand over" banner while the WINNING handoff is succeeding. Bail
    // quietly; the guard in the store is the authoritative one.
    if (rc.handingOff()) return;

    const api = client();
    const channel = voice.channel();
    const me = self();
    const room = voice.room();
    const session = rc.sharing();
    const display = session?.display;

    if (!api || !channel || !me || !room) {
      setError(
        `cannot pass control: ${!channel ? "not in a call" : "no account id"}`,
      );
      return;
    }
    if (!display) {
      // No live session to hand over. Reachable if the turn ended by another
      // path (the controller left, the share stopped) between the click and
      // here — say so rather than doing nothing.
      setError(
        t`That turn already ended. Offer control again to restart the rotation.`,
      );
      return;
    }
    // 🔴 Re-read Express LIVE at the enforcement point, not from the
    // per-session resource. `expressBlocks()` (the resource) is keyed on the
    // session id, so a mid-turn toggle in Settings is not seen until the id
    // rolls — and this gate is security-relevant: with Express on, the sole
    // surviving dialog for a remembered peer is `RcGive`, which carries no
    // verification code. A stale `false` here would mint exactly that
    // no-SAS handoff. The reactive `expressBlocks()` still drives the Next
    // button's disabled state and the warning banner; this is the check
    // right before a new session is minted.
    if (await rc.expressEnabled()) {
      setError(
        t`Turn off Express Connect in Settings to pass the controller — with it on, a handoff would not show a verification code.`,
      );
      return;
    }

    setError(undefined);
    const user = client()?.users.get(userId);
    const passed = await rc.passControlTo({
      apiBase: api.options.baseURL,
      authHeader: api.authenticationHeader as [string, string],
      channelId: channel.id,
      sharerId: me,
      controllerId: userId,
      controllerIdentity: identityForUserId(
        room.remoteParticipants.values(),
        userId,
      ),
      controllerName: user?.username ?? userId,
      display,
      remember: remember(),
    });

    if (!passed) {
      // Suppress the banner if a DIFFERENT handoff is now in flight: the
      // entry guard bails when one is already running, but two callers can
      // both pass it and interleave across the `await` above, and the loser
      // must not accuse the winner of failing. `passControlTo` clears its
      // own `handingOff` in a finally before returning, so a truthy value
      // here can only be someone else's live handoff.
      if (rc.handingOff()) return;
      // The previous turn really did end — this is not a no-op. Say so, and
      // leave the queue untouched so the same click retries cleanly.
      setError(
        rc.error() ??
          t`Couldn't hand over. The last turn has ended — press Next to try again.`,
      );
    }
  }

  return (
    <Show
      when={
        CONFIGURATION.ENABLE_REMOTE_CONTROL && (rc.sharing() || rc.handingOff())
      }
    >
      <Sheet>
        <Heading>
          <Trans>Pass the controller</Trans>
        </Heading>

        {/* The gap is real and is shown, never papered over: between the
            release and the next arm nobody is driving. */}
        <Show when={rc.handingOff()}>
          <Muted>
            <Trans>Handing off… nobody is driving right now.</Trans>
          </Muted>
        </Show>

        <Show when={expressBlocks()}>
          <Warning>
            <Trans>
              Express Connect is on, so a handoff would not show a verification
              code. Turn it off in Settings to use the rotation.
            </Trans>
          </Warning>
        </Show>

        {/* The rotation, in order. The person driving is marked rather than
            hidden — "whose turn is after mine" needs the whole circle. */}
        <Show
          when={queue().length > 0}
          fallback={
            <Muted>
              <Trans>
                Add players below to build a rotation. Each turn still asks you
                on this computer before anyone can type or click.
              </Trans>
            </Muted>
          }
        >
          <List>
            <For each={queue()}>
              {(userId) => (
                <QueueRow
                  userId={userId}
                  isCurrent={userId === current()}
                  isNext={userId === next()}
                  isTrusted={trustedIds().has(userId)}
                  onRemove={() => voice.dequeueController(userId)}
                />
              )}
            </For>
          </List>
        </Show>

        {/* Raised hands. Suggestions only — adding one to the rotation is a
            deliberate act, and it still costs the native dialog on the next
            turn like any other. Nothing here auto-enqueues. */}
        <Show when={requests().length > 0}>
          <Label>
            <Trans>Asked for a turn</Trans>
          </Label>
          <List>
            <For each={requests()}>
              {(request) => (
                <RequestRow
                  userId={request.userId}
                  isCapable={voice.participantRcCapable(request.userId)}
                  onAdd={() => {
                    voice.enqueueController(request.userId);
                    voice.clearTurnRequest(request.userId);
                  }}
                  onDismiss={() => voice.clearTurnRequest(request.userId)}
                />
              )}
            </For>
          </List>
        </Show>

        {/* Everyone in the call who is not yet in the rotation. */}
        <Show when={present().some((id) => !queue().includes(id))}>
          <Label>
            <Trans>Add to the rotation</Trans>
          </Label>
          <People>
            <For each={present().filter((id) => !queue().includes(id))}>
              {(userId) => (
                <AddButton
                  userId={userId}
                  isCapable={voice.participantRcCapable(userId)}
                  onAdd={() => voice.enqueueController(userId)}
                />
              )}
            </For>
          </People>
        </Show>

        <Row>
          <Button
            size="sm"
            variant="filled"
            isDisabled={!next() || rc.handingOff() || expressBlocks()}
            onPress={() => {
              const target = next();
              if (target) void handoff(target);
            }}
          >
            <Trans>Next turn</Trans>
          </Button>
          <Show when={queue().length > 0}>
            <Button
              size="sm"
              variant="text"
              onPress={() => voice.clearControllerQueue()}
            >
              <Trans>Clear</Trans>
            </Button>
          </Show>
        </Row>

        {/* Turn timer. Off by default — see TURN_LENGTHS. */}
        <Label>
          <Trans>Turn length</Trans>
        </Label>
        <Row>
          <For each={TURN_LENGTHS}>
            {(option) => (
              <Button
                size="sm"
                variant={
                  voice.turnLengthMs() === option.ms ? "filled" : "tonal"
                }
                onPress={() => {
                  voice.setTurnLength(option.ms);
                  // Re-arm from now, so switching to "5m" mid-turn gives a
                  // full five minutes rather than expiring immediately
                  // against a deadline computed from the old length.
                  if (option.ms !== undefined)
                    voice.armTurnDeadline(Date.now());
                }}
              >
                {option.label === "off" ? t`Off` : option.label}
              </Button>
            )}
          </For>
        </Row>
        <Show when={remaining() !== undefined}>
          <Muted>
            <Trans>Turn ends in {clock(remaining()!)}</Trans>
          </Muted>
        </Show>

        {/* Same wording discipline as the picker's checkbox, and the same
            default: OFF. Remembering someone is what collapses their future
            turns to a single prompt, and it is a standing grant, so it is
            asked for rather than assumed. */}
        <Remember>
          <input
            type="checkbox"
            checked={remember()}
            onChange={(e) => setRemember(e.currentTarget.checked)}
          />
          <Trans>
            Remember each player on this computer, so their next turn asks once
            instead of twice
          </Trans>
        </Remember>

        <Claim>
          <Trans>
            Passing the controller lets that person type and click on this
            computer for real — everything you can see, they can drive.
          </Trans>
        </Claim>

        <Show when={error()}>
          <Warning>{error()}</Warning>
        </Show>
      </Sheet>
    </Show>
  );
}

/** One row of the rotation. */
function QueueRow(props: {
  userId: string;
  isCurrent: boolean;
  isNext: boolean;
  isTrusted: boolean;
  onRemove: () => void;
}) {
  const user = useUser(() => props.userId);
  const name = () => user()?.username ?? props.userId;

  return (
    <RowItem>
      <Name>{name()}</Name>
      <Show when={props.isCurrent}>
        <Tag>
          <Trans>driving</Trans>
        </Tag>
      </Show>
      <Show when={props.isNext}>
        <Tag>
          <Trans>next</Trans>
        </Tag>
      </Show>
      {/* Honest about what the next handoff will cost them, because it is
          the difference between one OS prompt and two. */}
      <Show when={!props.isTrusted}>
        <Muted>
          <Trans>asks twice</Trans>
        </Muted>
      </Show>
      <Button size="sm" variant="text" onPress={props.onRemove}>
        <Trans>Remove</Trans>
      </Button>
    </RowItem>
  );
}

function AddButton(props: {
  userId: string;
  isCapable: boolean;
  onAdd: () => void;
}) {
  const user = useUser(() => props.userId);
  const name = () => user()?.username ?? props.userId;
  return (
    <Button size="sm" variant="tonal" onPress={props.onAdd}>
      {name()}
      {/* Additive only: a chip appears for a peer who ANNOUNCED desktop
          capability. Its absence means "hasn't said", never "can't" — so
          there is no greyed/blocked state here (see participantRcCapable). */}
      <Show when={props.isCapable}>
        {" "}
        <DesktopChip>
          <Trans>Desktop</Trans>
        </DesktopChip>
      </Show>
    </Button>
  );
}

/** One raised hand awaiting the streamer's decision. */
function RequestRow(props: {
  userId: string;
  isCapable: boolean;
  onAdd: () => void;
  onDismiss: () => void;
}) {
  const user = useUser(() => props.userId);
  const name = () => user()?.username ?? props.userId;

  return (
    <RowItem>
      <Name>{name()}</Name>
      <Show when={props.isCapable}>
        <DesktopChip>
          <Trans>Desktop</Trans>
        </DesktopChip>
      </Show>
      <Button size="sm" variant="tonal" onPress={props.onAdd}>
        <Trans>Add to rotation</Trans>
      </Button>
      <Button size="sm" variant="text" onPress={props.onDismiss}>
        <Trans>Dismiss</Trans>
      </Button>
    </RowItem>
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
  base: { fontSize: "0.85em", color: "var(--md-sys-color-error)" },
});

const Claim = styled("div", {
  base: { fontSize: "0.75em", opacity: 0.6 },
});

const Row = styled("div", {
  base: { display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap" },
});

const People = styled("div", {
  base: { display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap" },
});

const List = styled("div", {
  base: { display: "flex", flexDirection: "column", gap: "var(--gap-sm)" },
});

const RowItem = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,
  },
});

const Name = styled("div", {
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flexGrow: 1,
  },
});

const Tag = styled("div", {
  base: {
    fontSize: "0.7em",
    fontWeight: 600,
    padding: "1px 6px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-primary)",
    color: "var(--md-sys-color-on-primary)",
    whiteSpace: "nowrap",
  },
});

const Remember = styled("label", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    fontSize: "0.85em",
    cursor: "pointer",
  },
});

const DesktopChip = styled("span", {
  base: {
    fontSize: "0.7em",
    fontWeight: 600,
    padding: "1px 6px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-secondary-container)",
    color: "var(--md-sys-color-on-secondary-container)",
    whiteSpace: "nowrap",
  },
});

// Unit spec for the moderator-move client gate (AFK plan, 2026-09-22).
//   node --test --conditions=browser components/rtc/movePolicy.test.ts
//
// Focus: which SESSION acts on a `UserMoveVoiceChannel` event. The backend
// sends it privately to the moved user and `EventV1::private` reaches every
// session that user has, off-call devices included, so half the interesting
// cases are "a device that should stay put was told about a move". The other
// half is the mirror image and is easy to get wrong in the opposite
// direction: the eviction can still reach the client ahead of the event, so
// the real target is no longer CONNECTED when the move lands and a naive gate
// ignores it — silently leaving the member in no call at all. Addressing
// therefore asks which session WAS in `from`, recently, and both halves are
// pinned below.
//
// 🔴 The device the token was minted for is the only unforgeable signal here,
// and it is ABSENT on most seats. An identity is device-qualified only when
// the client asked for one: `create_token` falls back to the bare `user.id`
// otherwise, and `#connectAttempt` asks only when `callEncryptionCapable`
// holds. Web, the Electron/Linux shell and every unenrolled user therefore
// join bare, and the event they receive carries no device at all. So the
// spec below is organized around three populations, not two: verified
// sessions, sessions verified to be someone ELSE's, and sessions that cannot
// be verified either way. The third is the largest and gets its own outcome —
// `fail-loud` / `unverified-session` — because both silent answers available
// to it are wrong: ignoring strands the real target in no call, and moving
// lets an idle seat that was merely force-disconnected by a handoff publish a
// microphone into a room nobody is sitting at.
//
// 🔴 There are TWO windows and the spec pins both edges of each. Inside
// `MOVE_VERIFIED_WINDOW_MS` a marker can still buy a move; between there and
// `MOVE_NOTICE_WINDOW_MS` it buys only a `stale-notice` toast, because the
// token is past relying on but the session's own rejoin loop is still
// dialling the OLD channel back and would reverse the moderator in silence;
// past the outer
// bound the marker means nothing and the session goes quiet like any other
// bystander.
//
// The precedence tests matter more than the branch tests: addressing is
// decided before feasibility, so an idle phone that also cannot resolve the
// destination must stay SILENT rather than raise an error about a call it is
// not in. The time constants are pinned against the token's real TTL — as a
// THREE-term sum, because the window alone is measured from the client's own
// drop clock and not from the mint, and `MOVE_TOKEN_SKEW_ALLOWANCE_MS` is the
// reservation for the difference.
//
// 🔴 Every assertion calls `moveDecision`. Nothing here re-types the rule it
// is checking — a spec that restates its subject passes a revert.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type MoveDecision,
  MOVE_NOTICE_WINDOW_MS,
  MOVE_PRECONNECT_BUDGET_MS,
  MOVE_TOKEN_SKEW_ALLOWANCE_MS,
  MOVE_VERIFIED_WINDOW_MS,
  moveDecision,
} from "./movePolicy.ts";

const FROM = "01JFROMCHANNELAAAAAAAAAAAA";
const TO = "01JTOCHANNELAAAAAAAAAAAAAA";
const ELSEWHERE = "01JELSEWHERECHANNELAAAAAAA";
const NODE_URL = "wss://voice-eu.example.invalid";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.move-token.signature";
/** The device the server minted the token for, and one that it did not. */
const DEVICE = "01JDESKTOPDEVICEAAAAAAAAAA";
const OTHER_DEVICE = "01JPHONEDEVICEAAAAAAAAAAAA";
/** A fixed "now", so no assertion below depends on the wall clock. */
const NOW = 1_758_000_000_000;

/**
 * A move that is valid in every respect, for the named field to spoil. The
 * default world's two device ids MATCH, so every pre-existing case below is
 * asserting what it always was and not quietly passing on `other-device`.
 */
const decide = (world: Partial<Parameters<typeof moveDecision>[0]> = {}) =>
  moveDecision({
    callState: "CONNECTED",
    currentChannelId: FROM,
    from: FROM,
    to: TO,
    url: NODE_URL,
    token: TOKEN,
    destinationKnown: true,
    lastInvoluntaryChannelId: undefined,
    lastInvoluntaryLeftAt: undefined,
    deviceId: DEVICE,
    sessionDeviceId: DEVICE,
    now: NOW,
    ...world,
  });

/** The decision the default world produces, spelled out once. */
const MOVED: MoveDecision = {
  action: "move",
  url: NODE_URL,
  token: TOKEN,
  to: TO,
};

/** A session the SFU dropped from `channel` `agoMs` milliseconds ago. */
const droppedFrom = (channel: string, agoMs: number) => ({
  lastInvoluntaryChannelId: channel,
  lastInvoluntaryLeftAt: NOW - agoMs,
});

/**
 * A seat that joined with a BARE LiveKit identity — web, the Electron/Linux
 * shell, an unenrolled user — so the event names no device and this session
 * presented none. The common case, not the exotic one.
 */
const UNVERIFIED = { deviceId: undefined, sessionDeviceId: undefined };

/** Not connected to anything, which is what the marker steps require. */
const OFF_CALL = { callState: "DISCONNECTED", currentChannelId: undefined };

/** Halfway between the two windows: too late to act, worth telling. */
const STALE_MS = (MOVE_VERIFIED_WINDOW_MS + MOVE_NOTICE_WINDOW_MS) / 2;

test("step 1 — a token minted for another device is ignored by a session in `from`", () => {
  // Step 3 on its own is not enough. LiveKit identities are `user:device`, so
  // when `forceDisconnect` is false two of one user's sessions can sit in the
  // SAME channel; both then satisfy "I am CONNECTED to `from`" and both would
  // redeem a token minted once for one identity. LiveKit settles that by
  // evicting one on duplicate identity, and the loser may be the session the
  // user is actually sitting in front of.
  assert.deepEqual(
    decide({ deviceId: DEVICE, sessionDeviceId: OTHER_DEVICE }),
    {
      action: "ignore",
      reason: "other-device",
    },
  );
});

test("step 1 — a token minted for another device is ignored by a dropped session", () => {
  // The marker steps are the claimable half: an involuntary drop from `from`
  // is an ordinary event, not a signature. Same world as the "just removed
  // from the source channel MOVES" case below — only the device differs. Note
  // this is `other-device` and NOT `unverified-session`: the device is known,
  // it is simply not ours, so there is nothing unresolved to tell the user
  // about.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      deviceId: DEVICE,
      sessionDeviceId: OTHER_DEVICE,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "other-device" },
  );
});

test("step 1 — a session with no device of its own cannot claim a named token", () => {
  // The server named a device; this session cannot show it is that one. It
  // must not be allowed to read its own ignorance as a match — that is the
  // `undefined === undefined` hole this case is deliberately separated from.
  // Half-known is `other-device`, not `unverified-session`: the event's own
  // device is known, so SOMEBODY can be verified, and it is not us.
  assert.deepEqual(decide({ deviceId: DEVICE, sessionDeviceId: undefined }), {
    action: "ignore",
    reason: "other-device",
  });
});

test("🔴 step 1 outranks every other rule in the module", () => {
  // PRECEDENCE, not a branch. A device the token was not minted for must stay
  // SILENT whatever else is true of the world: it is entitled neither to an
  // error toast about a call it is not in, nor to the `already-there` no-op
  // that would otherwise read as "this session was addressed", nor to the
  // `unverified-session` or `stale-notice` cards — those outcomes exist for
  // seats that cannot be judged or cannot act, and this one has been judged.
  for (const spoiled of [
    { from: FROM, to: FROM, currentChannelId: FROM },
    { destinationKnown: false },
    { url: undefined },
    { destinationKnown: false, url: "   ", from: FROM, to: FROM },
    { ...OFF_CALL, ...droppedFrom(FROM, 250) },
    { ...OFF_CALL, ...droppedFrom(FROM, STALE_MS) },
    { ...OFF_CALL, destinationKnown: false, ...droppedFrom(FROM, 250) },
  ])
    assert.deepEqual(
      decide({ ...spoiled, deviceId: DEVICE, sessionDeviceId: OTHER_DEVICE }),
      { action: "ignore", reason: "other-device" },
    );
});

test("step 2 — from === to is already-there, even when everything else is valid", () => {
  // Redeeming a token for the room we are already in is a reconnect: it
  // tears down a healthy room and re-races our own identity for nothing.
  assert.deepEqual(decide({ from: FROM, to: FROM, currentChannelId: FROM }), {
    action: "ignore",
    reason: "already-there",
  });
});

test("🔴 step 2 outranks BOTH loud arms, and that is a ruling, not an accident", () => {
  // PRECEDENCE, and it was an open question until it was decided. An earlier
  // cut of this ladder put `already-there` below the loud arms, so a session
  // holding a marker it could not verify — or one past the acceptance window —
  // got a card for a `from === to` event.
  //
  // The ruling: when `from === to` NOTHING WAS MOVED, so every loud arm's copy
  // ("a moderator moved you to another voice channel…") is a plain false
  // statement made to a session sitting exactly where it already was. What is
  // given up is a Rejoin button pointing at the channel this session was
  // dropped from, which is marginal; honesty about what happened is not. It
  // cannot occur in practice either — `member_edit` answers `AlreadyPresent`
  // for `from === to` and emits no event — so this is defensive ordering, and
  // defensive code should fail quiet and true over loud and false.
  const alreadyThere = { from: FROM, to: FROM };
  // Against `unverified-session`: a bare seat with a fresh marker.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...alreadyThere,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "already-there" },
  );
  // Against `stale-notice`, on both populations it covers.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...alreadyThere,
      ...droppedFrom(FROM, STALE_MS),
    }),
    { action: "ignore", reason: "already-there" },
  );
  assert.deepEqual(
    decide({ ...OFF_CALL, ...alreadyThere, ...droppedFrom(FROM, STALE_MS) }),
    { action: "ignore", reason: "already-there" },
  );
  // And against the feasibility answers, which it has always outranked.
  assert.deepEqual(
    decide({
      ...alreadyThere,
      currentChannelId: FROM,
      destinationKnown: false,
      url: undefined,
    }),
    { action: "ignore", reason: "already-there" },
  );
  // Including for the session that really was removed: redeeming the token
  // would rejoin the room we were just taken out of, which is not what the
  // moderator asked for.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...alreadyThere, ...droppedFrom(FROM, 250) }),
    { action: "ignore", reason: "already-there" },
  );
});

test("step 3 — being CONNECTED to the source is what the first addressed shape tests", () => {
  // The computation, pinned by its two failure modes: the right channel in the
  // wrong state, and the right state in the wrong channel. Neither is step 3,
  // and with no drop marker in play neither is addressed at all.
  assert.deepEqual(decide({ currentChannelId: ELSEWHERE }), {
    action: "ignore",
    reason: "other-channel",
  });
  assert.deepEqual(decide({ callState: "CONNECTING" }), {
    action: "ignore",
    reason: "not-in-call",
  });
  // And the positive: exactly the two together.
  assert.deepEqual(
    decide({ callState: "CONNECTED", currentChannelId: FROM }),
    MOVED,
  );
});

test("step 3 — a session CONNECTED to the source goes on to the feasibility tests", () => {
  // Addressed means "keep going", not "move": the feasibility answers are
  // reachable from the connected shape too, and they are LOUD.
  assert.deepEqual(decide(), MOVED);
  assert.deepEqual(decide({ destinationKnown: false }), {
    action: "fail-loud",
    reason: "unknown-channel",
  });
});

test("the drop marker needs channel, a timestamp and the notice window together", () => {
  // The claim the marker steps rest on. Each of its three inputs falsifies it
  // alone, on an otherwise VERIFIED session, and falsifying it drops the
  // session all the way to step 7 — not to `stale-notice`, which is about a
  // marker that exists and is merely late.
  const worlds = [
    // Wrong channel.
    { ...OFF_CALL, ...droppedFrom(ELSEWHERE, 250) },
    // Past the outer bound: the marker has stopped meaning anything.
    { ...OFF_CALL, ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS) },
    // Half a marker is not a marker: an absent `leftAt` must not be read as
    // "just now" via some arithmetic on `undefined`.
    {
      ...OFF_CALL,
      lastInvoluntaryChannelId: FROM,
      lastInvoluntaryLeftAt: undefined,
    },
  ];
  for (const world of worlds)
    assert.deepEqual(decide(world), {
      action: "ignore",
      reason: "not-in-call",
    });
  // All three together and the same session is addressed — so the cases above
  // are about the marker and not about some other spoiled field.
  assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, 250) }), MOVED);
});

test("step 4 — a dropped session that MATCHES the token's device is addressed", () => {
  // The bug this gate was rewritten for. `move_user_to_voice_channel` used to
  // call `voice_client.remove_user(...)` first and publish
  // `UserMoveVoiceChannel` only afterwards, which lost this race every single
  // time; it now publishes the event BEFORE the eviction, and says so at the
  // call site. The race is no longer guaranteed — but it is not gone. The two
  // legs leave delta at nearly the same instant by different routes (Redis ->
  // bonfire -> socket for the event, a LiveKit RPC and a `Leave` down our
  // signalling socket for the eviction), so the `Leave` can still win on
  // jitter. When it does, `PARTICIPANT_REMOVED` is in
  // `NO_REJOIN_DISCONNECT_REASONS` and puts us in DISCONNECTED before the
  // move lands, and a gate that demanded CONNECTED would ignore the REAL
  // target in silence, leaving the member in no call at all.
  assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, 250) }), MOVED);
  // Feasibility is reachable from the marker shape as well: if the widened
  // rule only ever produced `move` and never `fail-loud`, the most common
  // shape of a real move — DISCONNECTED because the SFU removed us — would
  // fail silently.
  assert.deepEqual(
    decide({ ...OFF_CALL, destinationKnown: false, ...droppedFrom(FROM, 250) }),
    { action: "fail-loud", reason: "unknown-channel" },
  );
  assert.deepEqual(
    decide({ ...OFF_CALL, url: "   ", ...droppedFrom(FROM, 250) }),
    { action: "fail-loud", reason: "no-url" },
  );
});

test("🔴 step 5 — a dropped session that cannot show its device fails LOUD", () => {
  // The heart of the rule. This seat joined bare, so the event names no
  // device and neither does the session: the marker's claim ("the SFU just
  // removed me from `from`") can be neither confirmed nor denied here.
  //
  // It must not be silently honoured — an idle seat that was merely
  // force-disconnected by a handoff holds exactly this marker, and honouring
  // it lets that seat redeem the token and publish a microphone into a room
  // nobody is sitting at. It must not be silently dropped either — the seat
  // that really was moved would then land in no call at all, which is the
  // shipped bug this slice exists to repair.
  //
  // So it is LOUD: the destination is carded and Rejoin is one click away.
  // That is a manual move where a device-qualified seat gets an automatic one,
  // and it is accepted deliberately until the addressing label stops being the
  // E2EE device id.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...UNVERIFIED, ...droppedFrom(FROM, 250) }),
    {
      action: "fail-loud",
      reason: "unverified-session",
    },
  );
  // The fail-open rejoin shape reaches it too: `shouldAutoRejoin` is a
  // deny-list, so an absent or unrecognised disconnect reason leaves us
  // RECONNECTING and dialling the OLD channel back.
  assert.deepEqual(
    decide({
      callState: "RECONNECTING",
      currentChannelId: FROM,
      ...UNVERIFIED,
      ...droppedFrom(FROM, 1_000),
    }),
    { action: "fail-loud", reason: "unverified-session" },
  );
});

test("🔴 step 5 never answers `move`, on any spoiling of the rest of the world", () => {
  // The property, separated from the branch: whatever else is true, an
  // unverifiable session holding a fresh marker does not redeem the token. If
  // this ever goes green on a `move` the forgery is back.
  for (const spoiled of [
    {},
    { to: TO },
    { destinationKnown: false },
    { url: undefined },
    { url: ` ${NODE_URL} ` },
    { token: "" },
    { callState: "IDLE" },
    { currentChannelId: ELSEWHERE },
  ]) {
    const decision = decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...droppedFrom(FROM, 250),
      ...spoiled,
    });
    assert.notEqual(decision.action, "move");
    assert.deepEqual(decision, {
      action: "fail-loud",
      reason: "unverified-session",
    });
  }
});

test("🔴 step 6 — a marker past the verified window is a stale-notice, on BOTH populations", () => {
  // ONE arm, TWO causes, and both of them used to be silent on one side of
  // the tree or the other.
  //
  // The verified-but-late session could prove the token named it and was
  // ignored anyway; `state.tsx` grew its own copy of the addressing predicate
  // beside the call to rescue it, which put half the rule where no spec could
  // reach it. The unverifiable-and-late session got nothing at all.
  //
  // Both are wrong for the same reason: their drop fails OPEN in
  // `shouldAutoRejoin` whenever the SDK reports no reason, so they are already
  // dialling `from` back on the 1 s / 2 s / 4 s ladder. Silence hands the user
  // the old channel and tells nobody a moderator's decision was undone.
  //
  // Past the verified window the device distinction buys nothing — no move is
  // going to be attempted either way, because the token can no longer be
  // relied on to outlive the connect — so the two populations get the same
  // answer and the same copy.
  assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, STALE_MS) }), {
    action: "fail-loud",
    reason: "stale-notice",
  });
  assert.deepEqual(
    decide({ ...OFF_CALL, ...UNVERIFIED, ...droppedFrom(FROM, STALE_MS) }),
    { action: "fail-loud", reason: "stale-notice" },
  );
  // The half-known shape the other way round — the event named no device, this
  // session has one — lands in the same arm: there is still nothing to
  // compare, and nothing left to compare it for.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      deviceId: undefined,
      sessionDeviceId: DEVICE,
      ...droppedFrom(FROM, STALE_MS),
    }),
    { action: "fail-loud", reason: "stale-notice" },
  );
  // And the fail-open RECONNECTING shape, which is the one actually dialling
  // the old channel back while this is decided.
  assert.deepEqual(
    decide({
      callState: "RECONNECTING",
      currentChannelId: FROM,
      ...droppedFrom(FROM, STALE_MS),
    }),
    { action: "fail-loud", reason: "stale-notice" },
  );
});

test("🔴 step 6 never answers `move`, and outranks the feasibility answers", () => {
  // The same two duties step 5 carries. A session past the acceptance window
  // must not redeem a dead token, and must not be told `unknown-channel` or
  // `no-url` either — those read as "you were moved and something broke",
  // when what is true is that the notice arrived too late to follow.
  for (const spoiled of [
    {},
    { destinationKnown: false },
    { url: undefined },
    { url: "   " },
    { destinationKnown: false, url: undefined },
    { token: "" },
  ])
    for (const devices of [{}, UNVERIFIED]) {
      const decision = decide({
        ...OFF_CALL,
        ...devices,
        ...droppedFrom(FROM, STALE_MS),
        ...spoiled,
      });
      assert.notEqual(decision.action, "move");
      assert.deepEqual(decision, {
        action: "fail-loud",
        reason: "stale-notice",
      });
    }
});

test("step 7 — anything else is a silent ignore, and it names which kind", () => {
  // 🔴 The whole reason this module exists. A phone in a pocket and a spare
  // browser tab both receive this event. Acting on it would join them to a
  // call they were never in and publish their microphone — and since the
  // token is minted once for one identity, the two redemptions race and
  // LiveKit evicts one of them on duplicate identity. Such a device has no
  // involuntary-drop marker at all, so no step from 3 to 6 can reach it: it is
  // silent, as it must be.
  for (const callState of ["DISCONNECTED", "CONNECTING", "RECONNECTING"]) {
    assert.deepEqual(
      decide({
        callState,
        currentChannelId: undefined,
        lastInvoluntaryChannelId: undefined,
        lastInvoluntaryLeftAt: undefined,
      }),
      { action: "ignore", reason: "not-in-call" },
    );
  }
  // Connected, just not to this one, is the other half of the same step.
  assert.deepEqual(decide({ currentChannelId: ELSEWHERE }), {
    action: "ignore",
    reason: "other-channel",
  });
  // Including when a marker exists but is past the OUTER bound — a drop from
  // hours ago must not card a move the session had no part in, and by then it
  // is an ordinary bystander again on both device populations.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS) }),
    { action: "ignore", reason: "not-in-call" },
  );
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS),
    }),
    { action: "ignore", reason: "not-in-call" },
  );
});

test("🔴 the web-handoff forgery is refused: an unverified idle seat never MOVES", () => {
  // The scenario that made step 5 necessary, concretely, on the seats where
  // the device test is INERT.
  //
  // A user is in `from` on the web. They pick the call up on a second device:
  // `Channel.joinCall` defaults `forceDisconnect = true`, so the server evicts
  // the web seat, which records an involuntary drop from `from` and goes
  // DISCONNECTED — holding exactly the marker step 4 looks for, through no
  // moderator's doing at all.
  //
  // Moments later a move out of `from` lands — a moderator, or the AFK sweep,
  // which is a TIMER, so sooner or later one does land inside the window. Both
  // sessions receive it, because the topic is private to the user. Neither
  // joined with a device-qualified identity, so the event names no device and
  // the old fallback would let BOTH act: the new seat under step 3, the idle
  // web seat under step 4. Both redeem a token minted ONCE for identity
  // `{user}`, LiveKit evicts one on duplicate identity, and the survivor can be
  // the unattended seat — joining the destination and publishing a microphone
  // into a room nobody is sitting at.
  const secondSeat = decide({
    callState: "CONNECTED",
    currentChannelId: FROM,
    ...UNVERIFIED,
  });
  const idleWebSeat = decide({
    ...OFF_CALL,
    ...UNVERIFIED,
    ...droppedFrom(FROM, 500),
  });
  // The seat actually in `from` moves: with a bare identity step 3 is EXACT,
  // because two sessions cannot hold one bare identity in one room.
  assert.deepEqual(secondSeat, MOVED);
  // The idle one does not move. It is told, loudly, and publishes nothing.
  assert.notEqual(idleWebSeat.action, "move");
  assert.deepEqual(idleWebSeat, {
    action: "fail-loud",
    reason: "unverified-session",
  });
});

test("🔴 a desktop-to-phone handoff cannot forge the addressing rule", () => {
  // The same shape on seats that DO carry a device, where step 1 catches it
  // first and does so silently — the idle desktop is not merely unverifiable,
  // it has been positively excluded, so it gets no card either.
  const phone = decide({
    callState: "CONNECTED",
    currentChannelId: FROM,
    deviceId: OTHER_DEVICE,
    sessionDeviceId: OTHER_DEVICE,
  });
  const idleDesktop = decide({
    ...OFF_CALL,
    deviceId: OTHER_DEVICE,
    sessionDeviceId: DEVICE,
    ...droppedFrom(FROM, 500),
  });
  // Exactly one session acts, and it is the one the token was minted for.
  assert.deepEqual(phone, MOVED);
  assert.deepEqual(idleDesktop, {
    action: "ignore",
    reason: "other-device",
  });
});

test("🔴 an UNVERIFIED session CONNECTED to the source still MOVES", () => {
  // The case that must not regress, and the reason step 5 is scoped to the
  // marker shape alone. Web, the Electron/Linux shell and every unenrolled
  // user join bare; if being unverifiable were disqualifying in itself, a
  // moderator moving any of them would silently do nothing on the client and
  // the whole feature would be dead for most of the install base.
  //
  // Step 3 does not need the device test to be exact HERE: a bare identity is
  // `{user}`, and two sessions of one user cannot both hold it in `from` at
  // once — LiveKit would already have evicted one on duplicate identity. Being
  // in `from` right now is therefore proof enough by itself.
  assert.deepEqual(decide(UNVERIFIED), MOVED);
  // Same for the half-known shape the other way round: the event named no
  // device, this session has one. Nothing to compare, and step 3 holds.
  assert.deepEqual(
    decide({ deviceId: undefined, sessionDeviceId: DEVICE }),
    MOVED,
  );
  // And it reaches the LOUD feasibility answers like any other addressed
  // session — it is addressed, not merely tolerated.
  assert.deepEqual(decide({ ...UNVERIFIED, destinationKnown: false }), {
    action: "fail-loud",
    reason: "unknown-channel",
  });
});

test("🔴 the VERIFIED window's far edge moves; the boundary itself is a stale-notice", () => {
  // The window is now sized by the token's life — minus the budget and minus
  // the unmeasured mint/handshake skew — rather than by a forgery surface, so
  // the far edge is a place a real move can legitimately land. One
  // millisecond inside, the session moves; AT the boundary the token can no
  // longer be relied on to survive the connect and the answer flips to the
  // toast — not to silence, which is the gap this arm closes.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS - 1) }),
    MOVED,
  );
  // The comparison is strict `<`, so the instant the window elapses the
  // answer flips — and stays flipped for the whole of the notice window.
  for (const ago of [
    MOVE_VERIFIED_WINDOW_MS,
    MOVE_VERIFIED_WINDOW_MS + 1,
    MOVE_NOTICE_WINDOW_MS - 1,
  ])
    assert.deepEqual(decide({ ...OFF_CALL, ...droppedFrom(FROM, ago) }), {
      action: "fail-loud",
      reason: "stale-notice",
    });
  // The unverified seat's card changes copy on exactly the same clock.
  // Compared whole rather than by `.reason`: the action is half the answer,
  // and reaching for the reason alone would not distinguish a card from a
  // move.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS - 1),
    }),
    { action: "fail-loud", reason: "unverified-session" },
  );
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      ...droppedFrom(FROM, MOVE_VERIFIED_WINDOW_MS),
    }),
    { action: "fail-loud", reason: "stale-notice" },
  );
});

test("🔴 the NOTICE window's boundary goes silent, on both device populations", () => {
  // The outer bound, and the only thing that ever expires the marker —
  // `state.tsx` clears it on `connect()` and on `connected` and nowhere else,
  // so a session that goes offline and never comes back holds it forever. A
  // laptop woken after eight hours must not card a move that landed on the
  // user's phone while it was asleep.
  assert.deepEqual(
    decide({ ...OFF_CALL, ...droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS - 1) }),
    { action: "fail-loud", reason: "stale-notice" },
  );
  // Strict `<` here too: AT the bound, and past it, silence.
  for (const ago of [
    MOVE_NOTICE_WINDOW_MS,
    MOVE_NOTICE_WINDOW_MS + 1,
    8 * 60 * 60 * 1_000,
  ])
    for (const devices of [{}, UNVERIFIED])
      assert.deepEqual(
        decide({ ...OFF_CALL, ...devices, ...droppedFrom(FROM, ago) }),
        { action: "ignore", reason: "not-in-call" },
      );
});

test("🔴 a verified session rejoining the OLD channel after the drop still MOVES", () => {
  // The fail-open half. `shouldAutoRejoin` is a deny-list, so when the SDK
  // reports the removal with an absent or unrecognised reason we go
  // RECONNECTING and start dialling `from` back. Ignoring the move here
  // would let the rejoin loop silently undo the moderator's decision.
  assert.deepEqual(
    decide({
      callState: "RECONNECTING",
      currentChannelId: FROM,
      ...droppedFrom(FROM, 1_000),
    }),
    MOVED,
  );
});

test("🔴 a session CONNECTED elsewhere is not addressed by a stale marker", () => {
  // Precisely why the marker terms are gated on `callState !== "CONNECTED"`.
  // This device was dropped from `from`, joined another call within the
  // window, and is now happily in it. Without the gate the stale marker would
  // yank it out of the call it is actually in to redeem a move it has already
  // moved past — a moderator's action reaching backwards through a call the
  // user chose afterwards.
  assert.deepEqual(
    decide({
      callState: "CONNECTED",
      currentChannelId: ELSEWHERE,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "other-channel" },
  );
  // The same on a bare seat: `CONNECTED` retires the marker before step 5 can
  // see it, so this is a silent ignore and not a card.
  assert.deepEqual(
    decide({
      callState: "CONNECTED",
      currentChannelId: ELSEWHERE,
      ...UNVERIFIED,
      ...droppedFrom(FROM, 250),
    }),
    { action: "ignore", reason: "other-channel" },
  );
  // And it retires the marker for step 6 too, at every age inside the notice
  // window — a session in a healthy call somewhere else gets no toast about a
  // channel it left of its own accord.
  for (const ago of [250, STALE_MS, MOVE_NOTICE_WINDOW_MS - 1])
    assert.deepEqual(
      decide({
        callState: "CONNECTED",
        currentChannelId: ELSEWHERE,
        ...droppedFrom(FROM, ago),
      }),
      { action: "ignore", reason: "other-channel" },
    );
});

test("an unrecognised call state is not treated as connected", () => {
  // Step 3 is `=== "CONNECTED"`, not a deny-list: a state string this module
  // has never heard of must not fall through into a join on its own.
  assert.deepEqual(
    decide({
      callState: "IDLE",
      currentChannelId: undefined,
      lastInvoluntaryChannelId: undefined,
      lastInvoluntaryLeftAt: undefined,
    }),
    { action: "ignore", reason: "not-in-call" },
  );
  // And conversely it is not treated as connected on the way OUT either: an
  // unknown state with a fresh drop marker is addressed, because whatever
  // that state is, it is not us sitting in a healthy room somewhere else.
  assert.deepEqual(
    decide({
      callState: "IDLE",
      currentChannelId: undefined,
      ...droppedFrom(FROM, 250),
    }),
    MOVED,
  );
});

test("a connected session with no channel id still ignores", () => {
  assert.deepEqual(decide({ currentChannelId: undefined }), {
    action: "ignore",
    reason: "other-channel",
  });
});

test("🔴 an off-call session that also cannot resolve the move stays SILENT", () => {
  // PRECEDENCE, not a branch. Off-call AND unknown destination AND no URL:
  // all three rules apply and only the first may answer. If `fail-loud` ever
  // wins here, one move raises an error toast on every signed-in device the
  // user owns, each about a call that device is not in.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      destinationKnown: false,
      url: undefined,
    }),
    { action: "ignore", reason: "not-in-call" },
  );
  // Silent for a bare seat too, as long as it holds no marker for `from`:
  // steps 5 and 6 are about an unresolvable or late CLAIM, not about being
  // unverifiable.
  assert.deepEqual(
    decide({
      ...OFF_CALL,
      ...UNVERIFIED,
      destinationKnown: false,
      url: undefined,
    }),
    { action: "ignore", reason: "not-in-call" },
  );
});

test("🔴 a session in another channel outranks both failure reasons too", () => {
  // The second addressing test has the same precedence duty as the first: a
  // device in an unrelated call is no more entitled to the error than an
  // idle one.
  assert.deepEqual(
    decide({
      currentChannelId: ELSEWHERE,
      destinationKnown: false,
      url: "",
    }),
    { action: "ignore", reason: "other-channel" },
  );
});

test("🔴 step 5 outranks unknown-channel and no-url", () => {
  // PRECEDENCE, and it decides WHICH loud answer the user gets. A session
  // that cannot prove it was the target must not be told why it failed to
  // carry out a move it was never allowed to carry out: `unknown-channel` and
  // `no-url` both read as "you were moved and something broke", which for an
  // idle seat holding a handoff's marker is a lie. The reason must stay the
  // one that is true — we cannot tell whether this was you.
  for (const spoiled of [
    { destinationKnown: false },
    { url: undefined },
    { url: "   " },
    { destinationKnown: false, url: undefined },
  ])
    assert.deepEqual(
      decide({
        ...OFF_CALL,
        ...UNVERIFIED,
        ...droppedFrom(FROM, 250),
        ...spoiled,
      }),
      { action: "fail-loud", reason: "unverified-session" },
    );
});

test("unknown-channel is reported before no-url", () => {
  // Both spoiled: the more specific answer wins, and a client that cannot
  // resolve the channel would not have a node URL to resolve either.
  assert.deepEqual(decide({ destinationKnown: false, url: undefined }), {
    action: "fail-loud",
    reason: "unknown-channel",
  });
});

test("an absent, empty or whitespace-only URL fails loud as no-url", () => {
  // A blank node URL reaches `room.connect()` as a malformed endpoint and
  // fails far from here with an SDK error that names nothing.
  for (const url of [undefined, "", "   ", "\t\n"]) {
    assert.deepEqual(decide({ url }), {
      action: "fail-loud",
      reason: "no-url",
    });
  }
});

test("the happy path moves and carries url, token and to through unchanged", () => {
  // The decision does not normalize: whatever `state.tsx` resolved is what
  // `room.connect()` is handed.
  assert.deepEqual(decide(), MOVED);
});

test("a padded but non-empty URL is passed through verbatim, not trimmed", () => {
  // The emptiness test uses `trim()`, which must not leak into the payload:
  // silently rewriting a connect URL would hide a malformed node row.
  const padded = ` ${NODE_URL} `;
  assert.deepEqual(decide({ url: padded }), {
    action: "move",
    url: padded,
    token: TOKEN,
    to: TO,
  });
});

test("an empty token still moves — emptiness is the server's to report", () => {
  // Only the URL is checked for usability. A token this client cannot judge
  // is rejected by the SFU with a real reason; guessing here would turn an
  // authoritative refusal into a vague local one.
  assert.deepEqual(decide({ token: "" }), {
    action: "move",
    url: NODE_URL,
    token: "",
    to: TO,
  });
});

test("the decision is exhaustive — every world answers with one of three actions", () => {
  // Cartesian sweep: no combination falls off the end or returns undefined.
  const actions = new Set<MoveDecision["action"]>();
  const reasons = new Set<string>();
  const markers = [
    { lastInvoluntaryChannelId: undefined, lastInvoluntaryLeftAt: undefined },
    { lastInvoluntaryChannelId: FROM, lastInvoluntaryLeftAt: undefined },
    droppedFrom(FROM, 250),
    droppedFrom(FROM, STALE_MS),
    droppedFrom(FROM, MOVE_NOTICE_WINDOW_MS),
    droppedFrom(ELSEWHERE, 250),
  ];
  // Every shape of device knowledge, including the two half-known ones.
  const devices = [
    { deviceId: DEVICE, sessionDeviceId: DEVICE },
    { deviceId: DEVICE, sessionDeviceId: OTHER_DEVICE },
    { deviceId: undefined, sessionDeviceId: DEVICE },
    { deviceId: DEVICE, sessionDeviceId: undefined },
    { deviceId: undefined, sessionDeviceId: undefined },
  ];
  for (const callState of ["CONNECTED", "DISCONNECTED", "RECONNECTING"]) {
    for (const currentChannelId of [FROM, ELSEWHERE, undefined]) {
      for (const to of [TO, FROM]) {
        for (const url of [NODE_URL, undefined, "  "]) {
          for (const destinationKnown of [true, false]) {
            for (const marker of markers) {
              for (const device of devices) {
                const decision = moveDecision({
                  callState,
                  currentChannelId,
                  from: FROM,
                  to,
                  url,
                  token: TOKEN,
                  destinationKnown,
                  now: NOW,
                  ...device,
                  ...marker,
                });
                assert.ok(
                  ["ignore", "fail-loud", "move"].includes(decision.action),
                  `unexpected action ${decision.action}`,
                );
                actions.add(decision.action);
                if (decision.action !== "move") reasons.add(decision.reason);
              }
            }
          }
        }
      }
    }
  }
  // All three are reachable, so the sweep is not vacuously passing on one.
  assert.deepEqual([...actions].sort(), ["fail-loud", "ignore", "move"]);
  // And every named reason is reachable — a reason no world can produce is
  // either dead code or a branch that was quietly rewired. All EIGHT: the
  // four `ignore` kinds and the four `fail-loud` ones. A branch pointed at a
  // reason nothing can reach fails HERE and nowhere else.
  assert.deepEqual([...reasons].sort(), [
    "already-there",
    "no-url",
    "not-in-call",
    "other-channel",
    "other-device",
    "stale-notice",
    "unknown-channel",
    "unverified-session",
  ]);
  assert.equal(reasons.size, 8);
});

test("🔴 the pre-connect budget stays well inside the token's 10 s TTL", () => {
  // 10_000 is the token TTL: `.with_ttl(Duration::from_secs(10))` in
  // `crates/core/database/src/voice/voice_client.rs`. The move path is handed
  // a token that is already ticking, so a budget at or past the TTL cannot
  // buy patience — it only moves the failure later and disguises an expired
  // token as a network fault. Raising it past this bound must fail here.
  assert.ok(
    MOVE_PRECONNECT_BUDGET_MS < 10_000,
    `budget ${MOVE_PRECONNECT_BUDGET_MS}ms is not inside the 10_000ms token TTL`,
  );
  // And it must leave room for the connect handshake itself, not just squeak
  // under the TTL.
  assert.ok(MOVE_PRECONNECT_BUDGET_MS <= 5_000);
  assert.ok(MOVE_PRECONNECT_BUDGET_MS > 0);
});

test("🔴 the verified window, the budget and the skew allowance fit inside the token TTL", () => {
  // THE invariant, and it is deliberately NOT the one this test used to
  // assert. The old form pinned `window + budget <= 10_000` alongside
  // `window === 7_000` — that is `TTL - budget`, and it is measured from the
  // wrong epoch at BOTH ends, which is why the number is smaller now:
  //
  //   - The window is counted from `#lastInvoluntaryLeftAt`, the instant the
  //     SFU's `Leave` landed on THIS client. That is strictly later than the
  //     mint. `move_user_to_voice_channel`
  //     (`crates/core/database/src/voice/mod.rs`) mints the token, THEN
  //     releases any remote-control grant, THEN publishes the private event,
  //     and only THEN calls `remove_user` — the RPC whose `Leave` starts our
  //     clock. All of that is already spent at marker age zero, so a marker
  //     age of N ms is a token age of N + (mint -> Leave) ms — the first of
  //     the two spans the allowance reserves. The marker can never run early.
  //   - `MOVE_PRECONNECT_BUDGET_MS` bounds only the work BEFORE
  //     `room.connect()`, but the SFU validates the JWT at the END of the
  //     handshake: the signaling round trip, ICE and DTLS all sit outside the
  //     budget. Reaching `connect()` in time is not being ACCEPTED in time.
  //
  // So headroom under `TTL - budget` is NEGATIVE by the sum of the two, and
  // the old 7_000 could be spent: a marker accepted at ~6.5 s whose budget
  // went on a stalled `Room.getLocalDevices` reached the SFU past
  // T_mint + 10 s and was refused — a doomed connect and an error modal, where
  // a `stale-notice` would have carded the same destination with the same
  // Rejoin button, sooner. `MOVE_TOKEN_SKEW_ALLOWANCE_MS` reserves both spans.
  //
  // 🔴 Do not re-derive 7_000 from `TTL - budget`. That derivation is the
  // defect; it is pinned as a three-term sum here so no single term can be
  // raised without another being lowered.
  const spent =
    MOVE_VERIFIED_WINDOW_MS +
    MOVE_PRECONNECT_BUDGET_MS +
    MOVE_TOKEN_SKEW_ALLOWANCE_MS;
  assert.ok(
    spent <= 10_000,
    `window + budget + skew is ${spent}ms, past the 10_000ms token TTL`,
  );
  // And the window IS the remainder, not merely something that fits under it:
  // written any other way, a term that moves leaves slack or overdraft that
  // nobody re-derived.
  assert.equal(
    MOVE_VERIFIED_WINDOW_MS,
    10_000 - MOVE_PRECONNECT_BUDGET_MS - MOVE_TOKEN_SKEW_ALLOWANCE_MS,
    `the verified window is no longer TTL - budget - skew: ${MOVE_VERIFIED_WINDOW_MS}ms against ${10_000 - MOVE_PRECONNECT_BUDGET_MS - MOVE_TOKEN_SKEW_ALLOWANCE_MS}ms`,
  );
  assert.ok(MOVE_VERIFIED_WINDOW_MS > 0);
});

test("🔴 the skew allowance is NON-ZERO — a zero allowance IS the bug it repairs", () => {
  // Zero is not a conservative default here. It restores `window =
  // TTL - budget` under a new name, and with it the two false claims that
  // arithmetic rests on: that the marker clock starts at the mint, and that
  // the budget ends at the SFU's verdict. Neither holds, so a zero allowance
  // re-ships the defect while leaving the sum above green.
  //
  // The floor is what the guess is worth, and it IS a guess — the event
  // carries `url`, `token`, `device_id`, `from` and `to` and no timestamp of
  // any kind, so neither span is measurable from this client and nobody here
  // has instrumented them. Roughly a second of backend legs (a Redis grant
  // probe, a publish, and on the remote-control path a LiveKit RPC and a
  // database write) plus roughly a second of connect handshake, which is a
  // couple of hundred ms direct and several times that behind TURN or on a
  // cold ICE gather. Below 1_000 the allowance no longer covers even the
  // handshake half it is named for.
  assert.ok(
    MOVE_TOKEN_SKEW_ALLOWANCE_MS > 0,
    "the token-skew allowance is zero — the verified window is back to TTL - budget, measured from the client's drop clock rather than the mint",
  );
  assert.ok(
    MOVE_TOKEN_SKEW_ALLOWANCE_MS >= 1_000,
    `the token-skew allowance is ${MOVE_TOKEN_SKEW_ALLOWANCE_MS}ms, which does not cover the connect handshake it is half named for`,
  );
  // It is an ALLOWANCE, not the whole credential: one that ate what the budget
  // leaves would drive the window to zero and make every move a stale-notice.
  assert.ok(
    MOVE_TOKEN_SKEW_ALLOWANCE_MS < 10_000 - MOVE_PRECONNECT_BUDGET_MS,
    `the token-skew allowance is ${MOVE_TOKEN_SKEW_ALLOWANCE_MS}ms, which leaves no verified window at all`,
  );
});

test("🔴 the three terms currently spend the TTL as 3_000 + 2_000 + 5_000", () => {
  // The VALUES, pinned apart from the relationship above so that the two
  // failures read differently: the sum test fires when the terms stop adding
  // up, this one fires when someone re-sizes a term that adds up fine. Every
  // number here is argued in the constants' own docs — the budget against the
  // 45 s MLS deadline it has to beat, the allowance as an openly stated guess
  // about two unmeasured spans — and re-sizing any of them is a decision that
  // should have to touch this spec rather than slip through as a literal.
  assert.equal(MOVE_PRECONNECT_BUDGET_MS, 3_000);
  assert.equal(MOVE_TOKEN_SKEW_ALLOWANCE_MS, 2_000);
  assert.equal(MOVE_VERIFIED_WINDOW_MS, 5_000);
});

test("🔴 the notice window is the OUTER bound and clears the token TTL", () => {
  // The ordering is the property: a notice window at or below the verified one
  // would make `stale-notice` unreachable and quietly restore the silence this
  // arm exists to end, while a verified window above the notice one would let
  // a session act on a marker it is not even allowed to be told about.
  assert.ok(
    MOVE_VERIFIED_WINDOW_MS < MOVE_NOTICE_WINDOW_MS,
    `verified window ${MOVE_VERIFIED_WINDOW_MS}ms is not inside the notice window ${MOVE_NOTICE_WINDOW_MS}ms — stale-notice is unreachable`,
  );
  // It must clear the token's own 10 s life comfortably: cutting the notice
  // off below that would silence notices that were still redeemable, and it
  // must clear one bad socket cycle too (`Controller.ts` caps its backoff at
  // 15 s, quoted in `voiceRejoinPolicy.ts`).
  assert.ok(MOVE_NOTICE_WINDOW_MS > 10_000);
  assert.ok(MOVE_NOTICE_WINDOW_MS > 15_000);
  assert.equal(MOVE_NOTICE_WINDOW_MS, 60_000);
  // And it is a BOUND, not a synonym for "forever": the marker has no other
  // expiry, so an unbounded one would let a drop from hours ago card a move.
  assert.ok(MOVE_NOTICE_WINDOW_MS <= 5 * 60_000);
});

// --- Textual contract against state.tsx -----------------------------------
//
// `state.tsx` cannot be imported under `node --test` (Solid, livekit,
// `@revolt/client`), so the WIRING of the rule above is unreachable by every
// gate this repo has. That is not a theory: two known-bad mutations of the
// move handler — dropping the auto-rejoin disarm, and hard-coding the world
// so every session moves — were run against this tree, and `tsc`, the full
// suite, `vite build` and `prettier --check` all stayed green on each. These
// scans are the cheapest honest substitute, and they pin property VALUES
// rather than identifiers because a one-token revert has already shipped
// green past an identifier scan once on this slice.
const STATE = readFileSync(new URL("./state.tsx", import.meta.url), "utf8");

/**
 * Crude comment stripper, the same shape the sibling AFK spec uses: every
 * scan below reads code, not prose, and `state.tsx` is entitled to quote the
 * rules it obeys when it explains why it obeys them.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const STATE_CODE = stripComments(STATE);

const MOVE_HANDLER =
  /#handleVoiceMove\(move: \{[\s\S]*?\n {2}\}\n/.exec(STATE_CODE)?.[0] ?? "";

test("state.tsx has a #handleVoiceMove body the scans below can read", () => {
  // Without this every scan that follows passes vacuously on an empty string.
  assert.ok(
    MOVE_HANDLER.length > 0,
    "no #handleVoiceMove body found in state.tsx — every scan below would pass vacuously",
  );
  assert.ok(MOVE_HANDLER.includes("moveDecision({"));
});

test("state.tsx calls moveDecision instead of restating it", () => {
  const calls = STATE_CODE.match(/moveDecision\(\{/g) ?? [];
  assert.equal(
    calls.length,
    1,
    `expected 1 moveDecision call site, saw ${calls.length}`,
  );
});

const MOVE_WORLD = Object.fromEntries(
  [
    ...(
      /moveDecision\(\{([\s\S]*?)\n {4}\}\);/.exec(MOVE_HANDLER)?.[1] ?? ""
    ).matchAll(/^\s*(\w+):\s*(.+?),\s*$/gm),
  ].map((m) => [m[1], m[2].trim()]),
);

test("🔴 the move world is READ, never asserted as a constant", () => {
  // The MED-1 lesson, in the one place it would do the most damage.
  // `callState: "CONNECTED"` plus `currentChannelId: move.from` is two
  // tokens, passes tsc, the whole suite and the build, and turns the gate
  // into an unconditional move: every idle device the user owns dials into
  // the new room and publishes its microphone, then races a single-mint
  // token and gets evicted on duplicate identity.
  //
  // The drop marker carries the same danger in a newer shape. The marker
  // steps of the addressing rule are what let a session that is NOT connected
  // accept a move, so they are only safe while their two inputs are read from
  // the session itself. `lastInvoluntaryChannelId: move.from` is one token and
  // would make every signed-in device claim the SFU had just removed it from
  // exactly the channel named in the event — the idle-phone bug again, this
  // time through the branch that was widened to fix the real target. `now`
  // must likewise be the clock, not the drop time: pinning them to each other
  // would make the window always zero-length or always open.
  //
  // The device pair is the newest member of the same family and the most
  // tempting to "simplify". `sessionDeviceId: move.deviceId` is one token,
  // passes tsc and every other gate here, and makes the device test compare a
  // value to itself — tautologically true on every session the event reaches,
  // which is precisely the unconditional-move bug above wearing the one
  // defense that was added to prevent it. `deviceId` must come off the WIRE
  // and `sessionDeviceId` out of THIS session; neither may be derived from
  // the other, and an exact map is what makes that checkable. Do not relax
  // this to a subset — a subset check cannot see a key that was dropped.
  assert.deepEqual(MOVE_WORLD, {
    callState: "this.state()",
    currentChannelId: "this.channel()?.id",
    from: "move.from",
    to: "move.to",
    url: "move.url",
    token: "move.token",
    destinationKnown: "destination !== undefined",
    lastInvoluntaryChannelId: "this.#lastInvoluntaryChannelId",
    lastInvoluntaryLeftAt: "this.#lastInvoluntaryLeftAt",
    deviceId: "move.deviceId",
    sessionDeviceId: "this.#sessionDeviceId",
    now: "Date.now()",
  });
});

test("🔴 the move path disarms the auto-rejoin loop before connecting", () => {
  // `shouldAutoRejoin` is a deny-list that fails OPEN on an absent reason,
  // and the old room's `disconnected` listener closes over the OLD channel.
  // Losing any of these three lets a rejoin win the race and silently undo a
  // moderator's decision.
  for (const stmt of [
    "this.#rejoinSeq++;",
    "this.#cancelRejoinWait?.();",
    "this.room()?.removeAllListeners();",
  ]) {
    assert.ok(
      MOVE_HANDLER.includes(stmt),
      `#handleVoiceMove no longer runs \`${stmt}\` — the rejoin loop can win the race and re-join the OLD channel`,
    );
  }
});

test("#rejoinSeq is bumped in exactly the two places that may cancel the loop", () => {
  // `disconnect()` and the move. `#autoRejoin`'s own `++this.#rejoinSeq` is a
  // prefix bump and deliberately not counted here.
  const bumps = STATE_CODE.match(/this\.#rejoinSeq\+\+/g) ?? [];
  assert.equal(
    bumps.length,
    2,
    `expected 2 #rejoinSeq bumps (disconnect + move), saw ${bumps.length}`,
  );
});

test("the move releases the destination's join-refusal latch first", () => {
  assert.ok(
    MOVE_HANDLER.includes("this.#releaseJoinRefusal(decision.to);"),
    "a latched refusal on the destination would swallow a server-ordered move",
  );
});

test("the move connects with the event's own credentials and a bounded budget", () => {
  assert.ok(
    MOVE_HANDLER.includes("{ url: decision.url, token: decision.token }"),
    "the move no longer hands connect() the pre-minted token",
  );
  assert.ok(
    MOVE_HANDLER.includes(
      "{ movePreConnectBudgetMs: MOVE_PRECONNECT_BUDGET_MS }",
    ),
    "the move no longer bounds its pre-connect work — the 10 s token dies behind the 45 s MLS deadline",
  );
});

test("the pre-connect budget actually reaches both unbounded pre-connect awaits", () => {
  // Passing the option and then not reading it is the silent half of the
  // failure: device enumeration and the MLS registration are the only two
  // awaits between `#connectAttempt`'s entry and `room.connect()`.
  const uses = STATE_CODE.match(/preConnectBudgetLeft\(\)/g) ?? [];
  assert.equal(
    uses.length,
    2,
    `expected 2 budget reads (device enumeration + MLS deadline), saw ${uses.length}`,
  );
  assert.ok(
    /Math\.min\(\s*MLS_REQUEST_DEADLINE_MS,\s*moveBudgetLeftMs\s*\)/.test(
      STATE_CODE,
    ),
    "the MLS registration deadline is no longer clamped to the move budget",
  );
});

const DISCONNECT_LISTENER =
  /room\.addListener\("disconnected", \(reason\) => \{[\s\S]*?\n {4}\}\);/.exec(
    STATE_CODE,
  )?.[0] ?? "";

test("state.tsx has a `disconnected` listener body the marker scans can read", () => {
  // Without this the two scans below pass vacuously on an empty string.
  assert.ok(
    DISCONNECT_LISTENER.length > 0,
    "no `disconnected` listener found in state.tsx — the marker scans would pass vacuously",
  );
  assert.ok(DISCONNECT_LISTENER.includes("shouldAutoRejoin("));
});

test("🔴 the involuntary-drop marker is recorded, ABOVE the rejoin branch", () => {
  // The marker steps of the addressing rule — the half that makes a real move
  // work at all — read a marker this listener is the only writer of. Deleting
  // the two writes is a two-line revert that leaves tsc, the whole suite,
  // `vite build` and `prettier --check` green while making every marker step
  // permanently false, i.e. it silently restores "a moderator moves you and
  // you land nowhere". That was measured, not guessed.
  const writeChannel = "this.#lastInvoluntaryChannelId = channel.id;";
  const writeAt = "this.#lastInvoluntaryLeftAt = Date.now();";
  assert.ok(
    DISCONNECT_LISTENER.includes(writeChannel),
    "the drop marker records no channel — no marker step can ever match and every late move is ignored",
  );
  assert.ok(
    DISCONNECT_LISTENER.includes(writeAt),
    "the drop marker records no timestamp — no marker step can ever match and every late move is ignored",
  );
  // Order matters as much as presence. Below the branch, only one of the two
  // arms would record, and the arm that misses out is the fail-open
  // `RECONNECTING` one — where `#autoRejoin` is meanwhile re-joining the OLD
  // channel, so the moderator's decision is not merely dropped but reversed.
  const branchAt = DISCONNECT_LISTENER.indexOf("shouldAutoRejoin(");
  assert.ok(
    DISCONNECT_LISTENER.indexOf(writeChannel) < branchAt &&
      DISCONNECT_LISTENER.indexOf(writeAt) < branchAt,
    "the drop marker is written after the auto-rejoin branch — one of the two arms misses it, and the fail-open one is the worse half",
  );
});

test("🔴 the drop marker is RECORDED on the drop path and nowhere else", () => {
  // The forgery surface is a write that SETS the marker, because that is the
  // write that asserts "the SFU just removed us from X" — which is exactly
  // what the marker steps trust. Exactly one such write may exist, on the
  // `disconnected` path, and its value must come from the room's own channel.
  //
  // Writes that CLEAR the marker are unbounded on purpose. A clear can only
  // ever narrow those steps, never widen them, so pinning their COUNT pins an
  // implementation detail rather than a property: `connect()` and `connected`
  // both clear today, and a third safe clear site is a change this scan must
  // not be the thing that blocks. Classifying by value instead of counting
  // heads is strictly stronger than the head-count this replaces — that one
  // could not have told a new clear apart from a new forgery at all.
  const writes = [
    ...STATE_CODE.matchAll(/this\.#lastInvoluntaryChannelId = ([^;]+);/g),
  ].map((m) => m[1].trim());
  const records = writes.filter((rhs) => rhs !== "undefined");
  assert.deepEqual(
    records,
    ["channel.id"],
    `exactly one path may RECORD the involuntary-drop marker, off the dropped room's own channel; saw ${JSON.stringify(records)}`,
  );
  assert.ok(
    writes.length > records.length,
    "nothing clears the involuntary-drop marker any more — a stale marker outlives its meaning",
  );
  // The timestamp half is the same story: one setter, and it is the clock.
  const stamps = [
    ...STATE_CODE.matchAll(/this\.#lastInvoluntaryLeftAt = ([^;]+);/g),
  ].map((m) => m[1].trim());
  assert.deepEqual(
    stamps.filter((rhs) => rhs !== "undefined"),
    ["Date.now()"],
    "the drop timestamp is set from something other than the clock, or on more than one path",
  );
  assert.equal(
    writes.length,
    stamps.length,
    `the marker's two fields are written on different sets of paths (${writes.length} channel writes vs ${stamps.length} timestamp writes) — half a marker is not a marker`,
  );
});

test("🔴 #sessionDeviceId has exactly two writes, each guarded by which side minted the identity", () => {
  // The device half of the addressing rule is only unforgeable while this
  // field holds the device THIS session actually presented. It has two
  // writers and they are mutually exclusive by construction:
  //
  //   - the BRIDGE write, guarded by `!preMintedAuth`, for an ordinary join
  //     where we choose the identity;
  //   - the MOVE write, guarded by `preMintedAuth`, after `room.connect()`,
  //     read back off the identity the SFU actually issued.
  //
  // Reverting the second to the bridge's `e2eeDeviceId` — or dropping the
  // `.split(":")[1]` that recovers the device half of `{user}:{device}` — is
  // invisible to every other gate this repo has: `tsc`, the full suite and
  // `vite build` were all measured green on exactly that revert. It is not
  // invisible in effect. The move token is minted by the server off the OLD
  // room's ingress mapping, so after a bridge re-provision the two answers
  // part company, this session records a device the server never named, and
  // the NEXT move's device test compares the wrong pair — which either
  // silences a real move or re-opens the hole the test was added to close.
  //
  // Both guards are pinned, because an UNGUARDED write is the same defect
  // wearing fewer tokens: it would let the bridge's answer overwrite the SFU's
  // on the move path.
  const writes = [
    ...STATE_CODE.matchAll(
      /if \(([^)]*)\)\s*this\.#sessionDeviceId =\s*([\s\S]*?);/g,
    ),
  ].map((m) => [
    m[1].replace(/\s+/g, " ").trim(),
    m[2].replace(/\s+/g, " ").trim(),
  ]);
  // Every write is guarded: the guarded count must account for ALL of them.
  const allWrites = STATE_CODE.match(/this\.#sessionDeviceId =(?!=)/g) ?? [];
  assert.equal(
    writes.length,
    allWrites.length,
    `${allWrites.length} writes to #sessionDeviceId but only ${writes.length} are guarded by an \`if\` — an unguarded write lets the bridge's device overwrite the SFU's on the move path`,
  );
  assert.equal(
    writes.length,
    2,
    `expected exactly 2 #sessionDeviceId writes (the bridge join and the move), saw ${writes.length}: ${JSON.stringify(writes)}`,
  );

  const bridge = writes.filter(([, rhs]) => rhs.includes("e2eeDeviceId"));
  assert.equal(
    bridge.length,
    1,
    `expected exactly 1 #sessionDeviceId write off the bridge's e2eeDeviceId, saw ${bridge.length}`,
  );
  assert.ok(
    bridge[0][0].includes("!preMintedAuth"),
    `the bridge write is no longer withheld on the move path — its guard is \`${bridge[0][0]}\`, which does not mention !preMintedAuth, so the bridge's device id overwrites the identity the server minted the token for`,
  );

  const fromIdentity = writes.filter(([, rhs]) =>
    rhs.includes("localParticipant.identity"),
  );
  assert.equal(
    fromIdentity.length,
    1,
    `expected exactly 1 #sessionDeviceId write off the SFU's own identity, saw ${fromIdentity.length}`,
  );
  assert.ok(
    /(^|[^!\w])preMintedAuth/.test(fromIdentity[0][0]),
    `the identity write is not gated on the move path — its guard is \`${fromIdentity[0][0]}\``,
  );
  assert.ok(
    fromIdentity[0][1].includes('.split(":")[1]'),
    `the identity write no longer recovers the DEVICE half of \`{user}:{device}\` — its value is \`${fromIdentity[0][1]}\`, so #sessionDeviceId records the whole identity and the next move's device test can never match`,
  );

  // And the flag the two guards turn on is still derived from the pre-minted
  // token rather than from anything the client chose.
  assert.ok(
    STATE_CODE.includes("const preMintedAuth = auth !== undefined;"),
    "`preMintedAuth` is no longer derived from the presence of a handed-over token — both #sessionDeviceId guards turn on it",
  );
});

test("🔴 state.tsx is SUBSCRIBED to the move event, exactly once, with its remover", () => {
  // Everything above this line decides what to do with an event nobody is
  // listening for unless this one statement exists. Deleting
  // `client.addListener("userMoveVoiceChannel", onMoved);` is a ONE-TOKEN
  // revert that takes the whole feature dead — a moved member lands in no
  // call at all, which is the shipped bug this slice exists to repair — and
  // it was measured to leave the entire suite green and `tsc` clean, because
  // `onMoved` stays "used" by the `onCleanup` remover below it. So the
  // subscription is pinned here, where nothing else can see it.
  const subscribes =
    STATE_CODE.match(
      /client\.addListener\(\s*"userMoveVoiceChannel",\s*onMoved\s*\)/g,
    ) ?? [];
  assert.equal(
    subscribes.length,
    1,
    `expected exactly 1 userMoveVoiceChannel subscription, saw ${subscribes.length} — at 0 the move handler is dead code and a moved member lands nowhere; above 1 the move is handled twice and two connects race`,
  );
  // Paired with its remover, inside `onCleanup`. An app-lifetime listener
  // that survives a client swap re-fires the handler on a client this state
  // no longer belongs to.
  const unsubscribes =
    STATE_CODE.match(
      /client\.removeListener\(\s*"userMoveVoiceChannel",\s*onMoved\s*\)/g,
    ) ?? [];
  assert.equal(
    unsubscribes.length,
    1,
    `expected exactly 1 userMoveVoiceChannel removeListener, saw ${unsubscribes.length}`,
  );
  assert.ok(
    /onCleanup\([\s\S]{0,120}?client\.removeListener\(\s*"userMoveVoiceChannel",\s*onMoved\s*\)/.test(
      STATE_CODE,
    ),
    "the userMoveVoiceChannel remover is no longer inside an onCleanup — the listener outlives the effect that bound it",
  );
});

test("🔴 connect() forwards its `opts` to #connectAttempt", () => {
  // The other one-token revert, and the quieter of the two. `opts` is an
  // OPTIONAL third parameter, so dropping it at the call site — `(channel,
  // auth)` — is accepted by tsc without a murmur and leaves every test here
  // green. What it silently deletes is the move's pre-connect budget: the
  // 45 s MLS deadline (`MLS_REQUEST_DEADLINE_MS`) goes back in front of a
  // 10 s token, so the token is dead before `room.connect()` is reached; and
  // `isMove` goes false, so the entrance chime plays at a user who did not
  // choose to join anything. Both were measured green on this tree.
  const forwards =
    STATE_CODE.match(
      /this\.#connectAttempt\(\s*channel,\s*auth,\s*opts,?\s*\)/g,
    ) ?? [];
  assert.equal(
    forwards.length,
    1,
    `expected connect() to call this.#connectAttempt(channel, auth, opts), saw ${forwards.length} such calls — without the third argument the move's pre-connect budget is silently dropped and the 10 s token dies behind the 45 s MLS deadline`,
  );
});

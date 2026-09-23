/**
 * AFK channel — the PURE decision core for the client half of a moderator
 * MOVE (`UserMoveVoiceChannel`), extracted so `node --test` can load it. Like
 * its neighbours this module stays dependency-free: no Solid, no stoat.js, no
 * lingui, no livekit. `state.tsx` resolves the world (call state, current
 * channel, the channel this session was last involuntarily dropped from, the
 * device the token was minted for, this session's own device, the connection
 * nonce the event names and the four this session holds (its live one, its
 * drop marker's, the one it is dialing, and the one its rejoin replaced) with
 * the replaced drop's time, whether the destination is known, the node's URL)
 * and hands the plain values in; every
 * rule below is called by production and never re-typed there.
 *
 * 🔴 Why a gate exists at all. The backend emits `UserMoveVoiceChannel`
 * PRIVATELY to the moved user (`member_edit.rs`, `.private(target_user.id)`),
 * and `EventV1::private` reaches EVERY SESSION of that user — including
 * devices that are not on the call. The note is written down in-tree at
 * `crates/core/database/src/events/client.rs` (on the sibling
 * `RemoteControlOffered` variant, which had to learn the same lesson).
 *
 * So a handler that simply acts on the event yanks an idle second device — a
 * phone in a pocket, a spare browser tab — into a call it was never in, and
 * publishes its microphone there. Worse, the move token is minted ONCE for one
 * identity: two devices redeeming it race, and LiveKit evicts one of them on
 * duplicate identity. The device that gets evicted may well be the one the
 * user is actually sitting in front of. That makes the gate below the single
 * most load-bearing rule in this slice, which is why it is a pure function
 * with a spec rather than four lines inside a 9.8k-line class.
 *
 * 🔴 THE DEVICE TEST IS INERT ON A LARGE FRACTION OF SEATS, and the rules
 * below are shaped around that rather than around the happy case. A LiveKit
 * identity is device-qualified only when the client asked for one:
 * `create_token` builds `format!("{}:{}", user.id, device_id)` when a device
 * is supplied and the bare `user.id` when it is not
 * (`crates/core/database/src/voice/voice_client.rs`), and `#connectAttempt`
 * supplies one only when `callEncryptionCapable(readiness)` holds and the key
 * provider and worker both constructed. Web, the Electron/Linux shell and any
 * user who has not provisioned an E2EE device therefore join BARE. For those
 * seats the identity the server picks out of the old room carries no
 * `{user}:` device suffix, the event carries no `device_id` at all, and the
 * device signal is simply absent. A rule that reads "when the device is
 * unknown, fall back to the channel tests" is consequently not a rare
 * cold-start path — it is the ordinary path for most of the install base, and
 * it is the path the forgery runs down. See `moveDecision` for what is done
 * about it.
 *
 * 🔴 THE CONNECTION NONCE IS THE ADDRESSING LABEL THAT DOES NOT NEED A DEVICE.
 * `create_token` mints a fresh nonce into every connection's LiveKit token as
 * the attribute `CONN_NONCE_ATTRIBUTE` ("conn"), bare seats included. At move
 * time the server reads the SOURCE connection's attribute straight off
 * `list_participants` for `from` — before it writes anything, mints the move
 * token or emits — and carries it on the event as `conn_nonce`. The session
 * reads its own from `room.localParticipant.attributes` once connected. Both
 * sides read the same SFU data, so when the SFU does not carry the attribute
 * NEITHER side has one, and the ladder falls back to the device rules below
 * together on both ends; that is why the nonce test only ever runs when BOTH
 * sides hold one.
 *
 * 🔴 THE WHOLE RULE LIVES HERE, including the part that only ever produces a
 * TOAST. An earlier cut of this slice left `state.tsx` computing its own
 * "addressed, but too late to act" test beside the call — a second copy of the
 * marker comparison, the `!== "CONNECTED"` gate and the device match, sitting
 * where no spec in this repo could reach it. It was correct, and it was still
 * the defect: this module exists so that a one-token revert of an addressing
 * term fails a test rather than shipping green. Every outcome a move can have
 * is therefore a `MoveDecision` value, and `state.tsx` renders it.
 */

/**
 * The LiveKit participant attribute that carries a connection's nonce.
 *
 * 🔴 MANUAL CROSS-REPO CONTRACT: this must equal the backend's
 * `voice_client::CONN_NONCE_ATTRIBUTE` (`crates/core/database/src/voice/
 * voice_client.rs`), which is where the nonce is minted into the token and
 * where the move reads it back off `list_participants`. Nothing generated ties
 * the two together. If they drift, this client reads no nonce, the gate in
 * `moveDecision` goes inactive on every seat, and moves fall back to the device
 * rules without any error. The spec asserts the literal on this side, and the
 * backend's tests assert it on theirs.
 */
export const CONN_NONCE_ATTRIBUTE = "conn";

/** Why a session declined to act on a move that was not addressed to it. */
export type MoveIgnoreReason =
  /**
   * This session is not connected to any call, and holds no live involuntary
   * -drop marker for the channel being moved FROM — either because it was
   * never dropped from there, or because that was longer ago than
   * `MOVE_NOTICE_WINDOW_MS` and the marker has stopped meaning anything.
   */
  | "not-in-call"
  /** This session is in a call, but not the one being moved FROM. */
  | "other-channel"
  /**
   * The server minted the move token for a DIFFERENT device of this user, so
   * whatever this session's own history says, the move is not its to redeem.
   */
  | "other-device"
  /** `from === to`; nothing to do. */
  | "already-there";

/** Why a move that WAS addressed to this session could not be carried out. */
export type MoveFailReason =
  /** The destination channel is not resolvable on this client. */
  | "unknown-channel"
  /** The event carried no usable connect URL. */
  | "no-url"
  /**
   * This session holds a fresh involuntary-drop marker for `from`, but joined
   * with a BARE identity, so neither it nor the server can say whether the
   * token was minted for it. The move is not redeemed automatically; the user
   * is told, and offered the destination to join by hand.
   */
  | "unverified-session"
  /**
   * This session holds an involuntary-drop marker for `from` that is still
   * inside `MOVE_NOTICE_WINDOW_MS` but PAST `MOVE_VERIFIED_WINDOW_MS`: the
   * notice arrived too late to act on, whether or not the device can be
   * shown. The move is not redeemed — by then the token cannot be relied on to
   * outlive the connect — but it is not swallowed either, because this
   * session's rejoin loop may be dialling the OLD channel back and would
   * otherwise reverse the moderator in silence.
   */
  | "stale-notice"
  /**
   * The event names a DIFFERENT connection of this user than this one: both
   * sides carry a connection nonce and they differ, while this session is in
   * `from`, or holds a marker for it (fresh or stale). The server moved another
   * connection and is evicting every other connection of this user from
   * `from`, so this one is going to be removed, or already has been.
   *
   * Unless the connection the event names is one this session can show is its
   * own under another nonce (S-a): the rejoin it is dialing
   * (`pendingConnNonce`) or the dropped connection its current one replaced
   * (`replacedConnNonce`). Those are addressed instead; see `moveDecision`.
   *
   * Loud rather than an `ignore` because an ignored sibling keeps its
   * `disconnected` listener armed. The eviction can arrive with no reason,
   * `shouldAutoRejoin` fails open on that, and the rejoin dials `from` again
   * with `forceDisconnect` and kicks the seat that was just moved. It is not a
   * move either: the token was minted for the other connection. What
   * `state.tsx` owes it is the disarm and a plain notice, with no destination
   * card and no Rejoin, since a Rejoin here would re-race the moved seat.
   */
  | "moved-elsewhere";

export type MoveDecision =
  | { action: "ignore"; reason: MoveIgnoreReason }
  | { action: "fail-loud"; reason: MoveFailReason }
  | { action: "move"; url: string; token: string; to: string };

/** Everything the decision needs, as plain values. */
export interface MoveWorld {
  /** Voice state at the moment the event arrived. */
  callState: string;
  /** The channel this session is in, or `undefined` when it is in none. */
  currentChannelId: string | undefined;
  /** The event's `from`: the channel the moderator moved the user out of. */
  from: string;
  /** The event's `to`: the destination channel. */
  to: string;
  /**
   * The destination node's connect URL, straight off the event. The wire
   * also carries `node`, which is a node NAME and is NOT connectable: the
   * server filters private nodes out of what it advertises, so a client
   * cannot resolve one itself. That is why the event carries both.
   */
  url: string | undefined;
  /** The pre-minted move token from the event. */
  token: string;
  /** Whether the destination channel resolves on this client. */
  destinationKnown: boolean;
  /**
   * The channel this session was in when the SFU dropped it WITHOUT the user
   * asking, and when that happened (ms epoch). `undefined` when this session
   * has not been dropped, or was dropped too long ago to matter.
   */
  lastInvoluntaryChannelId: string | undefined;
  lastInvoluntaryLeftAt: number | undefined;
  /**
   * The device the server minted this token for, or `undefined` when the
   * identity it recovered from the old room carried no device suffix.
   *
   * 🔴 `undefined` is the COMMON case, not the exotic one: every seat that
   * joined bare — web, the Electron/Linux shell, any unenrolled user —
   * produces it. Read it as "unknown", never as "any device may act".
   */
  deviceId: string | undefined;
  /**
   * This session's own device id — the one it actually PRESENTED at join
   * time; `undefined` when it joined bare.
   */
  sessionDeviceId: string | undefined;
  /**
   * The nonce of the connection the server moved, straight off the event
   * (`conn_nonce`). The server read it from that connection's
   * `CONN_NONCE_ATTRIBUTE` attribute in `list_participants` for `from`, before
   * any write. `undefined` or `""` when the SFU carried no attribute; both
   * count as absent.
   */
  connNonce: string | undefined;
  /**
   * This session's own nonce, read off its local participant's attributes.
   * Set only while it is CONNECTED, and compared only for the CONNECTED-to-
   * `from` shape.
   */
  sessionConnNonce: string | undefined;
  /**
   * The nonce of the connection the involuntary-drop marker was recorded for,
   * snapshotted with the marker and cleared with it. Compared only for the
   * marker shapes, fresh or stale.
   */
  lastInvoluntaryConnNonce: string | undefined;
  /**
   * S-a, marker shape. The nonce of the connection this session is DIALING
   * right now, which is its own rejoin of the channel it was dropped from.
   * The SFU can already list that connection while the client is still not
   * CONNECTED, so the server may name it. Compared only when the gate is
   * active for the marker shape, the nonces differ, and this session is
   * dialing `from` (`currentChannelId === from`). `undefined` when nothing
   * is being dialed.
   */
  pendingConnNonce: string | undefined;
  /**
   * S-a, CONNECTED shape. The nonce of the dropped connection that this
   * session's CURRENT connection replaced, recorded only when the current
   * connection was a rejoin of the channel that drop named. A late move can
   * name that ghost connection. Compared only when the gate is active for the
   * CONNECTED-to-`from` shape and the nonces differ.
   */
  replacedConnNonce: string | undefined;
  /**
   * When the drop recorded in `replacedConnNonce` happened, in the same time
   * base as `lastInvoluntaryLeftAt` (it is that marker's timestamp, carried
   * across the rejoin). Its age is judged against the same two windows the
   * marker uses, measured from the ORIGINAL drop.
   */
  replacedLeftAt: number | undefined;
  /** Current time, ms epoch — injected so this stays pure. */
  now: number;
}

/**
 * Pre-connect budget for a move, in ms.
 *
 * The arithmetic, because the number looks arbitrary and is not:
 *
 * The move token is minted server-side with a TEN SECOND TTL —
 * `.with_ttl(Duration::from_secs(10))` in
 * `crates/core/database/src/voice/voice_client.rs`. A normal join is immune to
 * that clock because it mints its own token AFTER all pre-connect setup has
 * finished; the move path is handed a token that is already ticking when the
 * event lands, and must reach `room.connect()` well inside those 10 s or the
 * SFU rejects it and the user is left out of both channels.
 *
 * The ordinary pre-connect path cannot be reused unbounded: it races the MLS
 * key listener against `MLS_REQUEST_DEADLINE_MS` = 45_000
 * (`components/client/e2eeRatelimitPolicy.ts`), which is more than four times
 * the token's whole life. Waiting on it would eat the token outright, every
 * time, on a slow key exchange.
 *
 * 3000 ms is what is left over once the rest of the 10 s is spoken for: event
 * delivery over the websocket, tearing down the old room, and the connect
 * handshake itself — spans this paragraph named and then reserved NOWHERE,
 * which is how the verified window below came to be sized as `TTL - budget`
 * with nothing held back for them. `MOVE_TOKEN_SKEW_ALLOWANCE_MS` is where
 * they are now actually reserved. Raising this budget past the TTL does not
 * buy patience, it just moves the failure later and makes it look like a
 * network fault — the spec pins it against 10_000 for exactly that reason.
 *
 * 🔴 It is ONE OF TWO terms that size `MOVE_VERIFIED_WINDOW_MS`, which is
 * `TTL - budget - skew`; the skew allowance is the other. Raising this must
 * lower one of those two, and the spec pins the three-term sum so that it
 * cannot be raised on its own.
 */
export const MOVE_PRECONNECT_BUDGET_MS = 3000;

/**
 * The part of the move token's life that this module CANNOT see, in ms —
 * everything between the mint and the SFU's verdict that falls outside both
 * the drop marker's clock and the pre-connect budget.
 *
 * Why it has to exist at all. The verified window below is measured from
 * `#lastInvoluntaryLeftAt`, and the budget above stops counting at
 * `room.connect()`. Neither endpoint is the one the SFU judges the token by,
 * and the error is in the unsafe direction at BOTH ends:
 *
 *   mint -> Leave, before our clock starts. `move_user_to_voice_channel`
 *     (`crates/core/database/src/voice/mod.rs`) lists the source room and
 *     writes its markers, then mints the token, then calls
 *     `release_remote_control_for_user` — at minimum a Redis probe for the
 *     channel's grant set, and when a grant does exist, two more lookups
 *     plus `end_remote_control_grant`, which is itself a LiveKit
 *     `update_permissions` RPC and a database write — then publishes the
 *     private event, and only THEN evicts each listed connection through
 *     `remove_identity_if_present`, the `RemoveParticipant` whose `Leave`
 *     reaches us and writes the marker. Every one of those legs is already
 *     spent when our clock starts from zero, so a marker age of N ms is a
 *     token age of N + (mint -> Leave) ms. The marker can never be early.
 *   the connect handshake, after our budget stops. The JWT is validated at
 *     the END of the handshake, not at its start: the signaling round trip,
 *     ICE and DTLS all sit past `room.connect()` and outside the budget
 *     entirely. Reaching `connect()` inside the budget is therefore not the
 *     same as being ACCEPTED inside the TTL.
 *
 * So the real headroom under `TTL - budget` is negative by the sum of those
 * two, and the window below is cut by this allowance to put it back.
 *
 * 🔴 SAY WHAT THIS NUMBER IS: a guess. Neither span is measurable from this
 * client. The event carries `url`, `token`, `device_id`, `conn_nonce`, `from`
 * and `to` and no timestamp of any kind, so there is nothing on the wire to
 * compare a local clock against, and nobody here has instrumented either leg.
 * 2_000 is argued, not measured: allow roughly 1 s for the backend leg — a
 * Redis probe and a publish are sub-millisecond on a healthy deployment, but
 * the RPC and write on the grant path are not, and delta is not always
 * healthy — and roughly 1 s
 * for the handshake, which is a couple of hundred ms direct and several times
 * that behind TURN, on a cold ICE gather, or on mobile data. Both terms
 * stretch on exactly the deployments where a moderator most wants the move to
 * land, which is the case for rounding each of them UP rather than to their
 * median.
 *
 * The asymmetry of being wrong decides the direction. Too GENEROUS costs a
 * member near the edge an automatic move they could have had: they get the
 * `stale-notice` card, the destination named and Rejoin one click away. Too
 * TIGHT — which is what shipped — costs them a doomed `room.connect()`, then
 * an SFU rejection surfaced as an error modal that names a credential problem
 * they cannot act on, and THEN the same manual rejoin, later. One is a click,
 * the other is a failure plus a click, so the allowance is sized generously.
 *
 * 🔴 The right fix retires this constant rather than tuning it: put the
 * token's ABSOLUTE expiry on the wire beside `url` and `token`, so the client
 * declines a dead credential on the server's own clock instead of inferring a
 * token's age from its own drop clock. Until that exists, every number in this
 * derivation is a guess about a span nobody has measured, and it should be
 * read as one.
 */
export const MOVE_TOKEN_SKEW_ALLOWANCE_MS = 2_000;

/**
 * How long after an involuntary drop a DEVICE-MATCHED session still answers to
 * a move for the channel it was dropped from, in ms.
 *
 * The arithmetic, because the number looks arbitrary and is not:
 *
 * This window has been sized twice from two different premises, and both are
 * now retired. It was 10_000 while `move_user_to_voice_channel` called
 * `voice_client.remove_user(...)` BEFORE publishing the event: the eviction
 * beat the event every single time, the window had to cover a GUARANTEED
 * inversion, and the only honest bound left was the life of the credential
 * (`.with_ttl(Duration::from_secs(10))` in
 * `crates/core/database/src/voice/voice_client.rs`). It was then cut to 2_000
 * once the backend started emitting BEFORE the eviction — and says so where it
 * does it (`crates/core/database/src/voice/mod.rs`, "EMITTED BEFORE THE
 * EVICTION, AND THE ORDER IS THE FIX") — because what was left for the marker
 * path was the RESIDUAL race rather than the guaranteed one, and because the
 * window was the FORGERY SURFACE: for as long as it stood open, an involuntary
 * drop from `from` that had nothing to do with the move — `joinCall` defaults
 * `forceDisconnect = true`, so a user carrying their own call from one seat to
 * another leaves the first holding exactly that marker — was indistinguishable
 * from the move's own eviction. Shrinking the window was the only lever
 * available against it on a seat whose device could not be named.
 *
 * That lever is gone because the hole it was shrinking is gone. A MOVE is now
 * reachable off a marker ONLY on a session that positively matched the device
 * the token was minted for; a session that cannot show its device does not
 * fall back into it, it fails loud (`unverified-session`). A forged marker
 * therefore no longer buys an unattended seat a move at ANY window size, so
 * sizing this number against forgery is sizing it against nothing.
 *
 * What is left is the only real constraint: the token's life. An acceptance at
 * the FAR EDGE of the window still has to finish its pre-connect work before
 * `room.connect()`, and that work is bounded by `MOVE_PRECONNECT_BUDGET_MS`.
 *
 * 🔴 THAT IS NOT `TTL - budget`, THOUGH THIS COMMENT ONCE SAID IT WAS, and the
 * claim it made — "as large as `TTL - budget` and not one millisecond more:
 * 10_000 - 3_000 = 7_000" — was measured from the wrong epoch at both ends.
 * `#lastInvoluntaryLeftAt` is when the SFU's `Leave` reached US, which is
 * strictly later than the mint; the budget stops at `room.connect()`, which is
 * strictly earlier than the SFU's verdict on the JWT. Both unmeasured spans
 * are collected into `MOVE_TOKEN_SKEW_ALLOWANCE_MS`, which states plainly that
 * its value is a guess. So the derivation is
 *
 *   window = TTL - budget - skew = 10_000 - 3_000 - 2_000 = 5_000
 *
 * with 10_000 the token's own TTL (`.with_ttl(Duration::from_secs(10))` in
 * `crates/core/database/src/voice/voice_client.rs`). It is written below as
 * that expression rather than as `5_000`, so the three terms cannot silently
 * drift apart; the spec pins the derivation AND the `window + budget + skew <=
 * TTL` sum, and the sum is the invariant that actually matters.
 *
 * What the old 7_000 bought, concretely, because the cost was real but small:
 * a marker at ~6.5 s on a seat whose budget went largely on a stalled
 * `Room.getLocalDevices` reached `room.connect()` past T_mint + 10 s, the SFU
 * refused the credential, and the member paid a doomed connect plus an error
 * modal naming a failure they could not act on — where this window would have
 * carded a `stale-notice`, which is the same destination and the same Rejoin
 * button, sooner and without the failed attempt. Nothing insecure happened
 * either way: the refusal is the SFU's, it is fail-closed, and the user is
 * always left with an actionable card. This is a SIZING defect and a false
 * comment, not a hole.
 *
 * Under-sizing has its own cost — a member near the edge does the rejoin by
 * hand — so the cut is exactly the allowance and no more; it is not padded a
 * second time "to be safe".
 *
 * Past this window the marker does not go quiet immediately — it becomes a
 * `stale-notice` until `MOVE_NOTICE_WINDOW_MS`, which is the outer bound.
 */
export const MOVE_VERIFIED_WINDOW_MS =
  10_000 - MOVE_PRECONNECT_BUDGET_MS - MOVE_TOKEN_SKEW_ALLOWANCE_MS;

/**
 * Beyond this, a move notice is not actionable and is ignored silently.
 *
 * The OUTER bound on the involuntary-drop marker, and the reason it exists:
 * nothing else expires that marker. `state.tsx` clears it on `connect()` and
 * on `connected` and nowhere else, so a session that goes offline and never
 * reconnects keeps it for as long as the process lives. Without a bound, a
 * laptop whose lid was shut eight hours ago would wake up, receive a move that
 * had landed on the user's phone in the meantime, match its ancient marker
 * against `from` and card "a moderator moved you" for something it had no part
 * in. Any finite bound fixes that; this number chooses how much genuine
 * lateness is still worth telling the user about.
 *
 * The arithmetic, because the number looks arbitrary and is not:
 *
 * The floor is set by what a real notice can survive. The token's life is
 * 10_000 (`.with_ttl(Duration::from_secs(10))` in
 * `crates/core/database/src/voice/voice_client.rs`), so nothing that could
 * ever have been REDEEMED lives past it, and this bound must sit well clear of
 * that or it would be cutting off notices that were still actionable. It must
 * also clear one bad socket cycle: `Controller.ts` retries with its backoff
 * capped at 15 s (quoted in `voiceRejoinPolicy.ts`), so a notice delayed by a
 * single reconnect of our own websocket has to get through. 60_000 is six
 * times the token TTL and four times that cap.
 *
 * The ceiling is the marker's plausibility. The longer the bound, the wider
 * the span in which a drop that had nothing to do with this move can raise a
 * card — and unlike the verified window, this one is NOT closed by the device
 * test, because a `stale-notice` is issued whether or not the device can be
 * shown. One minute keeps the card inside the same sitting: the user saw the
 * call end, and the notice explains it.
 *
 * It is deliberately NOT sized to the rejoin ladder, and that is a real trade
 * rather than an oversight. `totalRejoinWindowMs()` is 120_000 across
 * `MAX_REJOIN_ATTEMPTS` = 8, so between one and two minutes a genuinely moved
 * session gets the rejoin loop's own give-up card — which points at the OLD
 * channel — instead of one pointing at the destination. That loss is narrow
 * and it is accepted: buying that second minute would double the span in which
 * an unrelated marker can card a move, on the one signal that has no other
 * expiry at all. The spec pins the value, the `VERIFIED < NOTICE` ordering and
 * the clearance above the token TTL.
 */
export const MOVE_NOTICE_WINDOW_MS = 60_000;

/**
 * Decide what THIS session does with a `UserMoveVoiceChannel` event.
 *
 * The order of the tests is the contract, not an implementation detail:
 *
 *   1. nonce gate INACTIVE, and minted
 *      for another device                 -> ignore    / other-device
 *   2. from === to                        -> ignore    / already-there
 *   N. nonce gate ACTIVE, nonces DIFFER
 *      (the unequal half of 3, 4/5 and 6):
 *      Na. marker shape, dialing `from`,
 *          and the event names the
 *          PENDING nonce                  -> addressed, on to feasibility
 *      Nb. CONNECTED to `from`, and the
 *          event names the REPLACED nonce,
 *          its drop inside
 *          `MOVE_VERIFIED_WINDOW_MS`      -> addressed, on to feasibility
 *          `MOVE_NOTICE_WINDOW_MS`        -> fail-loud / stale-notice
 *      otherwise                          -> fail-loud / moved-elsewhere
 *   3. in `from` now                      -> addressed, on to feasibility
 *   4. marker FRESH and the label MATCHES
 *      (nonce when the gate is active,
 *      device when it is not)             -> addressed, on to feasibility
 *   5. marker FRESH, gate inactive,
 *      device UNKNOWN                     -> fail-loud / unverified-session
 *   6. marker names `from`, but STALE     -> fail-loud / stale-notice
 *   7. otherwise                          -> ignore    / other-channel |
 *                                                        not-in-call
 *
 * then, for an addressed session (3, 4, Na, and Nb inside the verified
 * window):
 *
 *   destination unresolvable            -> fail-loud / unknown-channel
 *   no usable URL                       -> fail-loud / no-url
 *   otherwise                           -> move
 *
 * with the marker terms and the nonce gate being
 *
 *   markerNamesSource = not CONNECTED, the marker names `from`, it carries a
 *                       timestamp, and that timestamp is inside
 *                       `MOVE_NOTICE_WINDOW_MS`
 *   markerIsFresh     = markerNamesSource, and inside
 *                       `MOVE_VERIFIED_WINDOW_MS` as well
 *   nonceGate         = the event's `connNonce` is non-empty AND so is this
 *                       session's nonce FOR ITS SHAPE: `sessionConnNonce` when
 *                       it is CONNECTED to `from`, `lastInvoluntaryConnNonce`
 *                       when `markerNamesSource`, and none otherwise
 *
 * With the gate inactive on every clause, the ladder is exactly the
 * seven-step device ladder this module shipped before the nonce existed, with
 * the same answer in every world. The spec pins that against a fingerprint of
 * the old ladder's answers.
 *
 * 🔴 STEP 1 AND THE NONCE TEST ARE THE ONLY UNFORGEABLE TESTS HERE. Every
 * other addressing signal below is this session's own account of its own
 * history. `deviceId` and `connNonce` are the server's account of whose
 * credential this is. LiveKit identities are `user:device`, and the move
 * token is minted for exactly one of them (`move_user_to_voice_channel` picks
 * the moved connection out of the old room's participant list and derives the
 * device from that identity). A session whose device is not that device
 * cannot redeem the token without racing the session that can — and LiveKit
 * resolves that race by evicting one of them on duplicate identity, quite
 * possibly the one the user is sitting in front of.
 *
 * 🔴 When the gate is inactive, step 1 gates EVERY step below, not merely the
 * marker ones. Because identities are device-qualified, two sessions of one
 * user CAN be in the same channel at once whenever `forceDisconnect` is false,
 * so two sessions can satisfy step 3 simultaneously. Gating everything is
 * strictly safer and far easier to reason about than arguing about which step
 * is currently reachable twice.
 *
 * 🔴 WHEN THE GATE IS ACTIVE, THE NONCE REPLACES THE DEVICE TEST AT EVERY
 * STEP; it is not added on top of it. A nonce names one connection, while a
 * device id names a device, and a device can hold more than one connection
 * (tabs of one browser share the E2EE device). The case that decides it is a
 * BARE sibling of a device-qualified mover: the event names device D1, and
 * the bare seat has no device. Under step 1 it would be `other-device` and
 * SILENT, but the server is about to evict it as a sibling of the moved
 * connection. If its drop then fails open in `shouldAutoRejoin`, it dials
 * `from` back with `forceDisconnect` and kicks the seat that was just moved.
 * So step 1 only runs when the gate is inactive for this session's shape.
 * When the gate is active, equal nonces address the session whatever the
 * devices say, and unequal nonces are `moved-elsewhere`, which is loud so
 * that `state.tsx` disarms the rejoin loop.
 *
 * 🔴 The gate needs BOTH sides (the event and this session's nonce for its
 * shape), and `""` counts as absent. A one-sided nonce means the SFU, the
 * server or this client did not carry the attribute. Comparing a value to an
 * absence would read that as a mismatch and turn a real target loud, so
 * a one-sided nonce falls back to the device ladder, exactly as it was.
 *
 * 🔴 Unequal nonces are `moved-elsewhere` at steps 3, 4/5 AND 6. At step 3 the
 * session is a live sibling in `from`. At steps 4/5 it holds a fresh marker
 * for a DIFFERENT connection than the moved one, which is the handoff seat step
 * 5 exists to refuse; it is now positively excluded rather than merely
 * unverifiable. At step 6 a `stale-notice` would say the move "reached this
 * device too late to follow", and that is false: the move was never this
 * connection's. The gate is only ever active in one of those shapes, so the
 * unequal half of all three is one test, placed after step 2 and ahead of
 * the addressed arms.
 *
 * 🔴 S-a — BEFORE THAT TEST ANSWERS `moved-elsewhere`, IT ASKS WHETHER THE
 * NAMED CONNECTION IS THIS SESSION'S OWN UNDER ANOTHER NONCE. A session holds
 * two nonces the gate does not compare, and in two windows the server names
 * one of them:
 *
 *   (ii) Na — the rejoin is still dialing. The session was dropped from
 *     `from` (marker nonce N1) and its rejoin loop is dialing `from` again
 *     under a fresh token (N2). The SFU already lists N2, so a move now names
 *     N2 while the session is not CONNECTED and compares against N1. N2 is
 *     `pendingConnNonce`, and the event naming it is the step-3 case one
 *     beat early: this connection is the one being moved.
 *   (v) Nb — the rejoin finished and the event is late. The session is
 *     CONNECTED to `from` as N2, but the SFU had not yet reaped the dropped
 *     connection N1 and the server picked that ghost. N1 is
 *     `replacedConnNonce`, recorded only when the current connection is a
 *     rejoin of the channel that drop named, so the move is this session's.
 *     It is judged by the age of the ORIGINAL drop (`replacedLeftAt`) against
 *     the marker's own two windows: a move inside the verified window, a
 *     `stale-notice` inside the notice window, and past that the answer is
 *     unchanged.
 *
 * Neither nonce can belong to a sibling. Each is minted per `create_token`
 * and delivered in the single `join_call` response of the connection that
 * holds it. That is why this is safe where "treat moved-elsewhere on a
 * just-rejoined seat as addressed" is not: that looser rule lets two
 * siblings that dropped together both claim the move.
 *
 * S-a only WIDENS. It runs only inside the gate-active, nonces-differ test,
 * so it can turn a `moved-elsewhere` into an addressed answer and can change
 * nothing else. The gate's own activity is untouched, so G1 still holds: with
 * a one-sided nonce these two fields are never read. No new reason exists for
 * it. Both fields come out of this session and never off an event.
 *
 * 🔴 STEP 2 IS SECOND ON PURPOSE, AND IT OUTRANKS THE LOUD ARMS. An earlier
 * cut of this ladder let step 6 beat it and the question was left open; this
 * is the answer. When `from === to` NOTHING WAS MOVED, so every loud arm below
 * would open with "a moderator moved you to another voice channel" — a plain
 * false statement, on a session that is exactly where it already was. The
 * affordance being given up is a Rejoin button pointing at the channel this
 * session was just dropped from, which is marginal at best; honesty about what
 * happened is not. It also cannot occur in practice — `member_edit` answers
 * `AlreadyPresent` for `from === to` and emits no event at all — so this is
 * defensive ordering for a shape that only reaches us if the backend changes,
 * and defensive code should fail quiet and true rather than loud and false.
 * It outranks `moved-elsewhere` for the same reason. That copy says another
 * connection was moved and this one is being removed, and when nothing moved,
 * nothing is being removed either.
 *
 * 🔴 ADDRESSING IS NOT "AM I IN `from` RIGHT NOW". It is "am I the session
 * that WAS in `from`", because the event can arrive after this session has
 * already been thrown out of `from`. The backend now publishes
 * `EventV1::UserMoveVoiceChannel` BEFORE it evicts each listed connection with
 * `voice_client.remove_identity_if_present(...)` — the order is stated and
 * justified at the call site in `crates/core/database/src/voice/mod.rs` —
 * precisely so the real target is normally still `CONNECTED` when its own
 * move lands. Step 3 is therefore the ordinary path.
 *
 * The inversion is no longer guaranteed, but it is not gone. The two legs
 * leave delta at nearly the same instant by different routes: the event via a
 * Redis publish, bonfire and then our socket, the eviction via a LiveKit RPC
 * and a `Leave` straight down our signalling socket. When the `Leave` wins,
 * `PARTICIPANT_REMOVED` is in `NO_REJOIN_DISCONNECT_REASONS`
 * (`voiceRejoinPolicy.ts`) and lands us in `DISCONNECTED`; a gate that asked
 * for `CONNECTED` would then answer `ignore` to the real target, silently,
 * and the member would end up in no call at all. When the SDK reports the
 * removal with an absent or unrecognised reason instead, `shouldAutoRejoin`
 * fails OPEN, the session goes `RECONNECTING` and starts dialling the OLD
 * channel back; ignoring the move there silently undoes the moderator.
 *
 * 🔴 The marker terms are deliberately gated on `callState !== "CONNECTED"`.
 * Without that gate a session dropped from A that has since joined B would
 * still be "addressed" by a stale A-move and get yanked out of the call it is
 * actually in — the marker outlives the drop, so being connected somewhere is
 * what retires it. A `CONNECTED` session is judged only by where it is now.
 *
 * 🔴 A FRESH MARKER IS NOT ENOUGH ON ITS OWN — step 5, and the heart of this
 * rule. An involuntary drop from `from` is an ORDINARY event that any of this
 * user's sessions can record: `Channel.joinCall` defaults
 * `forceDisconnect = true`, so picking a call up on a second seat evicts the
 * first, which then holds exactly the marker step 4 looks for, genuinely not
 * connected to anything. If an unverifiable session were allowed to fall into
 * step 4, the new seat would match step 3, the idle one would match step 4,
 * both would redeem a token minted ONCE for identity `{user}`, LiveKit would
 * evict one on duplicate identity — and the survivor can be the unattended
 * seat, which joins the destination and publishes its microphone into a room
 * nobody is sitting at. The AFK sweep is a timer, so a move landing inside the
 * window is a schedule, not a coincidence.
 *
 * The fallback also buys nothing to offset that. With a BARE identity only one
 * session of this user can be in `from` at a time — LiveKit would already have
 * evicted any other on duplicate identity — so for exactly the seats where the
 * device is unknown, step 3 is EXACT. Everything step 4 would add on those
 * seats is forgery surface.
 *
 * 🔴 Step 5 is a LOUD failure and not an `ignore`, and that is the whole
 * design. Both outcomes it replaces are silent and both are wrong: ignoring
 * strands the genuine target in no call at all (the shipped bug this slice
 * exists to repair), and moving joins a microphone into an empty room. A loud
 * failure splits the two populations by what they cost. An unverifiable
 * session that really was the one moved gets an actionable outcome — the
 * destination carded, Rejoin available — and the member is one click from
 * where the moderator put them. An unattended seat that was merely
 * force-disconnected by a handoff gets a toast nobody reads and, crucially,
 * PUBLISHES NO MICROPHONE.
 *
 * Say the trade plainly, because it is a real one: web, the Electron/Linux
 * shell and unenrolled users get a MANUAL Rejoin exactly where a native E2EE
 * seat gets an AUTOMATIC move. That asymmetry is accepted here because the
 * failure it replaces is unattended audio in a room nobody is in.
 *
 * The addressing label that is not the E2EE device id now exists: the
 * per-connection nonce. `create_token` mints one into every connection's
 * token as the `CONN_NONCE_ATTRIBUTE` attribute. There is no server-side
 * record of it; at move time the server reads the SOURCE connection's
 * attribute off `list_participants` for `from`, before any write, and carries
 * it on the event. A bare seat whose marker snapshotted a nonce is judged by
 * the nonce gate: it moves on a match and is `moved-elsewhere` on a mismatch,
 * and never reaches step 5. Step 5 is left for a gate that is inactive, which
 * happens when the SFU carries no attribute, a server predates the nonce, or
 * this session read none. There the trade above still holds, and on those
 * seats it is still the ordinary path, not a rare one.
 *
 * 🔴 STEP 6 IS ONE ARM FOR TWO CAUSES, and it exists because both of them were
 * silent. Past `MOVE_VERIFIED_WINDOW_MS` the device distinction stops buying
 * anything: no move is going to be attempted either way, because the token can
 * no longer be trusted to survive the connect. What is left is purely "does
 * this user get told", and the answer is the same for both populations.
 *
 *   - The VERIFIED-but-late session. It can prove the token names it, it was
 *     dropped out of `from`, and the notice simply took too long. Silence is
 *     the one answer it must not get: its drop fails OPEN in `shouldAutoRejoin`
 *     whenever the SDK reports no reason, so it is already dialling `from` back
 *     on the 1 s / 2 s / 4 s ladder. Ignoring the move there hands the user
 *     their old channel and tells nobody a moderator's decision was undone.
 *   - The UNVERIFIED-and-late session. Identical rejoin loop, identical
 *     reversal, and it cannot show a device — which is the ordinary case on
 *     web and the Electron/Linux shell, so this is the larger population of the
 *     two, not the edge.
 *
 * Splitting them would mean telling one of them a different story about a
 * difference that no longer has any consequence. One arm, and the copy says
 * what is true of both: the notice arrived too late to follow automatically.
 * The one exception is a session the nonce gate positively EXCLUDES. Its
 * nonces differ, so the move was never its to follow, late or not, and it is
 * `moved-elsewhere` rather than `stale-notice` (see the nonce note above).
 *
 * 🔴 The idle-device property survives all of this untouched: a phone in a
 * pocket was never in `from`, so its `lastInvoluntaryChannelId` is
 * `undefined`, no step from 3 to 6 is true, the nonce gate has no shape to
 * apply to, and it still ignores — silently, as it must.
 *
 * 🔴 Steps 1, 2 and 7 MUST come before the feasibility tests. The addressing
 * question ("is this event even about me?") is answered before the feasibility
 * question ("can I do it?"). An idle phone cannot resolve the destination
 * either, so under the other order it would answer `fail-loud` and pop an
 * error toast about a call it is not in — a user being moved would get one
 * real move and N spurious errors, one per signed-in device. `ignore` is
 * silent by design. Steps 5 and 6 and `moved-elsewhere` sit on the addressing
 * side of that line on purpose: they outrank `unknown-channel` and `no-url`
 * because a session that cannot prove it was the target, that is past the
 * point of acting, or that was positively not the target must not be told WHY
 * it could not carry out a move it was never going to carry out.
 *
 * `already-there` is an ignore rather than a no-op move because redeeming a
 * token for the room we are already in is a reconnect: it tears down a healthy
 * room and re-races our own identity for nothing.
 *
 * `unknown-channel` and `no-url` are LOUD on purpose. Past the addressing
 * tests this session really was the target, so the move is going to happen
 * server-side whatever the client does — the user is already out of the old
 * channel. Failing silently there strands them looking at a call they are no
 * longer in.
 *
 * A whitespace-only URL counts as absent: a node row with a blank URL reaches
 * `room.connect()` as a malformed endpoint and fails far from here, with an
 * SDK error that names nothing. The `url`/`token`/`to` on a `move` are passed
 * through EXACTLY as given — this function decides, it does not normalize.
 */
export function moveDecision(world: MoveWorld): MoveDecision {
  // Did the server name a device at all, and is it ours? The two questions are
  // separate and the difference is load-bearing: `deviceKnown` false means
  // NOBODY can be verified on this event, which is a property of the seat's
  // bare identity and not a fact about this session.
  const deviceKnown = world.deviceId !== undefined;
  const deviceMatches = deviceKnown && world.deviceId === world.sessionDeviceId;

  // Step 3's shape: we are in `from` right now. On a bare identity this is
  // EXACT, because two sessions of one user cannot hold the same bare LiveKit
  // identity in the same room at once.
  const connectedToSource =
    world.callState === "CONNECTED" && world.currentChannelId === world.from;

  // How old the involuntary-drop marker is, or `undefined` when there is no
  // marker for `from` to age at all — an absent timestamp, a marker naming
  // another channel, or a session that is CONNECTED somewhere and has
  // therefore retired whatever it was holding.
  const markerAgeMs =
    world.callState !== "CONNECTED" &&
    world.lastInvoluntaryChannelId === world.from &&
    world.lastInvoluntaryLeftAt !== undefined
      ? world.now - world.lastInvoluntaryLeftAt
      : undefined;

  // The marker names `from` and is recent enough to still mean something.
  // This is a CLAIM, not a proof: an ordinary handoff produces exactly this
  // shape. It is the outer bound, and on its own it only ever buys a toast.
  const markerNamesSource =
    markerAgeMs !== undefined && markerAgeMs < MOVE_NOTICE_WINDOW_MS;
  // …and recent enough that a move can still be attempted: even allowing for
  // the pre-connect budget and the unmeasured mint/handshake skew, the token
  // should still have life left in it.
  const markerIsFresh =
    markerNamesSource &&
    markerAgeMs !== undefined &&
    markerAgeMs < MOVE_VERIFIED_WINDOW_MS;

  // Which of this session's nonces the event's is compared against. The
  // live connection's is used for the CONNECTED-to-`from` shape, and the
  // dropped connection's, snapshotted with the marker, for the marker shapes.
  // The two shapes cannot both hold (the marker terms require not CONNECTED),
  // so at most one applies. Any other shape has none, so the gate stays
  // inactive and that session keeps exactly its old answer.
  const sessionSideNonce = connectedToSource
    ? world.sessionConnNonce
    : markerNamesSource
      ? world.lastInvoluntaryConnNonce
      : undefined;
  // G1: active only when BOTH sides carry one, with `""` read as absent. A
  // one-sided nonce means one side never saw the attribute, and comparing a
  // value to an absence would call a real target "elsewhere".
  const nonceGate = !!world.connNonce && !!sessionSideNonce;
  const nonceMatches = nonceGate && world.connNonce === sessionSideNonce;

  // The feasibility tail every ADDRESSED shape ends in, written once so that
  // steps 3 and 4 and the S-a arms below cannot drift apart.
  const addressed = (): MoveDecision => {
    if (!world.destinationKnown)
      return { action: "fail-loud", reason: "unknown-channel" };
    if (!world.url || world.url.trim().length === 0)
      return { action: "fail-loud", reason: "no-url" };
    return {
      action: "move",
      url: world.url,
      token: world.token,
      to: world.to,
    };
  };

  // Step 1, ahead of every local test: the token names a device, and it is
  // not ours. Nothing else about this session's history can override that,
  // EXCEPT the nonce, which names the connection rather than the device and so
  // REPLACES this test whenever the gate is active (see the 🔴 note above).
  // Run ahead of it, this test would silence a bare sibling of a
  // device-qualified mover, and that sibling's rejoin kicks the moved seat.
  if (!nonceGate && deviceKnown && !deviceMatches)
    return { action: "ignore", reason: "other-device" };

  // Step 2: nothing was moved, so nothing — loud or quiet — may claim it was.
  // See the 🔴 note above for why this outranks the loud arms, the nonce's
  // included.
  if (world.from === world.to)
    return { action: "ignore", reason: "already-there" };

  // The unequal half of steps 3, 4/5 and 6. The gate is only active in one of
  // those shapes, so this is the answer for all of them. The server moved a
  // different connection of this user and is evicting this one, so it must not
  // act, and it must not stay quiet while its rejoin loop is still armed.
  if (nonceGate && !nonceMatches) {
    // S-a (ii), step Na: the named connection is the rejoin this session is
    // dialing into `from` right now. The marker shape is the only one where
    // a pending connection is meaningful, and `currentChannelId === from`
    // says what is being dialed is the moved channel.
    if (
      markerNamesSource &&
      world.currentChannelId === world.from &&
      world.connNonce === world.pendingConnNonce
    )
      return addressed();
    // S-a (v), step Nb: the named connection is the ghost this session's
    // CONNECTED rejoin replaced, aged from the ORIGINAL drop on the marker's
    // own two windows. Past the notice window it stays `moved-elsewhere`.
    const replacedAgeMs =
      connectedToSource &&
      world.connNonce === world.replacedConnNonce &&
      world.replacedLeftAt !== undefined
        ? world.now - world.replacedLeftAt
        : undefined;
    if (replacedAgeMs !== undefined && replacedAgeMs < MOVE_VERIFIED_WINDOW_MS)
      return addressed();
    if (replacedAgeMs !== undefined && replacedAgeMs < MOVE_NOTICE_WINDOW_MS)
      return { action: "fail-loud", reason: "stale-notice" };
    return { action: "fail-loud", reason: "moved-elsewhere" };
  }

  // Steps 3 and 4 — the two addressed shapes, and the only ones that may act.
  // Step 4 accepts the claim only with the proof beside it: the nonce when the
  // gate is active (and unequal already returned above), the device when it
  // is not.
  const labelMatches = nonceGate ? nonceMatches : deviceMatches;
  if (connectedToSource || (markerIsFresh && labelMatches)) return addressed();

  // Step 5. The marker says we were the one moved and nothing here can confirm
  // or deny it, because the event names no device id (the token was minted
  // for a bare identity), so there is nothing to match. Refuse to redeem the
  // token — an unattended seat holding a handoff's marker would otherwise
  // publish a microphone into an empty room — and say so out loud, so the
  // session that really was moved gets a Rejoin instead of silence. See the
  // 🔴 note above for the trade this encodes and the per-connection nonce that
  // retires it wherever both sides carry one.
  //
  // With the gate inactive, `!deviceKnown` is the whole remaining case: step 1
  // already returned for a named device that is not ours, and a named device
  // that IS ours took step 4 above, so a fresh marker reaching this line can
  // only be an unverifiable seat. With the gate active a fresh marker never
  // gets here (equal took step 4, unequal returned inside the gate-active
  // test above, S-a arms included), and
  // `!nonceGate` says so rather than leaving it to the order of the arms.
  if (markerIsFresh && !nonceGate && !deviceKnown)
    return { action: "fail-loud", reason: "unverified-session" };

  // Step 6. Inside the notice window, past the verified one: too late to act,
  // on EITHER population — the verified session whose token is past relying
  // on, and the unverifiable one alike. Both are, or recently were, dialling
  // the old channel back, so silence here reverses the moderator with nobody
  // told.
  if (markerNamesSource) return { action: "fail-loud", reason: "stale-notice" };

  // Step 7.
  return {
    action: "ignore",
    // Connected, just not to this one — versus in no call at all.
    reason: world.callState === "CONNECTED" ? "other-channel" : "not-in-call",
  };
}

import { TRIGGERS, dndzone } from "solid-dnd-directive";
import {
  Accessor,
  For,
  JSX,
  Setter,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { claimSlideGesture } from "../navigation/SlideDrawer";

interface Props<T> {
  type?: string;
  items: Item<T>[];
  disabled?: boolean;
  dragHandles?: boolean;
  /**
   * Offer press-and-hold as a way to pick a row up, for callers that have no
   * usable handle affordance — a phone, where the handle is a 20px target.
   *
   * This is the **only** switch for the press-and-hold layer. It is
   * deliberately not implied by `dragHandles`: every list that renders handles
   * would otherwise gain a hold gesture it never asked for, and on
   * `ServerRoleOverview` — `dragHandles`, no `disabled` — a hold anywhere on a
   * role row would arm at `LONG_PRESS_MS`, claim the application-wide gesture
   * and finish by writing a new role ranking to the server. A rank write is a
   * permissions change, and it must not be reachable from a hold on a list the
   * user meant to scroll. A caller that wants hold-anywhere says so here, as
   * `ServerRoleOverview` now does on phones.
   *
   * Must be **constant for the whole life of the component**: pass something
   * assigned once, such as `useDevice().isMobile`. It is captured with
   * `untrack` and every site reads the captured value, because the two halves
   * of the gesture cannot be kept in step otherwise — the listener in
   * `onMount` is installed a single time, while the `dragDisabled` effect
   * re-runs. The destructive direction is true → false: the effect arms the
   * zone, no long-press layer is left to re-arm it, and the library's
   * non-passive `touchmove` handler calls `preventDefault()` as its first
   * line, so the list can never be scrolled again for the rest of its life.
   *
   * A mode the user turns on and off — a reorder mode — is gated with
   * `disabled`, which *is* safe to make reactive: it is read through
   * `isDisabled()` and re-checked in `start()` and `pickUp()`. In DEV a
   * `console.warn` fires the moment this prop changes, so a caller finds out
   * at once instead of shipping a feature that quietly never arms.
   */
  longPress?: boolean;
  children: (item: {
    item: T;
    dragDisabled: Accessor<boolean>;
    setDragDisabled: Setter<boolean>;
  }) => JSX.Element;
  onChange: (ids: string[]) => void;
  minimumDropAreaHeight?: string;
}

type Item<T> = { id: string } & T;

/**
 * How long a finger has to rest on a row before it picks the row up.
 *
 * Long enough that flicking the list past does not trip it, short enough that
 * somebody deliberately holding does not give up first.
 */
const LONG_PRESS_MS = 400;

/**
 * How far the finger may drift during that hold before it counts as a scroll
 * rather than a press.
 */
const LONG_PRESS_SLOP_PX = 10;

/**
 * The dnd zone library requires you to have an id key
 */
interface ContainerItem<T> {
  id: string;
  item: T;
}

interface DragHandleEvent<T> {
  detail: {
    items: ContainerItem<T>[];
    /**
     * Why the library raised this event.
     *
     * `svelte-dnd-action` puts it on every `consider` and `finalize` it
     * dispatches (`src/helpers/dispatcher.js`, `Info.trigger`), and the values
     * are its `TRIGGERS` enum. Optional here only because this is our own hand
     * declaration of the library's event and a defensive read costs nothing.
     */
    info?: { trigger?: TRIGGERS };
  };
  type: "consider" | "finalize";
}

/**
 * Typescript removes dndzone because it thinks that it is not being used.
 * This trick prevents that from happening.
 * https://github.com/solidjs/solid/issues/1005#issuecomment-1134778606
 */
void dndzone;

/**
 * Resolve the row a touch landed in *within a given zone*, i.e. the direct
 * child of that zone which contains the element the finger is over.
 *
 * Scoped to one zone on purpose. Zones nest here — the channel list renders
 * its own `Draggable` inside a category row of the categories `Draggable` — so
 * "walk up to whatever has a zone for a parent" would hand the outer instance
 * a row belonging to the inner one, and it would then arm its own zone and
 * begin a drag on an element that is not its child.
 */
function rowOf(zone: HTMLElement, target: EventTarget | null) {
  let el = target instanceof Element ? target : null;
  while (el && el.parentElement !== zone) el = el.parentElement;
  return (el as HTMLElement | null) ?? undefined;
}

/**
 * Whether a touch landed inside a drop zone nested within this one.
 *
 * One `touchstart` inside a nested list bubbles through both zones, so both
 * would otherwise start a hold timer. Only the innermost zone owns the row
 * under the finger; the outer one has to stay out of the way, or holding a
 * channel would pick its whole category up.
 *
 * The contract that buys for callers: **nested `Draggable`s have to be enabled
 * together.** This only asks whether an inner zone exists, never whether that
 * inner zone is currently accepting drags, so if two nested zones are gated by
 * different `disabled` expressions there is a region where the inner one bails
 * on `disabled` and the outer one bails here — a long press over those rows
 * does nothing at all, and it reads as flakiness rather than as a rule. An
 * `aria-disabled` test is not the way out: the library sets that from
 * `dragDisabled`, which under `longPress` is `true` in the idle state, so it
 * would veto exactly the case worth catching. Keep both zones' `disabled`
 * expressions in agreement while a reorder mode is on.
 */
function inNestedZone(zone: HTMLElement, target: EventTarget | null) {
  let el = target instanceof Element ? target : null;
  while (el && el !== zone) {
    if (el.hasAttribute("data-dnd-zone")) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Start the drop zone's own pointer drag for a touch that is already down.
 *
 * The library only ever begins a drag from a `touchstart` or `mousedown` on the
 * row, and it only listens for those while dragging is enabled. Enabling it is
 * what the press-and-hold layer below does — but by then the touch that
 * enabled it has bubbled past, so nothing is left to start the drag. Replaying
 * the touch is what turns a hold into a drag inside the same gesture; every
 * `touchmove` after it is picked up by the window listeners the library adds
 * in response.
 *
 * A mouse press stands in where `TouchEvent` cannot be constructed (older
 * WebKit). It arms the same code path, but the library then also watches
 * `mousemove`, so on a device that has both a finger and a pointer an idle
 * mouse twitch can start the drag early.
 */
function beginPointerDrag(row: HTMLElement, touch: Touch) {
  try {
    row.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      }),
    );
  } catch {
    row.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
      }),
    );
  }
}

/**
 * Whether a touch list carries the touch with this identifier.
 *
 * Mirrors `tracked()` in the press-and-hold layer below. A gesture belongs to
 * one finger, and everything that ends one has to say which: a second finger
 * landing and lifting — constant in one-handed use — raises its own `touchend`
 * on `window`, and an unfiltered handler would hand the drawers back and stop
 * swallowing the synthetic click while the first finger is still dragging.
 */
function hasTouch(touches: TouchList, identifier: number) {
  for (let i = 0; i < touches.length; i++)
    if (touches[i].identifier === identifier) return true;
  return false;
}

/**
 * The gesture currently handed to a drag, if any
 */
let claimedGesture: (() => void) | undefined;

/**
 * Longest a claim may outlive everything that was supposed to end it.
 *
 * Nothing should ever reach this. It exists because the cost of a claim that
 * leaks is the entire application, so the claim is not allowed to have only
 * exits that depend on an event actually being delivered.
 */
const CLAIM_WATCHDOG_MS = 30_000;

/**
 * How many times the watchdog may believe `isLive()` before it stops asking.
 *
 * The backstop exists to bound a leaked claim, so it must not be capable of
 * deferring forever: any state that pins `isLive()` true — a `dragging` flag
 * latched by an event that never had a counterpart, a row that stays connected
 * because it was never the one dragged — would otherwise hold the capture-phase
 * `click` and `contextmenu` blockers, and both slide drawers, for the life of
 * the page. Ten re-arms caps the claim at eleven expiries, because the
 * expiry that gives up is itself a whole `CLAIM_WATCHDOG_MS` — five and a
 * half minutes, not five. Longer than any real autoscroll reorder, and
 * finite for an orphan.
 */
const CLAIM_WATCHDOG_MAX_REARMS = 10;

/**
 * Take the current touch gesture for a drag until the returned function is
 * called, or the finger that claimed it lifts.
 *
 * Three things want it otherwise: the slide drawers, which read its sideways
 * component as a page swipe, the click the browser synthesises at the end of
 * it, which would open whatever the row navigates to, and the context menu.
 *
 * A leaked claim is the worst failure this file can produce. The capture-phase
 * `click` blocker below swallows *every* click in the application, no context
 * menu opens anywhere, and both slide drawers stay dead — with a page reload
 * as the only recovery. And the finger cannot be trusted to end it on its own:
 * the claim is taken at `LONG_PRESS_MS`, but the library only adopts and
 * re-attaches the dragged row once the finger has travelled its 3px, so a row
 * that leaves the DOM in between (a websocket `ChannelDelete` rewriting
 * `props.items`, say) takes the `touchend` with it — dispatched to a detached
 * node, it never reaches `window`.
 *
 * So the claim is given more exits than the one: the releaser returned here
 * (called from `finalize` and from the owner's `onCleanup`), the window losing
 * focus, the document being hidden, and a watchdog that answers to nothing at
 * all. Every one of them is idempotent. Do not "simplify" this back down to a
 * single `touchend`.
 * @param identifier identifier of the touch making the claim
 * @param options `onRelease`, the caller's own teardown, run from every one of
 * those exits; `isLive`, asked only by the watchdog, see `armWatchdog`
 */
function claimTouchGesture(
  identifier: number,
  options?: { onRelease?: () => void; isLive?: () => boolean },
): () => void {
  const { onRelease, isLive } = options ?? {};

  /**
   * Whether this caller got the application-wide half of the claim.
   *
   * Only one gesture may hold the blockers and the drawers at a time, but a
   * caller that loses that race still gets the whole exit wiring below, and in
   * particular still gets `onRelease`. A caller's teardown is what puts
   * `dragDisabled` back and detaches its own `window` listeners, so running it
   * only on the winning path is precisely how a list ends up armed forever and
   * unscrollable. Losing costs the caller the blockers, never its cleanup.
   *
   * The press-and-hold layer below is the one caller and it passes both
   * options; the drag handle takes no claim at all, since its touch path went
   * back to base. Do not make the teardown conditional on `won`.
   */
  const won = !claimedGesture;

  const releaseDrawers = won ? claimSlideGesture() : undefined;
  const blockClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  /**
   * Android raises `contextmenu` from a long press of its own at around 500ms
   * — a hundred milliseconds after we pick the row up at 400 — so without this
   * the very gesture that starts a reorder also opens the row's context menu
   * on top of the drag. `preventDefault` alone is the right tool and is
   * enough: `components/ui/directives/floating.ts` bails on
   * `event.defaultPrevented` before opening our menu. Do not add
   * `stopPropagation` — it would blind everything else on the page to a
   * gesture we only wanted to veto.
   */
  const blockMenu = (e: Event) => e.preventDefault();

  if (won) {
    window.addEventListener("click", blockClick, true);
    window.addEventListener("contextmenu", blockMenu, true);
  }

  let released = false;

  /**
   * Give the gesture back. Runs at most once however many exits fire.
   */
  const release = () => {
    if (released) return;
    released = true;

    clearTimeout(watchdog);
    window.removeEventListener("touchend", end);
    window.removeEventListener("touchcancel", end);
    window.removeEventListener("blur", release);
    document.removeEventListener("visibilitychange", hide);

    releaseDrawers?.();
    // only clear the global if it is still ours: a later claim may already
    // have taken it, and stomping it would strand that one instead
    if (claimedGesture === release) claimedGesture = undefined;

    // the click lands after touchend, so the blockers have to outlive it
    if (won)
      setTimeout(() => {
        window.removeEventListener("click", blockClick, true);
        window.removeEventListener("contextmenu", blockMenu, true);
      }, 50);

    // The caller's own teardown. It lives here, not at the one exit the
    // caller happens to have wired up itself, because the interesting exits
    // are the ones it cannot see: a row detached before the library adopted
    // it never delivers the lift the caller is listening for, and a teardown
    // that is skipped leaves `dragDisabled` at `false` — an armed zone whose
    // non-passive `touchmove` handler `preventDefault`s every scroll, for the
    // rest of the list's life. Do not move this back into a `touchend`.
    onRelease?.();
  };

  /**
   * End the claim when the finger that made it lifts — and only that finger;
   * see `hasTouch` for the second-finger case this filter exists for
   * @param e
   */
  const end = (e: TouchEvent) => {
    if (hasTouch(e.changedTouches, identifier)) release();
  };

  /**
   * Backstop for a gesture that ends somewhere we cannot watch: the tab going
   * to the background mid-drag, which delivers `visibilitychange` and often
   * nothing else
   */
  const hide = () => {
    if (document.hidden) release();
  };

  /**
   * How many times the backstop has already deferred to `isLive`
   */
  let rearms = 0;

  /**
   * Arm — or re-arm — the backstop that ends a claim nothing else will.
   *
   * It has to ask whether the gesture is still live first. Firing
   * unconditionally un-protects a drag that is merely *slow*: a long reorder
   * with autoscroll can pass 30s inside one gesture, and releasing there
   * hands the drawers back and drops the click blocker while the finger is
   * still down. Nothing re-claims afterwards — `finalize`'s release finds the
   * claim already spent and is a no-op — so the next sideways segment of the
   * same drag swipes the slide drawer open underneath it.
   *
   * Re-arming instead costs another 30s of patience in the one case where the
   * caller can still see the gesture, and gives up nothing in the case the
   * watchdog exists for: an orphaned claim has no live drag to report, so it
   * is still collected on the first expiry.
   *
   * The re-arms are capped, because a backstop that can be deferred forever is
   * not a backstop: `isLive()` is answered by state this file keeps — today
   * the press-and-hold layer's `dragging` flag — and a bug that pins it true
   * would otherwise hold the application-wide blockers indefinitely, the exact
   * outcome this exists to bound. After `CLAIM_WATCHDOG_MAX_REARMS` deferrals
   * the claim is released whatever `isLive()` says.
   */
  function armWatchdog(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (isLive?.() && rearms < CLAIM_WATCHDOG_MAX_REARMS) {
        rearms++;
        watchdog = armWatchdog();
        return;
      }

      release();
    }, CLAIM_WATCHDOG_MS);
  }

  // armed before any listener, so that nothing can reach `release` — and the
  // `clearTimeout` inside it — before this exists
  let watchdog = armWatchdog();

  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
  // neither of these depends on a touch event reaching us at all. Bubble
  // phase on purpose: element `blur` does not bubble, so only the window
  // losing focus lands here — as a capture-phase listener this would also see
  // every field blur on the page and end drags at random
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", hide);

  if (won) claimedGesture = release;
  return release;
}

/**
 * Draggable list container
 */
export function Draggable<T>(props: Props<T>) {
  /**
   * Whether this list offers press-and-hold — captured once, on purpose.
   *
   * The gate in `onMount` runs a single time and the effect below re-runs, so
   * reading the live prop in one and not the other lets the two disagree; the
   * true → false direction leaves the zone armed with nothing to re-arm it and
   * the list permanently unscrollable. Taking the value `untrack`ed makes that
   * disagreement structurally impossible. See the prop's JSDoc for the gating
   * a caller should reach for instead (`disabled`).
   */
  const longPress = untrack(() => props.longPress) ?? false;

  if (import.meta.env.DEV) {
    /**
     * Say so immediately when a caller passes a signal to a prop that is read
     * once, rather than letting it ship a feature that quietly never arms
     */
    createEffect(() => {
      if ((props.longPress ?? false) !== longPress)
        console.warn(
          "[Draggable] `longPress` changed after mount; the change was ignored " +
            "because the prop is captured once. Gate a reorder mode with " +
            "`disabled` instead.",
        );
    });
  }

  const [dragDisabled, setDragDisabled] = createSignal(
    // eslint-disable-next-line solid/reactivity
    props.dragHandles || longPress,
  );

  const [containerItems, setContainerItems] = createSignal<ContainerItem<T>[]>(
    [],
  );

  let zone!: HTMLDivElement;
  let dragging = false;

  /**
   * Releaser for the gesture claim this instance is holding, if any
   */
  let releaseGesture: (() => void) | undefined;

  /**
   * The row that claim was taken for, so that we can tell whether it is still
   * in the document. Cleared with the claim: a stale reference here would
   * eventually point at a detached node and release a later, healthy claim.
   */
  let claimedRow: HTMLElement | undefined;

  /**
   * Hand the gesture back, if this instance is the one holding it.
   *
   * Deliberately goes through the releaser handed to *us*, so that an instance
   * can never free a claim belonging to another one. Idempotent, because the
   * claim has several exits and any of them may be first.
   */
  function releaseClaim() {
    const release = releaseGesture;
    releaseGesture = undefined;
    claimedRow = undefined;
    release?.();
  }

  /**
   * Release a claim whose row has left the document.
   *
   * This is the routine case the watchdog must not be left to answer for. A
   * row is claimed 400ms into a hold but the library does not adopt it until
   * the finger has travelled 3px, and a `ChannelDelete` or `ServerUpdate`
   * landing in between — ordinary traffic on a busy server — takes the row out
   * from under the finger. The lift is then dispatched to a detached node and
   * never reaches `window`, so nothing else here can notice.
   *
   * `isConnected` is what makes this safe to do at all: a row still in the
   * document means the drag can yet start normally and must keep its
   * protection, and only a detached one proves the claim is already orphaned.
   * The `dragging` guard covers the other direction — a live drag re-parents
   * its row, and that must never be read as an orphan.
   */
  function releaseOrphanedClaim() {
    if (!releaseGesture || dragging) return;
    if (claimedRow?.isConnected) return;
    releaseClaim();
  }

  // a row picked up at 400ms is not protected by the library until the finger
  // has moved 3px, and anything that removes it in between takes the finger's
  // `touchend` with it — so every moment we can still notice has to release.
  // This is the one for the whole list going away.
  onCleanup(releaseClaim);

  createEffect(() => setDragDisabled(props.dragHandles || longPress));

  createEffect(() => {
    const newContainerItems = props.items.map((item) => ({
      id: item.id,
      item,
    }));

    setContainerItems(newContainerItems);

    // This is where a row under a resting finger disappears — see
    // `releaseOrphanedClaim`. Deferred to a microtask on purpose: the write
    // above only queues the `<For>`, so the node is still connected at this
    // point in the effect body and checking here would answer "still there"
    // every time. Scheduled only while this instance actually holds a claim.
    if (releaseGesture) queueMicrotask(releaseOrphanedClaim);
  });

  /**
   * Whether this zone should still consider itself part of a running drag.
   *
   * `dragging` used to be `e.type === "consider"`, cleared only by `finalize`
   * — and the library dispatches `finalize` to two zones (the one holding the
   * shadow element and the origin), while it dispatches `consider` to *every*
   * zone the item enters or leaves. The sidebar renders one channels zone per
   * category, so a channel dragged out of A, across B and dropped in C leaves
   * B latched `dragging === true` for the rest of that component's life. Every
   * guard that reads it then bails forever: `start()` and `pickUp()` refuse,
   * so press-and-hold is dead in that one category — an intermittent dead
   * feature that only appears after a drag happened to pass through.
   *
   * The naive de-latch is wrong in the other direction. `draggedLeft` is also
   * dispatched to the *origin* zone when the item leaves it, and that zone is
   * the one holding the gesture claim: clearing `dragging` there tells the
   * watchdog's `isLive` that nothing is running, and the claim is dropped
   * mid-drag — the blockers go, and the next sideways stretch of the same
   * finger swipes a slide drawer open underneath the drag.
   *
   * So a `draggedLeft` clears only on a zone holding no claim, which is
   * exactly "the item left me and it was never mine". Everything else on a
   * `consider` means the drag is here or came back (`draggedLeftAll` puts the
   * shadow element back in the origin), and `finalize` always ends it.
   * @param e
   */
  function isStillDragging(e: DragHandleEvent<T>) {
    if (e.type !== "consider") return false;
    if (e.detail.info?.trigger === TRIGGERS.DRAGGED_LEFT && !releaseGesture)
      return false;
    return true;
  }

  /**
   * Handle DND event from solid-dnd-directive
   * @param e
   */
  function handleDndEvent(e: DragHandleEvent<T>) {
    dragging = isStillDragging(e);
    setDragDisabled(props.dragHandles || longPress);

    const { items: newContainerItems } = e.detail;
    setContainerItems(newContainerItems);

    if (e.type === "finalize") {
      // the drag is over as far as the library is concerned, so give the
      // gesture back here too rather than waiting on a `touchend` that may
      // have been dispatched to a row that no longer exists
      releaseClaim();

      props.onChange(
        newContainerItems.map((containerItems) => containerItems.id),
      );
    }
  }

  function isDisabled() {
    return props.disabled || dragDisabled();
  }

  onMount(() => {
    // Press and hold anywhere on a row to pick it up.
    //
    // The handle is a pointer affordance: on a phone it is a 20px target and
    // the rest of the row does nothing, so the natural gesture — hold the row
    // and move it — reached the settings drawer instead and swiped the whole
    // page away. Holding arms exactly the drag the handle arms.
    //
    // `longPress` alone, never `props.dragHandles`: opting a zone in merely
    // because it renders handles changes shipped surfaces that never asked
    // for a gesture. `ServerRoleOverview` passes `dragHandles` and no
    // `disabled`, so every role row on a phone would start a hold timer, and
    // the hold that completed would claim the application-wide gesture,
    // vibrate, begin a drag, and end in `finalize` → `onChange` →
    // `setRoleOrdering` — a server-side permissions write reached by holding a
    // list the user meant to scroll, with the library's non-passive
    // `touchmove` eating that scroll on the way. Hold-anywhere is a feature a
    // caller asks for by name. (`ServerRoleOverview` now does, on phones, and
    // drops a drag that ends in the order it started before it is saved.)
    //
    // Read the captured constant, never `props.longPress`: this gate runs a
    // single time while the effect above re-runs, and a live read here would
    // let the two disagree in both directions — no listener when the value
    // turns on, and worse, an armed zone with no listener left to re-arm it
    // when the value turns off. Capturing is what makes that unrepresentable;
    // do not "fix" this into a reactive gate, gate with `disabled`.
    if (!longPress) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let row: HTMLElement | undefined;
    let point: Touch | undefined;
    let id = -1;
    let startX = 0,
      startY = 0;

    /**
     * Give up on the hold that is being timed, without touching a drag that
     * has already started from it
     */
    function stopTimer() {
      clearTimeout(timer);
      timer = undefined;
      row = undefined;
      point = undefined;
    }

    /**
     * Stop following this gesture entirely
     */
    function detach() {
      stopTimer();
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    }

    /**
     * Find the touch this gesture is tracking
     */
    function tracked(touches: TouchList) {
      for (let i = 0; i < touches.length; i++)
        if (touches[i].identifier === id) return touches[i];
    }

    /**
     * Hand the row under the finger to the drop zone
     */
    function pickUp() {
      const target = row,
        at = point;
      stopTimer();
      if (!target || !at || props.disabled || dragging) return;

      // a fresh pick-up means the previous gesture is over however badly it
      // ended, so hand back anything still held first. `releaseGesture` holds
      // exactly one releaser, and the assignment below overwrites it: a claim
      // that is still parked there when that happens can never be freed by
      // anything of ours again — not by `onCleanup`, not by `finalize` — and a
      // claim that leaks takes the capture-phase `click` and `contextmenu`
      // blockers and both slide drawers with it, until the page is reloaded.
      // Releasing first is what keeps that unreachable.
      releaseClaim();

      // keep the releaser, and the row it was taken for: the finger lifting is
      // only one of the ways this claim can have to end, it is the one that
      // can go missing, and the row is how we find out that it has
      // `isLive` keeps the watchdog off a drag that is only slow: autoscroll
      // through a long list can spend more than `CLAIM_WATCHDOG_MS` inside a
      // single gesture, and a release there would drop the blockers mid-drag.
      //
      // `onRelease` is this layer's own teardown, and it belongs here rather
      // than only in `end()` because `end()` is precisely the exit that goes
      // missing. It listens on `window`, and the lift for a row detached
      // before the library adopted it is dispatched to a node with no path to
      // `window` — the case this claim grew its other exits for. Those exits
      // (the watchdog, `blur`, `visibilitychange`, and `releaseOrphanedClaim`
      // going through the releaser) all run through `release`, so wiring the
      // teardown there is what makes them complete. Without it they hand the
      // gesture back and leave this zone armed: `dragDisabled` false, the
      // library's non-passive `touchmove` handler `preventDefault`ing every
      // scroll for the rest of the list's life, and the listeners below still
      // on `window`.
      releaseGesture = claimTouchGesture(id, {
        isLive: () => dragging,
        onRelease: () => {
          // Spend this instance's bookkeeping along with the claim.
          //
          // `release()` is reached from exits that never go through
          // `releaseClaim()` — the watchdog, the window `blur` handler, the
          // `visibilitychange` handler and the claim's own
          // identifier-filtered `touchend` — and every one of them would
          // otherwise leave `releaseGesture` and `claimedRow` pointing at a
          // claim that is already spent. Two readers take a truthy
          // `releaseGesture` to mean "a live claim", and both fail closed on
          // a stale one: `isStillDragging` reads it as "this drag is still
          // mine", so a `DRAGGED_LEFT` consider can never de-latch
          // `dragging` and press-and-hold is dead on this zone for the rest
          // of its life; and `start()` below refuses to arm a hold while a
          // claim is held, so the gesture would be wedged from that side
          // too. Clearing here rather than at each exit is what makes every
          // exit complete, including exits added later.
          //
          // No cycle and no double release: `release()` sets its `released`
          // flag *before* calling this, so the `release?.()` at the end of
          // `releaseClaim()` cannot re-enter, and this clears the two fields
          // directly instead of calling `releaseClaim()` back. When the exit
          // *was* `releaseClaim()`, it has already nulled them — redundant,
          // never contradictory. And a claim is never left parked: `pickUp`
          // calls `releaseClaim()` synchronously before it installs the next
          // one, so a spent claim can never null a successor's releaser.
          releaseGesture = undefined;
          claimedRow = undefined;

          // safe on the paths that already detached (`end`, the slop bail in
          // `move`, the owner's `onCleanup`): `stopTimer` tolerates a cleared
          // timer and `removeEventListener` a listener already gone
          detach();

          // never disarm a drag out from under itself. The watchdog's re-arm
          // cap can spend a claim while a real drag is still running, and
          // that drag needs the zone left as `handleDndEvent` set it until
          // `finalize`. The expression has to match every other disarm site
          // exactly — the captured `longPress`, never `props.longPress`; see
          // the prop's JSDoc for why the two must not be allowed to differ.
          if (!dragging) setDragDisabled(props.dragHandles || longPress);
        },
      });
      claimedRow = target;
      // arms the drop zone's own pointer listeners, synchronously
      setDragDisabled(false);
      navigator.vibrate?.(8);
      beginPointerDrag(target, at);
    }

    /**
     * Track the finger while the hold is being timed
     * @param e
     */
    function move(e: TouchEvent) {
      if (!timer) return;
      const touch = tracked(e.changedTouches);
      if (!touch) return;

      point = touch;

      // a finger that travels is scrolling the list, not picking a row up
      if (
        Math.abs(touch.clientX - startX) > LONG_PRESS_SLOP_PX ||
        Math.abs(touch.clientY - startY) > LONG_PRESS_SLOP_PX
      )
        detach();
    }

    /**
     * Finish following a gesture once the finger lifts
     * @param e
     */
    function end(e: TouchEvent) {
      if (!tracked(e.changedTouches)) return;
      detach();

      // the claim's own identifier-filtered `end` is releasing on this very
      // event, so this is bookkeeping rather than a behaviour change — but
      // without it `releaseGesture` and `claimedRow` stay truthy after the
      // claim is spent, and every later `props.items` change then schedules a
      // `releaseOrphanedClaim` microtask with nothing left to release
      releaseClaim();

      // a hold that never became a drag leaves the list armed; re-arm the
      // handle so the next touch scrolls instead of dragging. No-op while a
      // drag is running, which already reset this on its first event.
      if (!dragging) setDragDisabled(props.dragHandles || longPress);
    }

    /**
     * Begin timing a hold on one of this zone's own rows
     * @param e
     */
    function start(e: TouchEvent) {
      // `releaseGesture` is a re-entrancy guard, and it is not optional.
      //
      // `pickUp` arms the library by dispatching a synthetic `touchstart`
      // onto the row (`beginPointerDrag`), and the row is this zone's own
      // child — so that replay bubbles straight back into this listener.
      // Usually it is swallowed on the way up: `svelte-dnd-action`'s
      // `handleMouseDown` is on the row by then (`setDragDisabled(false)`
      // flushes the directive's effect synchronously, which re-attaches it)
      // and it calls `stopPropagation()` as soon as it accepts the press.
      // It does *not* call it on its refusal paths, and one of those is
      // routine: `isWorkingOnPreviousDrag` is a module-global the library
      // clears only in `cleanupPostDrop`, which it schedules on a
      // `setTimeout(dropAnimationDurationMs)` after a drop. A long press
      // landing in that window is refused with no `stopPropagation`, the
      // replay reaches this listener, and by then `stopTimer()` has cleared
      // `timer` while `dragging` is still false — nothing but the library's
      // first `consider` sets it, and the drag it would have come from was
      // just refused. So the hold re-arms on its own pick-up and the same
      // resting finger is picked up again every `LONG_PRESS_MS`: measured
      // 1 → 2 → 3 claims and three `navigator.vibrate` buzzes across
      // 3 × `LONG_PRESS_MS`, and it only stops when the finger lifts.
      //
      // Testing the claim rather than a one-shot latch is what keeps a
      // *legitimate* second gesture working: `releaseGesture` is cleared at
      // every exit the claim has (see `onRelease` below), so the next touch
      // after this one has fully ended arms normally. A latch set only here
      // would instead wedge press-and-hold permanently the first time a
      // claim ended somewhere this layer cannot see.
      if (
        timer ||
        dragging ||
        releaseGesture ||
        props.disabled ||
        e.touches.length !== 1
      )
        return;

      // a touch inside a nested list belongs to that list's own zone; see
      // `inNestedZone` for why the outer zone must not also arm here
      if (inNestedZone(zone, e.target)) return;

      const target = rowOf(zone, e.target);
      if (!target) return;

      const touch = e.touches[0];
      id = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
      point = touch;
      row = target;

      window.addEventListener("touchmove", move, { passive: true });
      window.addEventListener("touchend", end);
      window.addEventListener("touchcancel", end);
      timer = setTimeout(pickUp, LONG_PRESS_MS);
    }

    zone.addEventListener("touchstart", start, { passive: true });
    onCleanup(() => {
      zone.removeEventListener("touchstart", start);
      detach();
    });
  });

  return (
    <div
      ref={zone}
      data-dnd-zone
      use:dndzone={{
        type: props.type,
        items: containerItems,
        dragDisabled: isDisabled,
        flipDurationMs: 0,
        // transformDraggedElement: (el?: HTMLElement) => {
        //   if (el) {
        //     el.style.cursor = "grabbing !important";
        //     el.style.outline = "1px solid red";
        //   }
        // },
        dropTargetStyle: {
          outline:
            "2px solid color-mix(in srgb, 40% var(--md-sys-color-primary), transparent)",
          borderRadius: "4px",
          outlineOffset: "-2px",
          minHeight: "24px",
        },
      }}
      // @ts-expect-error missing jsx typing
      on:consider={handleDndEvent}
      on:finalize={handleDndEvent}
    >
      <For each={containerItems()}>
        {(containerItem) =>
          props.children({
            item: containerItem.item,
            dragDisabled,
            setDragDisabled,
          })
        }
      </For>
    </div>
  );
}

/**
 * Build the props that turn an element into a drag handle for its row.
 *
 * The touch path here is deliberately the same one-liner as the pointer path —
 * `preventDefault`, arm the zone, nothing else — because that is what shipped.
 * It briefly did more: take the application-wide gesture claim and replay the
 * touch onto the row, which would have made the role list and the sidebar
 * category header draggable by finger for the first time. That may well be
 * worth doing, but it is a change to two live screens (`ServerRoleOverview`,
 * `ServerSidebar`) that has never been tried on a device, and it was arriving
 * as a side effect of a mobile reorder mode that neither screen opts into. A
 * handle that is inert on touch is the behaviour those screens have today;
 * changing it is a separate, deliberate change with its own device testing.
 *
 * Worth knowing before anyone "fixes" the inertness here: Solid delegates
 * `touchstart` to `document`, so the drop zone's own row listener is attached
 * an event too late to see the touch that armed it, and a delegated
 * `touchstart` is forced passive, so the `preventDefault` below cannot take
 * effect either. Both were already true before this file grew a gesture layer.
 * A working touch handle needs a non-delegated `on:touchstart` and a replayed
 * pointer event — and, because it would then hold the application-wide claim,
 * it also needs a refusal guard, which this function does not have and would
 * have to be given. There is no such guard here today: nothing tells the
 * handle whether its zone refuses drags outright, so a touch path added
 * without one would claim the gesture on a zone that was always going to
 * refuse the drag. `ServerSidebar` spreads a handle onto the category header,
 * which is also the element that toggles the category and carries its context
 * menu, and that zone is disabled on mobile — a claim taken there installs
 * capture-phase `click` and `contextmenu` blockers that eat exactly that tap.
 * That regression has shipped once already. Anyone reviving the touch path
 * must re-add the zone's standing refusal (the `Draggable` caller's own
 * `disabled`, *not* `isDisabled()`, which folds in `dragDisabled()` and is
 * `true` in the idle state of every handle list) and run a device leg.
 * Press-and-hold (`longPress` on `Draggable`) is the supported way to pick a
 * row up with a finger.
 * @param dragDisabled the zone's arming state, from `Draggable`'s children
 * @param setDragDisabled its setter, likewise
 */
export function createDragHandle(
  dragDisabled: Accessor<boolean>,
  setDragDisabled: Setter<boolean>,
) {
  function startDrag(e: Event) {
    e.preventDefault();
    setDragDisabled(false);
  }

  function endDrag() {
    setDragDisabled(true);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if ((e.key === "Enter" || e.key === " ") && dragDisabled())
      setDragDisabled(false);
  }

  return {
    tabindex: dragDisabled() ? 0 : -1,
    onmouseenter: startDrag,
    ontouchstart: startDrag,
    onmouseleave: endDrag,
    onkeydown: handleKeyDown,
    "aria-label": "drag-handle",
  };
}

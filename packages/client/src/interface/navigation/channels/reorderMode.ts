import { createSignal } from "solid-js";

/**
 * Which server is currently in channel-reorder mode, or `undefined` when no
 * reorder session is open. Entered from the channel/category context menu,
 * consumed by `ServerSidebar` to swap the channel list into its draggable
 * presentation and show the Save/Cancel bar.
 *
 * This module deliberately holds nothing but the server id. The staged
 * channel order lives in `channelReorder.ts` plus component-local state, so
 * that cancelling a session is a single `exitReorderMode()` and can never
 * leave half-applied ordering behind.
 *
 * Three decisions are worth recording, because each has a failure mode that
 * is not obvious from the call sites:
 *
 * 1. It is a module-level signal rather than a context, because the context
 *    menu cannot reach sidebar state any other way. `ChannelContextMenu` is
 *    not rendered where it is written: `src/interface/Sidebar.tsx:249` only
 *    passes a `contextMenu` thunk, which `FloatingManager` invokes at
 *    `components/ui/components/floating/FloatingManager.tsx:196`, inside its
 *    `<Portal mount={document.getElementById("floating")}>` (`:52`,
 *    `index.html:26`). `FloatingManager` is mounted at `src/index.tsx:250`
 *    as a sibling of the whole app subtree (`{props.children}`, `:248`), so
 *    the menu's Solid owner is `FloatingManager`, not `Sidebar` — a provider
 *    placed inside the sidebar is invisible to it, and `useContext` would
 *    resolve to the default value.
 *
 * 2. It is not part of `state.layout`, because that store persists. Every
 *    write goes through `State.write`
 *    (`components/state/index.tsx:128-163`), which queues a
 *    `localforage.setItem` (`:150`) and is rehydrated on boot, so a reorder
 *    mode parked there would survive a reload and come back as a Save/Cancel
 *    bar floating over no pending changes. A transient mode must die with
 *    the page.
 *
 * 3. It is keyed by server id, never a boolean. `src/interface/Sidebar.tsx`
 *    renders the server sidebar under a NON-KEYED
 *    `<Match when={params.server}>` (`:151-155`), so on a server switch
 *    `ServerSidebar` is re-rendered with new props rather than unmounted. A
 *    boolean would leak the mode into the next server; holding the id means
 *    the mode self-cancels on navigation, because the consumer compares
 *    `reorderMode() === props.server.id`.
 */
const [reorderMode, setReorderMode] = createSignal<string | undefined>();

export { reorderMode };

/**
 * Enter channel-reorder mode for a server.
 *
 * Entering for a different server implicitly replaces any open session: the
 * previous sidebar stops matching on the id and drops its staged order.
 * @param serverId Server whose channel list is being reordered
 */
export function enterReorderMode(serverId: string): void {
  setReorderMode(serverId);
}

/**
 * Leave channel-reorder mode.
 *
 * Unconditional, so it is safe to call from Save, from Cancel, and from
 * cleanup paths that do not know whether a session was open.
 */
export function exitReorderMode(): void {
  setReorderMode(undefined);
}

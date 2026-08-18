import {
  createEffect,
  createSignal,
  JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { styled } from "styled-system/jsx";

import { ChannelContextMenu, ServerContextMenu } from "@revolt/app";
import { MessageCache } from "@revolt/app/interface/channels/text/MessageCache";
import { Titlebar } from "@revolt/app/interface/desktop/Titlebar";
import { useClient, useClientLifecycle } from "@revolt/client";
import { ActivityWorker } from "@revolt/client/ActivityWorker";
import { ApkUpdateWorker } from "@revolt/client/ApkUpdateWorker";
import { State } from "@revolt/client/Controller";
import { DiscordImportWorker } from "@revolt/client/DiscordImportWorker";
import { NotificationsWorker } from "@revolt/client/NotificationsWorker";
import { StreamerModeWorker } from "@revolt/client/StreamerModeWorker";
import { IS_OVERLAY_WINDOW, IS_POPOUT_WINDOW } from "@revolt/client/popout";
import { useModals } from "@revolt/modal";
import { Navigate, useBeforeLeave, useLocation } from "@revolt/routing";
import { OverlayBridgeWorker } from "@revolt/rtc/overlay/OverlayBridgeWorker";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { streamerModeActive } from "@revolt/state/streamer";
import { CircularProgress, useLayoutSides } from "@revolt/ui";
import { IncomingCallOverlay } from "@revolt/ui/components/features/voice/IncomingCallOverlay";
import { CallRecordingNotices } from "@revolt/ui/components/features/voice/callCard/CallRecordingNotices";
import { RemoteControlOverlays } from "@revolt/ui/components/features/voice/callCard/RemoteControlOverlays";
import { VoiceTranscriptPanel } from "@revolt/ui/components/features/voice/callCard/VoiceTranscriptPanel";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { SlideDrawer } from "../components/ui/components/navigation/SlideDrawer";
import { Sidebar } from "./interface/Sidebar";

/**
 * Application layout
 */
const Interface = (props: { children: JSX.Element }) => {
  // The friends popout window must never host the full app shell (single
  // full-client model — see @revolt/client/popout): any navigation that
  // escapes /friends-popout (friend double-click, profile-modal actions,
  // the post-login redirect) bounces straight back instead of booting a
  // second set of workers over a web-mode client.
  if (IS_POPOUT_WINDOW) {
    return <Navigate href="/friends-popout" />;
  }

  // Same bounce for the in-game overlay window, and belt-and-suspenders:
  // MountContext has already short-circuited the entire provider stack for
  // it, so `Interface` cannot actually render here — every hook below would
  // be missing its provider if it did.
  if (IS_OVERLAY_WINDOW) {
    return <Navigate href="/voice-overlay" />;
  }

  const state = useState();
  const client = useClient();
  const { openModal } = useModals();
  const { isLoggedIn, lifecycle } = useClientLifecycle();
  const { pathname } = useLocation();
  const sides = useLayoutSides();

  useBeforeLeave((e) => {
    if (!e.defaultPrevented) {
      if (e.to === "/settings") {
        e.preventDefault();
        openModal({ type: "settings", config: "user" });
      } else if (typeof e.to === "string") {
        state.layout.setLastActivePath(e.to);
      }
    }
  });

  createEffect(() => {
    if (!isLoggedIn()) {
      state.layout.setNextPath(pathname);
      console.debug("WAITING... currently", lifecycle.state());
    }
  });

  function isDisconnected() {
    return [
      State.Connecting,
      State.Disconnected,
      State.Reconnecting,
      State.Offline,
    ].includes(lifecycle.state());
  }

  //Drawer slider for mobile
  let rootRef, sDrawer: SlideDrawer | undefined;
  const [contRef, setContRef] = createSignal<HTMLDivElement>();
  // Reset both nav sections to their defaults so the slide drawer owns
  // visibility at phone widths. setSectionState clears the stored override
  // when value === defaultValue, so both calls below drop their override
  // instead of writing one — passing `false` against MEMBER_SIDEBAR's `true`
  // default persisted "members hidden" into the settings store, which then
  // followed the account onto desktop and every later session.
  function rstLayout() {
    state.layout.setSectionState(LAYOUT_SECTIONS.PRIMARY_SIDEBAR, false, false);
    state.layout.setSectionState(LAYOUT_SECTIONS.MEMBER_SIDEBAR, true, true);
  }
  createEffect(() => {
    //Create drawer
    const cont = contRef();
    if (cont && !sDrawer) sDrawer = new SlideDrawer(cont, rootRef!);
    //Update on layout change
    if (sDrawer) {
      const en = sDrawer.enabled;
      setTimeout(() => {
        state.setAppDrawer(en ? sDrawer : undefined);
        if (en) rstLayout();
      }, 1);
    }
  });
  onCleanup(() => {
    sDrawer?.delete();
    state.setAppDrawer((sDrawer = undefined));
  });

  return (
    <MessageCache client={client()}>
      <AppRoot ref={rootRef} class="app_root">
        <Titlebar />
        <Show when={streamerModeActive(state.settings)}>
          <StreamerBanner
            onClick={() => openModal({ type: "settings", config: "user" })}
          >
            <Symbol size={16}>videocam</Symbol>
            <Trans>
              Streamer Mode is on — personal info, invites and notifications are
              hidden
            </Trans>
          </StreamerBanner>
        </Show>
        <Switch fallback={<CircularProgress />}>
          <Match when={!isLoggedIn()}>
            <Navigate href="/login" />
          </Match>
          <Match when={lifecycle.loadedOnce()}>
            {/* file drops are cancelled app-wide by FileDropGuard, mounted
                at the root — this subtree used to do it alone, which left
                modals, portals and the login page navigating away */}
            <Layout
              disconnected={isDisconnected()}
              navRight={sides().nav === "right"}
              style={{ "flex-grow": 1, "min-height": 0 }}
            >
              <Sidebar
                menuGenerator={(target) => ({
                  contextMenu: () => {
                    return (
                      <>
                        {target instanceof Server ? (
                          <ServerContextMenu server={target} />
                        ) : (
                          <ChannelContextMenu channel={target} />
                        )}
                      </>
                    );
                  },
                })}
              />
              <Content
                ref={setContRef}
                class="app_body"
                sidebar={state.layout.getSectionState(
                  LAYOUT_SECTIONS.PRIMARY_SIDEBAR,
                  true,
                )}
                navRight={sides().nav === "right"}
              >
                {props.children}
              </Content>
            </Layout>
          </Match>
        </Switch>

        <NotificationsWorker />
        <ActivityWorker />
        <StreamerModeWorker />
        <ApkUpdateWorker />
        {/* Publishes the in-game overlay's roster/speaking state to the
            overlay window and owns that window's lifetime. Main window only
            — this is the window that owns the LiveKit Room, and
            `isSpeaking` has no other source. */}
        <OverlayBridgeWorker />
        {/* Owns the Discord-import job for the session: the modal may be
            dismissed (or the tab reloaded) while the import runs. */}
        <DiscordImportWorker />
        <IncomingCallOverlay />
        {/* Remote control's offer prompt, session panels and focused-window
            panic handler. APP LEVEL on purpose: every one of these is a way
            to STOP a live control session, and mounting them inside the call
            card meant they all disappeared the moment the user clicked
            another channel and the card flipped to PiP. */}
        <RemoteControlOverlays />
        {/* "Recording saved to …" / "couldn't save it". APP LEVEL for the same
            reason as the overlays above: a recording usually ends by leaving
            the call, which unmounts the call card — mounted there, this would
            be destroyed in the same tick as the message it has to deliver. */}
        <CallRecordingNotices />
        {/* The live transcript and its Export/Copy/Discard controls. APP LEVEL
            for the same reason again, and it was caught the hard way: mounted
            inside the call card, the panel unmounted the instant a call ended
            and took the only route to Export with it, while the transcript sat
            intact and unreachable in memory. */}
        <VoiceTranscriptPanel />
      </AppRoot>
    </MessageCache>
  );
};

const AppRoot = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
});

/**
 * Slim banner shown while Streamer Mode is active
 */
const StreamerBanner = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-sm)",

    padding: "2px var(--gap-md)",
    fontSize: "0.8em",
    fontWeight: 600,
    cursor: "pointer",
    userSelect: "none",

    fill: "var(--md-sys-color-on-error-container)",
    color: "var(--md-sys-color-on-error-container)",
    background: "var(--md-sys-color-error-container)",
  },
});

/**
 * Parent container
 */
const Layout = styled("div", {
  base: {
    display: "flex",
    height: "100%",
    minWidth: 0,
  },
  variants: {
    /**
     * Navigation block on the right. Reversing the row (rather than
     * re-mounting the two children in the other order) keeps `Sidebar` and
     * its `SlideDrawer` / server-reorder state alive across the flip. Never
     * true at phone widths — `useLayoutSides` pins the phone to the default.
     */
    navRight: {
      true: {
        flexDirection: "row-reverse",
      },
    },
    disconnected: {
      true: {
        color: "var(--md-sys-color-on-primary-container)",
        background: "var(--md-sys-color-primary-container)",
      },
      false: {
        color: "var(--md-sys-color-outline)",
        background: "var(--md-sys-color-surface-container-high)",
      },
    },
  },
});

/**
 * Main content container
 */
const Content = styled("div", {
  base: {
    background: "var(--md-sys-color-surface-container-low)",
    display: "flex",
    width: "100%",
    minWidth: 0,
  },
  variants: {
    sidebar: {
      false: {
        overflow: "hidden",
      },
    },
    /**
     * Pack a capped page from the end when the nav is on the right, so the
     * message column hugs the nav from the other side. Direct children that
     * fill the width (`width: 100%` pages) are unaffected.
     */
    navRight: {
      true: {
        justifyContent: "flex-end",
      },
      // Explicit so the compound variants below can match on it.
      false: {},
    },
  },
  defaultVariants: {
    navRight: false,
  },
  // With the channel sidebar collapsed only the server rail is beside this
  // block, and the corner that meets it is rounded — whichever side that is.
  compoundVariants: [
    {
      sidebar: false,
      navRight: true,
      css: {
        borderTopRightRadius: "var(--borderRadius-lg)",
        borderBottomRightRadius: "var(--borderRadius-lg)",
      },
    },
    {
      sidebar: false,
      navRight: false,
      css: {
        borderTopLeftRadius: "var(--borderRadius-lg)",
        borderBottomLeftRadius: "var(--borderRadius-lg)",
      },
    },
  ],
});

export default Interface;

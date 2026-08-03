/**
 * Configure contexts and render App
 */
import "./polyfills";
import "./sentry";

import { JSX, onMount } from "solid-js";
import { render } from "solid-js/web";

import { useLingui } from "@lingui-solid/solid/macro";

import { attachDevtoolsOverlay } from "@solid-devtools/overlay";
import { Navigate, Route, Router, useParams } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import "material-symbols";
import "mdui/mdui.css";
import { DiscoverableServer, PublicBot, PublicChannelInvite } from "stoat.js";

import FlowCheck from "@revolt/auth/src/flows/FlowCheck";
import FlowConfirmReset from "@revolt/auth/src/flows/FlowConfirmReset";
import FlowCreate from "@revolt/auth/src/flows/FlowCreate";
import FlowDeleteAccount from "@revolt/auth/src/flows/FlowDelete";
import FlowHome from "@revolt/auth/src/flows/FlowHome";
import FlowLogin from "@revolt/auth/src/flows/FlowLogin";
import FlowOAuthCallback from "@revolt/auth/src/flows/FlowOAuthCallback";
import FlowResend from "@revolt/auth/src/flows/FlowResend";
import FlowReset from "@revolt/auth/src/flows/FlowReset";
import FlowVerify from "@revolt/auth/src/flows/FlowVerify";
import { ClientContext, SoundContext, useClient } from "@revolt/client";
import { IS_OVERLAY_WINDOW } from "@revolt/client/popout";
import { completeStreamLink } from "@revolt/client/streamConnections";
import { DeviceContext } from "@revolt/common";
import { I18nProvider } from "@revolt/i18n";
import { KeybindContext } from "@revolt/keybinds";
import { ModalContext, ModalRenderer, useModals } from "@revolt/modal";
import { VoiceContext } from "@revolt/rtc";
import { StateContext, SyncWorker, useState } from "@revolt/state";
import {
  ContextMenuGuard,
  FileDropGuard,
  FloatingManager,
  LoadTheme,
  SnackbarController,
  SnackbarProvider,
  useSnackbar,
} from "@revolt/ui";

/* @refresh reload */
import "@revolt/ui/styles";

import { AndroidNag } from "./AndroidNag";
import AuthPage from "./Auth";
import Interface from "./Interface";
import "./index.css";
import { DevelopmentPage } from "./interface/Development";
import { Friends } from "./interface/Friends";
import { FriendsPopout } from "./interface/FriendsPopout";
import { HomePage } from "./interface/Home";
import { ServerEvents } from "./interface/ServerEvents";
import { ServerHome } from "./interface/ServerHome";
import { VoiceOverlayWindow } from "./interface/VoiceOverlayWindow";
import { ChannelPage } from "./interface/channels/ChannelPage";
import { mountIosViewportFix } from "./iosViewport";
import "./serviceWorkerInterface";

attachDevtoolsOverlay();

// Stamp the overlay window BEFORE the first paint. The transparency rule in
// @revolt/ui/styles hangs off this attribute; setting it from an effect would
// paint one frame of the opaque #root rectangle over the user's game.
if (IS_OVERLAY_WINDOW) {
  document.documentElement.dataset.overlay = "1";
}

// iOS Safari: keep #root sized to the visual viewport while the software
// keyboard is up (no-op everywhere else) — see src/iosViewport.ts.
mountIosViewportFix();

/**
 * Redirect PWA start to the last active path
 */
function PWARedirect() {
  const state = useState();
  return <Navigate href={state.layout.getLastActivePath()} />;
}

/**
 * Open settings and redirect to last active path.
 *
 * Also the landing point for the streaming-channel link flow: the OAuth
 * callback redirects here with `stream_complete` (one-time handoff code)
 * or `stream_error` query params (see backend routes/oauth/link.rs).
 */
function SettingsRedirect() {
  const client = useClient();
  const { openModal } = useModals();
  const { t } = useLingui();
  const snackbar = useSnackbar();

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const complete = params.get("stream_complete");
    const platform = params.get("stream_platform");
    const error = params.get("stream_error");

    if (complete && (platform === "twitch" || platform === "youtube")) {
      completeStreamLink(client(), platform, complete)
        .then((connection) =>
          snackbar.show({
            message: t`Linked channel: ${connection.display_name}`,
          }),
        )
        .catch(() =>
          snackbar.show({
            message: t`Failed to link your channel, try again.`,
          }),
        );
    } else if (error) {
      snackbar.show({
        message:
          error === "no_channel"
            ? t`That account has no channel to link.`
            : t`Channel linking failed or was cancelled.`,
      });
    }

    openModal({ type: "settings", config: "user" });
  });
  return <PWARedirect />;
}

/**
 * Open invite and redirect to last active path
 */
function InviteRedirect() {
  const params = useParams();
  const client = useClient();
  const { openModal, showError } = useModals();

  onMount(() => {
    if (params.code) {
      client()
        // TODO: add a helper to stoat.js for this
        .api.get(`/invites/${params.code as ""}`)
        .then((invite) => PublicChannelInvite.from(client(), invite))
        .then((invite) => openModal({ type: "invite", invite }))
        .catch(showError);
    }
  });

  return <PWARedirect />;
}

/**
 * Open a discoverable server's join prompt and redirect to last active path
 * (landing route for sloga.gg/discover "Open Sloga" buttons)
 */
function DiscoverRedirect() {
  const params = useParams();
  const client = useClient();
  const { openModal, showError } = useModals();

  onMount(() => {
    if (params.id) {
      DiscoverableServer.fetch(client(), params.id)
        .then((server) => openModal({ type: "discover_join", server }))
        .catch(showError);
    }
  });

  return <PWARedirect />;
}

/**
 * Open bot invite and redirect to last active path
 */
function BotRedirect() {
  const params = useParams();
  const client = useClient();
  const { openModal, showError } = useModals();

  onMount(() => {
    if (params.code) {
      client()
        // TODO: add a helper to stoat.js for this
        .api.get(`/bots/${params.code as ""}/invite`)
        .then((invite) => new PublicBot(client(), invite))
        .then((invite) => openModal({ type: "add_bot", invite }))
        .catch(showError);
    }
  });

  return <PWARedirect />;
}

function MountContext(props: { children?: JSX.Element }) {
  // The in-game voice overlay window gets NO provider stack at all. It is a
  // passive renderer of BroadcastChannel snapshots — no client is ever
  // constructed, so no WebSocket, no Voice/LiveKit room, no sync worker, no
  // sounds. Short-circuiting here (rather than gating each provider) is what
  // makes that a structural guarantee instead of a list of gates to maintain.
  //
  // The cost is that `VoiceOverlayWindow` and everything under it must live
  // without I18nProvider / ModalContext / KeybindContext / SnackbarProvider —
  // most importantly, NO lingui macros, which throw at runtime and are
  // invisible to both tsc and the extractor. See @revolt/client/popout.
  //
  // `StateContext` and `LoadTheme` sit OUTSIDE the router root and still
  // mount, which is what keeps the `--md-sys-color-*` variables available to
  // the overlay's styles.
  //
  // Early return is safe despite the rule: `IS_OVERLAY_WINDOW` is frozen at
  // module init, so there is no reactivity here for a re-render to observe.
  // eslint-disable-next-line solid/components-return-once
  if (IS_OVERLAY_WINDOW) return <>{props.children}</>;

  const state = useState();

  /**
   * Tanstack Query client
   */
  const client = new QueryClient();

  /**
   * Snackbar controller
   */
  const snackbarController = new SnackbarController();

  return (
    <KeybindContext>
      <ModalContext>
        <I18nProvider>
          <ClientContext state={state}>
            <SoundContext>
              <VoiceContext>
                <QueryClientProvider client={client}>
                  <SnackbarProvider controller={snackbarController}>
                    {props.children}
                    <ModalRenderer />
                    <FloatingManager />
                    <AndroidNag />
                    <FileDropGuard />
                    <ContextMenuGuard />
                  </SnackbarProvider>
                </QueryClientProvider>
              </VoiceContext>
            </SoundContext>
            <SyncWorker />
          </ClientContext>
        </I18nProvider>
      </ModalContext>
    </KeybindContext>
  );
}

render(
  () => (
    <DeviceContext>
      <StateContext>
        <Router root={MountContext}>
          <Route path="/login" component={AuthPage as never}>
            <Route path="/delete/:token" component={FlowDeleteAccount} />
            <Route path="/check" component={FlowCheck} />
            <Route path="/create" component={FlowCreate} />
            <Route path="/create/:code" component={FlowCreate} />
            <Route path="/auth" component={FlowLogin} />
            <Route path="/oauth" component={FlowOAuthCallback} />
            <Route path="/resend" component={FlowResend} />
            <Route path="/reset" component={FlowReset} />
            <Route path="/verify/:token" component={FlowVerify} />
            <Route path="/reset/:token" component={FlowConfirmReset} />
            <Route path="/*" component={FlowHome} />
          </Route>
          <Route path="/friends-popout" component={FriendsPopout} />
          {/* Sibling of /friends-popout, OUTSIDE the Interface route: the
              overlay is not a page of the app, it is a second window that
              renders one thing. `VoiceOverlayWindow` renders null unless the
              window booted on this path, so a web user who types the URL
              gets a blank page and in-app SPA navigation here can never
              mount a listener nobody is publishing to. */}
          <Route path="/voice-overlay" component={VoiceOverlayWindow} />
          <Route path="/" component={Interface as never}>
            <Route path="/pwa" component={PWARedirect} />
            <Route path="/dev" component={DevelopmentPage} />
            <Route path="/discover/server/:id" component={DiscoverRedirect} />
            <Route path="/settings" component={SettingsRedirect} />
            <Route path="/invite/:code" component={InviteRedirect} />
            <Route path="/bot/:code" component={BotRedirect} />
            <Route path="/friends" component={Friends} />
            <Route path="/server/:server/*">
              <Route path="/channel/:channel/*" component={ChannelPage} />
              <Route path="/events" component={ServerEvents} />
              <Route path="/*" component={ServerHome} />
            </Route>
            <Route path="/channel/:channel/*" component={ChannelPage} />
            <Route path="/*" component={HomePage} />
          </Route>
        </Router>

        <LoadTheme />
        {/* <ReportBug /> */}
      </StateContext>
    </DeviceContext>
  ),
  document.getElementById("root") as HTMLElement,
);

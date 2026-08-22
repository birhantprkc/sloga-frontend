import { Match, Show, Switch, createSignal } from "solid-js";
import { Motion, Presence } from "solid-motionone";

import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClientLifecycle } from "@revolt/client";
import { State, TransitionType } from "@revolt/client/Controller";
import { Button, Ripple, symbolSize, typography } from "@revolt/ui";

import MdBuild from "@material-symbols/svg-400/outlined/build.svg?component-solid";
import MdClose from "@material-symbols/svg-400/outlined/close.svg?component-solid";
import MdCollapseContent from "@material-symbols/svg-400/outlined/collapse_content.svg?component-solid";
import MdExpandContent from "@material-symbols/svg-400/outlined/expand_content.svg?component-solid";
import MdMinimize from "@material-symbols/svg-400/outlined/minimize.svg?component-solid";

import Wordmark from "../../../../scripts/assets_fallback/web/wordmark.svg?component-solid";
import { pendingUpdate } from "../../../../src/serviceWorkerInterface";

const isMacOS = navigator.platform.startsWith("Mac");

/**
 * Whether this window paints its own chrome. Only the desktop shells do; web,
 * Android and iOS have no window buttons to draw and nothing to drag.
 */
function hasCustomFrame() {
  return !!(window.native && window.desktopConfig?.get().customFrame);
}

/**
 * Connection state, and the pending-update prompt that rides along with it.
 * Shared by the title bar and by the banner every other platform gets, so the
 * two can never drift apart on what a given lifecycle state is called.
 */
function ConnectionStatus() {
  const { lifecycle } = useClientLifecycle();

  const retry = () => lifecycle.transition({ type: TransitionType.Retry });

  return (
    <>
      <Switch>
        <Match when={lifecycle.state() === State.Connecting}>Connecting</Match>
        {/* <Match when={lifecycle.state() === State.Connected}>Connected</Match> */}
        <Match when={lifecycle.state() === State.Disconnected}>
          Disconnected
          {/* no-drag on this one too, not just on the offline twin below:
              inside the title bar every child inherits the drag region, so the
              press went to a window move instead of to the link. */}
          <RetryLink
            onClick={retry}
            style={{
              "-webkit-app-region": "no-drag",
            }}
          >
            <strong> (reconnect now)</strong>
          </RetryLink>
        </Match>
        <Match when={lifecycle.state() === State.Reconnecting}>
          Reconnecting
        </Match>
        <Match when={lifecycle.state() === State.Offline}>
          Device is offline
          <RetryLink
            onClick={retry}
            style={{
              "-webkit-app-region": "no-drag",
            }}
          >
            <strong> (reconnect now)</strong>
          </RetryLink>
        </Match>
      </Switch>
      <Show when={pendingUpdate()}>
        {" "}
        <div
          style={{
            "-webkit-app-region": "no-drag",
          }}
        >
          <Button size="sm" onPress={pendingUpdate()}>
            Update
          </Button>
        </div>
      </Show>
    </>
  );
}

export function Titlebar() {
  const [isMaximised, setIsMaximised] = createSignal(
    window.native ? window.desktopConfig.get().windowState.isMaximised : false,
  );
  const { lifecycle } = useClientLifecycle();

  function isDisconnected() {
    return [
      State.Connecting,
      State.Disconnected,
      State.Reconnecting,
      State.Offline,
    ].includes(lifecycle.state());
  }

  /** Trouble that clears on its own, versus trouble the user may have to act on. */
  function isTransient() {
    return [State.Connecting, State.Reconnecting].includes(lifecycle.state());
  }

  function maximise() {
    window.native.maximise();
    setIsMaximised((t) => !t);
  }

  return (
    <Presence>
      <Show when={hasCustomFrame() || isDisconnected()}>
        <Motion.div
          initial={{ height: 0 }}
          animate={{ height: "29px" }}
          exit={{ height: 0 }}
        >
          <Show
            when={hasCustomFrame()}
            fallback={
              <Banner severity={isTransient() ? "transient" : "lost"}>
                <ConnectionStatus />
              </Banner>
            }
          >
            <Base disconnected={isDisconnected()}>
              <Title
                macos={isMacOS}
                style={{
                  "-webkit-user-select": "none",
                  "-webkit-app-region": "drag",
                }}
              >
                <Wordmark
                  class={css({
                    height: "18px",
                    marginBlockStart: "1px",
                  })}
                />{" "}
                <Show when={import.meta.env.DEV}>
                  <MdBuild {...symbolSize(16)} />
                </Show>
              </Title>
              <DragHandle
                macos={isMacOS}
                style={{
                  "-webkit-user-select": "none",
                  "-webkit-app-region": "drag",
                }}
              >
                <ConnectionStatus />
              </DragHandle>
              <Show when={window.native && !isMacOS}>
                <Action onClick={window.native.minimise}>
                  <Ripple />
                  <MdMinimize {...symbolSize(20)} />
                </Action>
                <Action onClick={maximise}>
                  <Ripple />
                  <Show
                    when={isMaximised()}
                    fallback={<MdExpandContent {...symbolSize(20)} />}
                  >
                    <MdCollapseContent {...symbolSize(20)} />
                  </Show>
                </Action>
                <Action onClick={window.native.close}>
                  <Ripple />
                  <MdClose {...symbolSize(20)} />
                </Action>
              </Show>
            </Base>
          </Show>
        </Motion.div>
      </Show>
    </Presence>
  );
}

const Base = styled("div", {
  base: {
    flexShrink: 0,
    height: "29px",
    userSelect: "none",

    display: "flex",
    alignItems: "center",

    fill: "var(--md-sys-color-on-surface)",
  },
  variants: {
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
 * The connection notice everywhere that does NOT paint its own window chrome.
 *
 * Kept a separate presentation rather than a narrower title bar, because the
 * bar above is window furniture: wordmark, drag region, minimise / maximise /
 * close. None of that means anything on a phone, and on Android it shipped as
 * a 29px slab of brand accent with the desktop furniture crammed into it.
 * Same height, so the enter/exit animation is unchanged.
 */
const Banner = styled("div", {
  base: {
    height: "100%",

    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-sm)",

    paddingInline: "var(--gap-md)",
    fontSize: "0.8em",
    fontWeight: 600,
    whiteSpace: "nowrap",
    userSelect: "none",
  },
  variants: {
    severity: {
      /** Connecting / Reconnecting — quiet, this usually clears in a second. */
      transient: {
        color: "var(--md-sys-color-on-secondary-container)",
        background: "var(--md-sys-color-secondary-container)",
      },
      /** Disconnected / Offline — the user has to notice, and may have to act. */
      lost: {
        color: "var(--md-sys-color-on-error-container)",
        background: "var(--md-sys-color-error-container)",
      },
    },
  },
});

const RetryLink = styled("a", {
  base: {
    cursor: "pointer",
    textDecoration: "underline",
  },
});

const Title = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-md)",
    alignItems: "center",
    paddingInlineStart: "var(--gap-md)",

    color: "var(--md-sys-color-on-surface)",
    ...typography.raw({ class: "title", size: "small" }),
  },
  variants: {
    macos: {
      true: {
        order: 1,
        paddingInlineEnd: "var(--gap-md)",
      },
    },
  },
});

const DragHandle = styled("div", {
  base: {
    flexGrow: 1,
    height: "100%",

    display: "flex",
    gap: "var(--gap-md)",
    alignItems: "center",
    paddingInlineStart: "var(--gap-md)",

    ...typography.raw({ class: "label", size: "large" }),
  },
  variants: {
    macos: {
      true: {
        marginInlineStart: "70px",
      },
    },
  },
});

const Action = styled("a", {
  base: {
    cursor: "pointer",
    position: "relative",

    display: "grid",
    placeItems: "center",

    height: "100%",
    aspectRatio: "3/2",
  },
});

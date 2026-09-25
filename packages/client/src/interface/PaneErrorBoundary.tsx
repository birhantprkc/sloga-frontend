import { ErrorBoundary, JSX } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Button, Text } from "@revolt/ui";

/**
 * Catch a render error in one pane of the app and show it in place.
 *
 * Without a boundary, an error thrown while Solid is updating aborts that
 * whole update. The computations it had not reached yet stay marked stale,
 * and Solid never schedules a stale computation again, so that part of the
 * screen stops following the app for good while everything around it keeps
 * working. Reported 2026-09 from Android: tapping a server moved the rail's
 * selection pill, but the channel list beside it kept showing the previous
 * server, and only restarting the app brought it back.
 *
 * With one, only this pane is swapped for the fallback. The router calls
 * `resetErrorBoundaries()` on every navigation, so tapping anywhere else
 * re-renders it, and "Try again" does the same in place. The error is shown
 * so a screenshot from a device we cannot attach a debugger to still tells
 * us what failed.
 */
export function PaneErrorBoundary(props: {
  /**
   * Which pane this wraps, for its sizing and the console tag
   */
  pane: "sidebar" | "content";
  children: JSX.Element;
}) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        console.error(`[pane-error] ${props.pane}`, error);

        return (
          <Fallback pane={props.pane}>
            <Text class="title" size="large">
              <Trans>Something went wrong</Trans>
            </Text>
            <Detail>{describe(error)}</Detail>
            <Button variant="text" onPress={reset}>
              <Trans>Try again</Trans>
            </Button>
          </Fallback>
        );
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}

/**
 * One line naming what was thrown
 */
function describe(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

const Fallback = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "var(--gap-md)",
    padding: "var(--gap-lg)",
    minWidth: 0,
    color: "var(--md-sys-color-on-surface)",
  },
  variants: {
    pane: {
      sidebar: {
        flexShrink: 0,
        width: "var(--layout-width-channel-sidebar)",

        _phone: {
          flexGrow: 1,
        },
      },
      content: {
        flexGrow: 1,
      },
    },
  },
});

const Detail = styled("code", {
  base: {
    maxWidth: "100%",
    overflowWrap: "anywhere",
    userSelect: "text",
    fontSize: "0.8em",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

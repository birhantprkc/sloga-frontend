import {
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import {
  TimelockNotReadyError,
  decryptTimelockMessage,
  parseTimelockContent,
} from "@revolt/common";
import { Markdown } from "@revolt/markdown";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

export { isTimelockMessage } from "@revolt/common";

/**
 * Decrypted plaintext keyed by the ciphertext itself (armor body), NOT the
 * message id. Sealed messages re-enter the viewport constantly while
 * scrolling, so the beacon fetch + pairing math must run once, not per mount
 * — but keying by id would render an EDITED timelock message with the old
 * plaintext, so the key is the payload. Bounded so a long session can't grow
 * it without limit.
 */
const openedCache = new Map<string, string>();
const OPENED_CACHE_MAX = 200;

function cacheOpened(armorBody: string, plain: string) {
  if (openedCache.size >= OPENED_CACHE_MAX) {
    const oldest = openedCache.keys().next().value;
    if (oldest !== undefined) openedCache.delete(oldest);
  }
  openedCache.set(armorBody, plain);
}

/**
 * Sealed-envelope renderer for timelocked messages (see
 * common/lib/timelock.ts for the wire format). Counts down to the unlock
 * time, then decrypts on-device by fetching the drand round the payload was
 * sealed against. The beacon can lag the wall clock by a few seconds, so a
 * "too early" response near the boundary retries quietly instead of alarming
 * anyone.
 */
export function TimelockMessage(props: { content: string }) {
  const payload = () => parseTimelockContent(props.content)!;

  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  const [opened, setOpened] = createSignal(
    openedCache.get(payload().armorBody) ?? null,
  );
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const remainingMs = () => payload().unlockAt.getTime() - now();
  const unlocked = () => remainingMs() <= 0;

  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(retryTimer));

  async function attempt() {
    if (busy() || opened() !== null) return;
    setBusy(true);
    setFailed(false);
    try {
      const plain = await decryptTimelockMessage(payload());
      cacheOpened(payload().armorBody, plain);
      setOpened(plain);
    } catch (error) {
      if (error instanceof TimelockNotReadyError && retries < 5) {
        // Beacon lag near the boundary: try again shortly, silently.
        retries += 1;
        retryTimer = setTimeout(() => void attempt(), 4000);
      } else {
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }

  // Fires on mount for already-due messages and at the countdown boundary
  // for live ones.
  createEffect(() => {
    if (unlocked() && opened() === null && !failed()) void attempt();
  });

  const countdown = () => {
    const total = Math.max(0, Math.floor(remainingMs() / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  };

  const localUnlockTime = () =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(payload().unlockAt);

  return (
    <Switch>
      <Match when={opened() !== null}>
        <OpenedAttribution>
          <Symbol size={14}>lock_open</Symbol>
          <Trans>Timelocked until</Trans> {localUnlockTime()}
        </OpenedAttribution>
        <Markdown content={opened()!} />
      </Match>
      <Match when={true}>
        <Envelope>
          <EnvelopeIcon>
            <Symbol size={22}>{unlocked() ? "lock_open" : "lock_clock"}</Symbol>
          </EnvelopeIcon>
          <EnvelopeBody>
            <EnvelopeTitle>
              <Trans>Timelocked message</Trans>
            </EnvelopeTitle>
            <Switch>
              <Match when={!unlocked()}>
                <EnvelopeDetail>
                  <Trans>Unlocks in</Trans> {countdown()} · {localUnlockTime()}
                </EnvelopeDetail>
                <EnvelopeFinePrint>
                  <Trans>
                    Sealed with timelock encryption — the key to open it will
                    not exist anywhere until the drand beacon reaches the
                    unlock round.
                  </Trans>
                </EnvelopeFinePrint>
              </Match>
              <Match when={busy()}>
                <EnvelopeDetail>
                  <Trans>Unlocking…</Trans>
                </EnvelopeDetail>
              </Match>
              <Match when={failed()}>
                <EnvelopeDetail>
                  <Trans>Couldn't unlock this message yet.</Trans>{" "}
                  <RetryLink
                    type="button"
                    onClick={() => {
                      retries = 0;
                      void attempt();
                    }}
                  >
                    <Trans>Retry</Trans>
                  </RetryLink>
                </EnvelopeDetail>
              </Match>
            </Switch>
          </EnvelopeBody>
        </Envelope>
      </Match>
    </Switch>
  );
}

const Envelope = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-md)",
    alignItems: "flex-start",
    padding: "12px 14px",
    maxWidth: "420px",
    borderRadius: "12px",
    border: "1px dashed var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const EnvelopeIcon = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "38px",
    height: "38px",
    flexShrink: 0,
    borderRadius: "50%",
    background: "var(--md-sys-color-primary-container)",
    color: "var(--md-sys-color-on-primary-container)",
  },
});

const EnvelopeBody = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
});

const EnvelopeTitle = styled("span", {
  base: {
    fontWeight: "600",
    fontSize: "0.9rem",
  },
});

const EnvelopeDetail = styled("span", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
    fontVariantNumeric: "tabular-nums",
  },
});

const EnvelopeFinePrint = styled("span", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
    opacity: 0.8,
  },
});

const OpenedAttribution = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "center",
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const RetryLink = styled("button", {
  base: {
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-primary)",
    cursor: "pointer",
    textDecoration: "underline",
  },
});

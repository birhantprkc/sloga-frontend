import { For, Show, createResource, createSignal, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { CONFIGURATION } from "@revolt/common";
import { useUser } from "@revolt/markdown/users";
import type { RcTrustedPeer } from "@revolt/rtc";
import { REMOTE_CONTROL_EXPRESS_NOTE, useVoice } from "@revolt/rtc";
import { CategoryButton, Checkbox, Column, Text, iconSize } from "@revolt/ui";

import MdBolt from "@material-design-icons/svg/outlined/bolt.svg?component-solid";
import MdDesktopWindows from "@material-design-icons/svg/outlined/desktop_windows.svg?component-solid";

/**
 * Remote Control settings page.
 *
 * Everything here is about who may drive THIS computer's mouse and keyboard
 * during a call, and how many confirmations stand in their way. It used to
 * live at the bottom of the E2E Encryption page (the file was once
 * "Security & Privacy"), which meant it inherited that page's
 * native-E2EE-only gate and was invisible to anyone who went looking for a
 * remote-control setting. Nothing here is encryption.
 */
export function RemoteControlSettings() {
  return (
    <Column gap="lg">
      <RemoteControlTrustCard />
    </Column>
  );
}

/**
 * People this computer has been told to remember for remote control
 * (RC slice 6, part 2), plus the Express Connect switch (part 3).
 *
 * **Not optional polish — this card is half of what makes remembering
 * someone an acceptable thing to offer at all.** Each row removes one of the
 * two system confirmations Sloga asks for before that person's input can
 * reach this machine, and a row nobody can find is a consent decision that
 * has outlived anyone's memory of making it.
 *
 * The list is read from NATIVE, which is its only writer. There is
 * deliberately no way to ADD a row from the renderer — the grant happens
 * inside the shell on the far side of the `RcGive` dialog returning true,
 * because a renderer that could write this list could grant itself a way
 * past that dialog. Revoking IS renderer-reachable: it can only ever remove
 * authority.
 */
function RemoteControlTrustCard() {
  const voice = useVoice();
  const rc = voice.remoteControl;

  const [peers, setPeers] = createSignal<RcTrustedPeer[]>([]);
  const [busy, setBusy] = createSignal(false);
  // A command PROBE, matching how the give-control affordance itself is
  // gated. On web, on a shell without the commands, and with the release
  // flag off, this stays false and the card never renders — rather than
  // showing an empty list, which reads as the reassurance "nobody is
  // remembered" and is the one wrong answer this screen can give.
  const [supported] = createResource(() => rc.supported());

  async function reload() {
    setPeers(await rc.trustedPeers());
  }

  onMount(() => {
    if (CONFIGURATION.ENABLE_REMOTE_CONTROL) void reload();
  });

  async function forget(userId: string) {
    setBusy(true);
    try {
      await rc.revokeTrust(userId);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function forgetEveryone() {
    setBusy(true);
    try {
      await rc.revokeAllTrust();
      await reload();
    } finally {
      setBusy(false);
    }
  }

  // -- Express Connect (part 3) ----------------------------------------
  //
  // The switch itself is NOT settable from here. Turning it on asks native
  // to show its own opt-in dialog and the flag is written on the far side of
  // that; a renderer that could set it could remove one of the two
  // confirmations standing between it and the keyboard. Turning it OFF is
  // unrestricted, because that direction only adds friction back.
  const [express, setExpress] = createSignal(false);

  async function reloadExpress() {
    setExpress(await rc.expressEnabled());
  }

  onMount(() => {
    if (CONFIGURATION.ENABLE_REMOTE_CONTROL) void reloadExpress();
  });

  async function toggleExpress() {
    setBusy(true);
    try {
      if (express()) await rc.disableExpress();
      else await rc.enableExpress();
      await reloadExpress();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show
      when={supported() === true}
      fallback={
        // The sidebar entry is gated on the release flag and the shell's
        // command bridge, so landing here with `supported === false` means
        // native itself declined (older shell, missing capability). Say so
        // instead of rendering an empty page.
        <Show when={supported() === false}>
          <Text class="label">
            <Trans>Remote control isn't available on this device.</Trans>
          </Text>
        </Show>
      }
    >
      <Text class="label">
        <Trans>
          Choose how Sloga asks before someone in a call can use this computer's
          mouse and keyboard. People you have remembered are listed here; select
          one to forget them.
        </Trans>
      </Text>

      <Show when={peers().length > 0}>
        <CategoryButton.Group>
          <For each={peers()}>
            {(peer) => (
              <TrustedPeerRow peer={peer} busy={busy()} onForget={forget} />
            )}
          </For>
          <CategoryButton
            icon={<MdDesktopWindows {...iconSize(24)} />}
            disabled={busy()}
            description={
              <Trans>
                Everyone above goes back to needing both confirmations.
              </Trans>
            }
            onClick={() => void forgetEveryone()}
          >
            <Trans>Forget everyone</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Show>

      {/* Express Connect. Shown even with an empty trust list, because it is
          the switch that has to be findable — but note it does nothing at
          all until someone is remembered, which is §8's mitigation and is
          said in the description rather than left to be discovered.

          🔴 REMOTE_CONTROL_EXPRESS_NOTE is a SECURITY STATEMENT (reviewed
          2026-07-29). The pinned claim is unchanged and still true; what this
          adds is that the OS-drawn verification code is gone in this mode.
          The off-state description below carried the same false delta the
          note did — "one step instead of two" — and is corrected with it:
          the peers this applies to were already at one confirmation, so what
          changes is WHEN it is asked, not how many. */}
      <CategoryButton.Group>
        <CategoryButton
          disabled={busy()}
          action={
            <span style={{ "pointer-events": "none", display: "flex" }}>
              <Checkbox checked={express()} />
            </span>
          }
          icon={<MdBolt {...iconSize(24)} />}
          description={
            express() ? (
              REMOTE_CONTROL_EXPRESS_NOTE
            ) : (
              <Trans>
                For people you have remembered, Sloga asks when you click
                instead of after they answer, so you do not have to come back to
                your computer. It is the same one confirmation, and it cannot
                show a verification code. People you have not remembered are
                unaffected.
              </Trans>
            )
          }
          onClick={() => void toggleExpress()}
        >
          <Trans>Express Connect</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Show>
  );
}

/**
 * One remembered peer. The username is resolved from the user id like every
 * other surface does — native stores ids only, and copying a server-asserted
 * name into the trust table would undermine the one job this list has.
 */
function TrustedPeerRow(props: {
  peer: RcTrustedPeer;
  busy: boolean;
  onForget: (userId: string) => void;
}) {
  const user = useUser(props.peer.userId);
  const name = () => user()?.username ?? props.peer.userId;
  // The device half, shortened. Someone who has remembered the same person on
  // two machines over time needs to tell the rows apart, and the full
  // identity is a 32-character hash nobody reads.
  const device = () => props.peer.identity.split(":")[1]?.slice(0, 8) ?? "";

  return (
    <CategoryButton
      icon={<MdDesktopWindows {...iconSize(24)} />}
      disabled={props.busy}
      description={
        <Trans>
          Sloga asks you once instead of twice before this person can use your
          mouse and keyboard. Select to undo.
        </Trans>
      }
      onClick={() => props.onForget(props.peer.userId)}
    >
      {name()} ({device()})
    </CategoryButton>
  );
}

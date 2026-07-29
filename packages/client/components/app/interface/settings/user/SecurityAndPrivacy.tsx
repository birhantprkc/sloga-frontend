import {
  For,
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
  onMount,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import type { BackupStatusView } from "@revolt/client";
import { useClient, useE2EE } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useUser } from "@revolt/markdown/users";
import { useModals } from "@revolt/modal";
import type { RcTrustedPeer } from "@revolt/rtc";
import {
  REMOTE_CONTROL_EXPRESS_NOTE,
  platformMediaE2EESupported,
  useVoice,
} from "@revolt/rtc";
import { CategoryButton, Checkbox, Column, iconSize } from "@revolt/ui";

import MdBolt from "@material-design-icons/svg/outlined/bolt.svg?component-solid";
import MdDesktopWindows from "@material-design-icons/svg/outlined/desktop_windows.svg?component-solid";
import MdKey from "@material-design-icons/svg/outlined/key.svg?component-solid";
import MdLock from "@material-design-icons/svg/outlined/lock.svg?component-solid";
import MdVideocam from "@material-design-icons/svg/outlined/videocam.svg?component-solid";

/**
 * Security & Privacy settings page.
 *
 * Currently hosts the per-device end-to-end encryption opt-in (moved out of
 * Sessions). The E2EE card renders only where a native crypto layer exists
 * (Tauri desktop); the web build has no key material and the server refuses
 * its E2EE routes.
 */
export function SecurityAndPrivacy() {
  return (
    <Column gap="lg">
      <EncryptionCard />
      <CallEncryptionCard />
      <RecoveryBackupCard />
      <RemoteControlTrustCard />
    </Column>
  );
}

/**
 * People this computer has been told to remember for remote control
 * (RC slice 6, part 2).
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
    <Show when={supported() === true}>
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

          🔴 REMOTE_CONTROL_EXPRESS_NOTE is a SECURITY STATEMENT and is not
          yet reviewed. The pinned claim is unchanged and still true; what
          this adds is that the verification code and the second OS
          confirmation are gone in this mode. Review before shipping. */}
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
                Start sessions with people you have remembered in one step
                instead of two. Sloga will no longer show you a verification
                code for them. People you have not remembered are unaffected.
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

/**
 * "Encrypt my calls" opt-in for this device (media E2EE, slice 6.5 §0.2 #9).
 * LOCAL per-device (the `Voice` store is not synced). Enabling requires text-
 * E2EE enrollment (shared infrastructure) — the row routes through the enable
 * flow first when off. Gated on MEDIA capability (`nativeKeyPushAvailable`, not
 * merely `useE2EE`): on Android (E2EE-enrolled but media-fail-closed until 6.7)
 * the card renders DISABLED with explanatory copy so a user can't believe their
 * calls are encrypted when they are not (FE-6).
 */
function CallEncryptionCard() {
  const e2ee = useE2EE();
  const { openModal } = useModals();

  if (!e2ee) return null;
  // Electron shell (EL1.2): media E2EE is fail-closed until EL4's audited
  // slice — hide the toggle entirely so a user can't believe their calls
  // are encrypted when they are not (same FE-6 rationale as the Android
  // disabled state; hidden rather than disabled because no ETA copy fits).
  if (!platformMediaE2EESupported()) return null;

  // Media E2EE requires a native key-push channel (desktop today; Android 6.7).
  const mediaCapable = () => e2ee.nativeKeyPushAvailable();
  const textEnrolled = () => {
    const s = e2ee.status.get("state");
    return !!s?.enabled && !!s?.published;
  };
  // Media E2EE is MANDATORY — there is no off switch (Discord/DAVE parity).
  // The row is a locked indicator: checked and greyed once this device can
  // actually encrypt, and never unchecked by a user action.
  //
  // "Can actually encrypt" still requires text-E2EE enrollment, so an
  // unenrolled user must NOT see a checked box — that would claim encryption
  // the gate will not deliver (FE-6). For them the row stays unchecked and
  // routes into the enrolment flow, which is the one remaining click here.
  const enabled = () => mediaCapable() && textEnrolled();

  const onClick = () => {
    if (!mediaCapable()) return; // unsupported shell — no-op
    if (textEnrolled()) return; // already on and not turn-off-able
    openModal({ type: "e2ee_enable" });
  };

  return (
    <CategoryButton.Group>
      <CategoryButton
        // Greyed out whenever there is nothing to click: either this device
        // cannot encrypt at all, or it already does and cannot be turned off.
        disabled={!mediaCapable() || enabled()}
        action={
          <span style={{ "pointer-events": "none", display: "flex" }}>
            <Checkbox checked={enabled()} />
          </span>
        }
        icon={<MdVideocam {...iconSize(24)} />}
        description={
          <Show
            when={mediaCapable()}
            fallback={
              <Trans>
                Encrypted calls aren't available on this device yet.
              </Trans>
            }
          >
            <Show
              when={enabled()}
              fallback={
                <Trans>
                  Set up secure device keys to encrypt your calls. Web
                  participants can't join encrypted calls, and server features
                  that need the raw audio or video (recording, transcoding) are
                  turned off in encrypted calls.
                </Trans>
              }
            >
              <Trans>
                Always on. Your voice and video are end-to-end encrypted on this
                device whenever everyone in the call supports it.
              </Trans>
            </Show>
          </Show>
        }
        onClick={onClick}
      >
        <Trans>Encrypt my calls</Trans>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

/**
 * End-to-end encryption opt-in for this device (implementation plan slice 3).
 */
function EncryptionCard() {
  const e2ee = useE2EE();
  const { openModal } = useModals();

  if (!e2ee) return null;

  const state = () => e2ee.status.get("state");
  const enabled = () => !!state()?.enabled && !!state()?.published;

  return (
    <CategoryButton.Group>
      <CategoryButton
        // A checkbox as a pure indicator (clicks pass through to the row via
        // pointer-events:none), so it always reflects the real native status
        // and never desyncs on a cancelled flow. The row toggles: checked →
        // disable flow, unchecked → enable flow.
        action={
          <span style={{ "pointer-events": "none", display: "flex" }}>
            <Checkbox checked={enabled()} />
          </span>
        }
        icon={<MdLock {...iconSize(24)} />}
        description={
          enabled() ? (
            <Trans>
              Direct messages with contacts who also have encryption on are
              end-to-end encrypted on this device. Encrypted history is stored
              only here — uncheck to turn encryption off on this device.
            </Trans>
          ) : (
            <Trans>
              Turn on end-to-end encrypted direct messages for this device.
            </Trans>
          )
        }
        onClick={() =>
          openModal({ type: enabled() ? "e2ee_disable" : "e2ee_enable" })
        }
      >
        <Switch>
          <Match when={enabled()}>
            <Trans>Encrypted messaging is on</Trans>
          </Match>
          <Match when={!enabled()}>
            <Trans>Encrypted direct messages</Trans>
          </Match>
        </Switch>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

/**
 * Recovery-code key backup (implementation plan slice 5.5). Lives directly
 * beneath the encryption toggle because a backup is only meaningful once
 * encryption is on. The recovery CODE is shown/entered only in the native
 * recovery window — never here. Rotate and delete are re-auth-gated (MFA),
 * matching the wipe flow; create needs no MFA (the upload is device-bound).
 */
function RecoveryBackupCard() {
  const e2ee = useE2EE();
  const client = useClient();
  const { mfaFlow, showError } = useModals();

  if (!e2ee) return null;

  const enabled = () => {
    const state = e2ee.status.get("state");
    return !!state?.enabled && !!state?.published;
  };

  const [status, setStatus] = createSignal<BackupStatusView | undefined>();
  const [busy, setBusy] = createSignal(false);

  async function reload() {
    if (!e2ee || !enabled()) return;
    try {
      setStatus(await e2ee.backupStatus());
    } catch (error) {
      console.error("[e2ee] backup status failed", error);
    }
  }

  onMount(reload);

  /** Prove account ownership; returns the MFA ticket token or undefined. */
  async function reauth(): Promise<string | undefined> {
    const mfa = await client().account.mfa();
    const ticket = await mfaFlow(mfa);
    return ticket?.token;
  }

  async function create() {
    if (!e2ee) return;
    setBusy(true);
    try {
      await e2ee.createRecoveryCode();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      // The native window couriers the upload asynchronously; refresh soon.
      setTimeout(reload, 500);
    }
  }

  async function rotate() {
    if (!e2ee) return;
    setBusy(true);
    try {
      const token = await reauth();
      if (!token) return;
      await e2ee.rotateRecoveryCode();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      setTimeout(reload, 500);
    }
  }

  async function remove() {
    if (!e2ee) return;
    setBusy(true);
    try {
      const token = await reauth();
      if (!token) return;
      await e2ee.deleteBackup(token);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      void reload();
    }
  }

  /**
   * §6.4 durable re-enroll (design §8 HIGH-1). A device whose server-side
   * identity row was revoked while it was dead (typically after a restore) is
   * stranded receive-broken — its keys are `published=true` locally but the
   * server has no row, so it must re-publish as a first publication. This is the
   * PERSISTENT recovery entry — shown whenever the bridge has `reenrollNeeded`
   * armed, which survives a dismissed auto-modal and a restart (re-raised on
   * reconnect by the bridge's `#onClaimResult` re-detection). It re-auths and
   * re-publishes the restored keys as a first publication; deliberately NOT a
   * one-shot.
   */
  async function finishRestore() {
    if (!e2ee) return;
    // Flag already cleared (re-enrolled elsewhere / accepted claim) — don't
    // burn an MFA prompt on a stale affordance.
    if (!e2ee.reenrollNeeded.get("state")) return;
    setBusy(true);
    try {
      const token = await reauth();
      if (!token) return;
      await e2ee.finishReenroll(token);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      setTimeout(reload, 500);
    }
  }

  const hasBackup = () => !!status()?.exists;
  const reenrollNeeded = () => !!e2ee.reenrollNeeded.get("state");

  return (
    <>
      {/*
       * §6.4 durable re-enroll entry. Its own `<Show>` (independent of
       * `enabled()`) because it must appear whenever the bridge has
       * `reenrollNeeded` armed. NB a stranded restored device is `published=
       * true` (restore imports the source's published flag), so `enabled()` is
       * ALSO true for it — the re-enroll entry and the backup-management block
       * below are mutually exclusive via `!reenrollNeeded()` there, so a strand
       * shows only this recovery affordance (design §8 HIGH-1).
       */}
      <Show when={reenrollNeeded()}>
        <CategoryButton.Group>
          <CategoryButton
            icon={<MdKey {...iconSize(24)} />}
            disabled={busy()}
            description={
              <Trans>
                This device was logged out remotely, so it must be re-registered
                before it can send and receive encrypted messages again. Confirm
                your identity to finish — your contacts will see it come back
                with no security warning, because its keys are unchanged.
              </Trans>
            }
            onClick={() => void finishRestore()}
          >
            <Trans>Finish restoring on this device</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Show>

      <Show when={enabled() && !reenrollNeeded()}>
        <CategoryButton.Group>
          <CategoryButton
            icon={<MdKey {...iconSize(24)} />}
            disabled={busy()}
            description={
              hasBackup() ? (
                <Trans>
                  You have a recovery code. Anyone with this code and access to
                  your account can read your message history — Sloga cannot
                  recover it for you. Choose "Change recovery code" to replace
                  it.
                </Trans>
              ) : (
                <Trans>
                  Without a recovery code, your encrypted messages cannot be
                  restored if you lose this device. Create one and store it
                  somewhere safe.
                </Trans>
              )
            }
            onClick={() => (hasBackup() ? void rotate() : void create())}
          >
            <Switch>
              <Match when={hasBackup()}>
                <Trans>Change recovery code</Trans>
              </Match>
              <Match when={!hasBackup()}>
                <Trans>Create a recovery code</Trans>
              </Match>
            </Switch>
          </CategoryButton>

          <Show when={hasBackup()}>
            <CategoryButton
              icon={<MdKey {...iconSize(24)} />}
              disabled={busy()}
              description={
                <Trans>
                  Remove the backup stored on the server. Your encrypted history
                  on this device is unaffected.
                </Trans>
              }
              onClick={() => void remove()}
            >
              <Trans>Delete backup</Trans>
            </CategoryButton>
          </Show>
        </CategoryButton.Group>
      </Show>
    </>
  );
}

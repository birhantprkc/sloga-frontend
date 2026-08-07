import { createEffect, onCleanup } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";

import { useModals } from "@revolt/modal";
import { useSnackbar } from "@revolt/ui";

import { useClient, useClientLifecycle } from ".";
import {
  applyDiscordImportComplete,
  applyDiscordImportFailed,
  applyDiscordImportJob,
  applyDiscordImportProgress,
  discordImportInFlight,
  discordImportView,
  noteDiscordImportAnnounced,
  primeImportDiscordFlag,
  resumeDiscordImport,
} from "./discordImport";

/**
 * How often to re-read the job while one is running, as a fallback for
 * dropped WS events. Deliberately slow — the events are the primary channel.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * Owns the "Import from Discord" job for the whole session.
 *
 * The import modal can be dismissed by clicking the scrim, and the job keeps
 * running server-side — so the WS handlers, the poll fallback and the resume
 * on boot all live here, at app level, not in the modal. The modal renders
 * whatever this leaves in the shared store.
 */
export function DiscordImportWorker() {
  const client = useClient();
  const { isLoggedIn } = useClientLifecycle();
  const { openModal, isOpen } = useModals();
  const snackbar = useSnackbar();
  const { t } = useLingui();

  // Subscribe to the three private-topic events and recover any job that
  // outlived the last page load.
  createEffect(() => {
    if (!isLoggedIn()) return;

    const currentClient = client();
    if (!currentClient) return;

    primeImportDiscordFlag();

    const onProgress = (progress: {
      jobId: string;
      stage: string;
      done: number;
      total: number;
    }) => applyDiscordImportProgress(progress);

    const onComplete = (result: {
      jobId: string;
      serverId: string;
      inviteCode: string;
    }) => {
      applyDiscordImportComplete(result);
      noteDiscordImportAnnounced(result.jobId);

      // The complete event carries no summary; fetch the finished row so the
      // done screen can show the skipped-items notes.
      currentClient
        .fetchDiscordImportJob(result.jobId)
        .then(applyDiscordImportJob)
        .catch(() => {
          /* the invite is already in hand — notes are a nicety */
        });

      if (!isOpen("import_discord")) {
        snackbar.show({
          message: t`Your Discord import finished.`,
          action: t`View`,
          closeable: true,
          closeOnAction: true,
          onAction: () =>
            openModal({ type: "import_discord", client: currentClient }),
        });
      }
    };

    const onFailed = (failure: { jobId: string; error: string }) => {
      applyDiscordImportFailed(failure);
      noteDiscordImportAnnounced(failure.jobId);

      if (!isOpen("import_discord")) {
        snackbar.show({
          message: t`Your Discord import failed.`,
          action: t`Details`,
          closeable: true,
          closeOnAction: true,
          onAction: () =>
            openModal({ type: "import_discord", client: currentClient }),
        });
      }
    };

    currentClient.addListener("discordImportProgress", onProgress);
    currentClient.addListener("discordImportComplete", onComplete);
    currentClient.addListener("discordImportFailed", onFailed);

    onCleanup(() => {
      currentClient.removeListener("discordImportProgress", onProgress);
      currentClient.removeListener("discordImportComplete", onComplete);
      currentClient.removeListener("discordImportFailed", onFailed);
    });

    // A job that reached a terminal state while this device was disconnected
    // never produced a `DiscordImportComplete` event here, so the resume path
    // is the only chance to tell the user. Reuses the existing msgids so no
    // catalog resync is needed.
    resumeDiscordImport(currentClient).then((recovered) => {
      if (!recovered) return;
      if (isOpen("import_discord")) return;

      const failed = recovered.status === "Failed";
      snackbar.show({
        message: failed
          ? t`Your Discord import failed.`
          : t`Your Discord import finished.`,
        action: failed ? t`Details` : t`View`,
        closeable: true,
        closeOnAction: true,
        onAction: () =>
          openModal({ type: "import_discord", client: currentClient }),
      });
    });
  });

  // Poll fallback. This effect reads the whole view, so every progress event
  // re-runs it and restarts the timer — making it a watchdog that only ever
  // fires after POLL_INTERVAL_MS of silence. It also tears the timer down the
  // moment the job reaches a terminal status (or the user logs out), so an
  // interval can never outlive the job it was polling for.
  createEffect(() => {
    if (!isLoggedIn()) return;
    if (!discordImportInFlight()) return;

    const currentClient = client();
    if (!currentClient) return;

    const jobId = discordImportView()!.jobId;

    const timer = setInterval(() => {
      currentClient
        .fetchDiscordImportJob(jobId)
        .then(applyDiscordImportJob)
        .catch(() => {
          /* transient — the next tick retries, the sweeper fails it eventually */
        });
    }, POLL_INTERVAL_MS);

    onCleanup(() => clearInterval(timer));
  });

  return null;
}

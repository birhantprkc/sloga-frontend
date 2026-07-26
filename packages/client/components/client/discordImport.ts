import { createSignal } from "solid-js";

import type {
  Client,
  DiscordImportJobData,
  DiscordImportStatus,
  DiscordImportSummary,
} from "stoat.js";

import { CONFIGURATION } from "@revolt/common";

/**
 * "Import from Discord" client state.
 *
 * The job outlives the modal: the dialog scrim closes on any outside click,
 * and the job keeps running server-side. So the authoritative view lives here
 * (module scope, one per tab) and is driven by the app-level
 * `DiscordImportWorker`; the modal is a pure view over it. Losing the modal
 * must never lose the invite code.
 */

/**
 * Id of the import job this device most recently started, so a full reload
 * can recover a job that has ALREADY finished — `/import/discord/active`
 * only ever returns `Queued`/`Running` jobs.
 */
const JOB_ID_KEY = "discord_import:job_id";

/* -------------------------------------------------------------------------- */
/* Feature flag                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether the server has the Discord importer enabled.
 *
 * Read with a raw `fetch` of the root config route, cloned from
 * `fetchStreamingFlags`. **Never read this from `client.configuration`:** the
 * client controller pre-assigns a locally-synthesized configuration stub from
 * env values, which makes `Client#fetchConfiguration()` short-circuit, so
 * `GET /` is never actually fetched and `features.import_discord` would be
 * `undefined` forever — failing closed and silently.
 */
export async function fetchImportDiscordEnabled(): Promise<boolean> {
  try {
    const response = await fetch(`${CONFIGURATION.DEFAULT_API_URL}/`);
    if (!response.ok) return false;
    const config = await response.json();
    return !!config?.features?.import_discord;
  } catch {
    return false;
  }
}

const [flagEnabled, setFlagEnabled] = createSignal(false);
let flagProbed = false;

/**
 * Kick off the one-time flag probe. Idempotent; safe to call from anywhere.
 */
export function primeImportDiscordFlag(): void {
  if (flagProbed) return;
  flagProbed = true;
  fetchImportDiscordEnabled().then(setFlagEnabled);
}

/**
 * Reactive accessor for the flag; primes the probe on first read so entry
 * points work even if they render before the worker mounts.
 */
export function importDiscordEnabled(): boolean {
  primeImportDiscordFlag();
  return flagEnabled();
}

/* -------------------------------------------------------------------------- */
/* Job view                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything the UI needs about the in-flight (or just-finished) import.
 *
 * `stage` is an OPAQUE server string, deliberately not a union — a later
 * slice adds stages, and an exhaustive lookup on a deployed client would
 * render "undefined".
 */
export type DiscordImportView = {
  jobId: string;
  status: DiscordImportStatus;
  stage: string;
  done: number;
  /** 0 means "indeterminate" — do NOT divide by this */
  total: number;
  serverId?: string;
  inviteCode?: string;
  error?: string;
  summary?: DiscordImportSummary;
};

const [view, setView] = createSignal<DiscordImportView | undefined>(undefined);

/** The current import, if any. Reactive. */
export const discordImportView = view;

/** Whether an import is still running (or waiting to be claimed). */
export function discordImportInFlight(): boolean {
  const current = view();
  return !!current && !isTerminalStatus(current.status);
}

/**
 * Whether a status will never change again.
 * @param status Job status
 */
export function isTerminalStatus(status: DiscordImportStatus): boolean {
  return status === "Completed" || status === "Failed";
}

/**
 * Project a fetched job row onto the view.
 * @param job Job row
 */
function fromJob(job: DiscordImportJobData): DiscordImportView {
  return {
    jobId: job.job_id,
    status: job.status,
    stage: job.stage,
    done: job.done ?? 0,
    total: job.total ?? 0,
    serverId: job.server_id,
    inviteCode: job.invite_code,
    error: job.error,
    summary: job.summary,
  };
}

/**
 * Remember a job id across reloads.
 */
function persistJobId(jobId: string) {
  // Belt and braces against a wire-shape drift writing the literal string
  // "undefined", which then 404s on every boot until it self-deletes.
  if (!jobId) return;

  try {
    localStorage.setItem(JOB_ID_KEY, jobId);
  } catch {
    /* private mode / storage disabled — resume degrades, nothing breaks */
  }
}

/**
 * Forget the remembered job id.
 */
function forgetJobId() {
  try {
    localStorage.removeItem(JOB_ID_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Read the remembered job id.
 */
function rememberedJobId(): string | null {
  try {
    return localStorage.getItem(JOB_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * Begin tracking a job the moment the POST returns, before any event or poll
 * has landed.
 * @param jobId Job id
 */
export function trackDiscordImport(jobId: string): void {
  persistJobId(jobId);
  setView({ jobId, status: "Queued", stage: "", done: 0, total: 0 });
}

/**
 * Merge a fetched job row into the view.
 *
 * Ignores rows for a job other than the one being tracked, so a slow poll
 * response cannot resurrect a superseded import.
 * @param job Job row
 */
export function applyDiscordImportJob(job: DiscordImportJobData): void {
  const current = view();
  if (current && current.jobId !== job.job_id) return;
  persistJobId(job.job_id);
  setView(fromJob(job));
}

/**
 * Apply a `DiscordImportProgress` event.
 * @param progress Event payload
 */
export function applyDiscordImportProgress(progress: {
  jobId: string;
  stage: string;
  done: number;
  total: number;
}): void {
  const current = view();
  if (current && current.jobId !== progress.jobId) return;
  // A terminal view must not be dragged back into "running" by a late event.
  if (current && isTerminalStatus(current.status)) return;

  setView({
    ...(current ?? { jobId: progress.jobId, status: "Running" as const }),
    jobId: progress.jobId,
    status: "Running",
    stage: progress.stage,
    done: progress.done,
    total: progress.total,
  });
  persistJobId(progress.jobId);
}

/**
 * Apply a `DiscordImportComplete` event. The event carries no summary, so the
 * worker follows up with a job fetch to fill `summary`.
 * @param result Event payload
 */
export function applyDiscordImportComplete(result: {
  jobId: string;
  serverId: string;
  inviteCode: string;
}): void {
  const current = view();
  if (current && current.jobId !== result.jobId) return;

  persistJobId(result.jobId);
  setView({
    jobId: result.jobId,
    status: "Completed",
    stage: current?.stage ?? "Done",
    done: current?.done ?? 0,
    total: current?.total ?? 0,
    serverId: result.serverId,
    inviteCode: result.inviteCode,
    summary: current?.summary,
  });
}

/**
 * Apply a `DiscordImportFailed` event.
 * @param failure Event payload
 */
export function applyDiscordImportFailed(failure: {
  jobId: string;
  error: string;
}): void {
  const current = view();
  if (current && current.jobId !== failure.jobId) return;

  persistJobId(failure.jobId);
  setView({
    jobId: failure.jobId,
    status: "Failed",
    stage: current?.stage ?? "",
    done: current?.done ?? 0,
    total: current?.total ?? 0,
    error: failure.error,
  });
}

/**
 * Drop the tracked import once the user has acknowledged its outcome, so the
 * next open of the modal starts from the explain screen.
 */
export function clearDiscordImport(): void {
  forgetJobId();
  setView(undefined);
}

/**
 * Recover any import this account has in flight — or one that finished while
 * the modal was dismissed / the tab was closed.
 *
 * `/import/discord/active` only knows about `Queued`/`Running` jobs, so a
 * completed job is recovered from the id remembered in local storage. Without
 * this, closing the modal loses the invite code permanently.
 * @param client Client
 */
export async function resumeDiscordImport(client: Client): Promise<void> {
  try {
    const active = await client.fetchActiveDiscordImportJob();
    if (active) {
      setView(fromJob(active));
      persistJobId(active.job_id);
      return;
    }
  } catch {
    /* offline or route missing — fall through to the remembered id */
  }

  const remembered = rememberedJobId();
  if (!remembered) return;

  try {
    const job = await client.fetchDiscordImportJob(remembered);
    setView(fromJob(job));
  } catch {
    // 404 = not ours / pruned. Stop trying on every boot.
    forgetJobId();
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pull the API error `type` out of a rejection.
 *
 * The raw-fetch helpers throw the **parsed JSON body**, not an `Error`, and
 * drop the HTTP status — so 409 vs 400 is only distinguishable by this tag.
 * @param error Rejection value
 */
export function discordImportErrorType(error: unknown): string | undefined {
  if (error && typeof error === "object" && "type" in error) {
    const type = (error as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  }

  return undefined;
}

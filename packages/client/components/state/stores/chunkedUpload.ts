import { Client } from "stoat.js";

/**
 * Chunked/resumable upload client for files above
 * `CONFIGURATION.CHUNKED_UPLOAD_THRESHOLD`.
 *
 * Splits the file into server-dictated chunks (32 MiB — each its own request,
 * safely under the CDN's 100 MB body wall), uploads up to three parts
 * concurrently with per-part retry, resumes from the server's recorded part
 * set after connection loss (or an autumn restart), and finishes with an
 * idempotent `complete` that mints the ordinary claim-once attachment id —
 * the message send path is untouched.
 *
 * Server contract (see stoatchat `docs/chunked-uploads-implementation-plan.md`):
 * - parts may upload in any order and at any concurrency;
 * - re-PUTting a part with identical bytes is idempotent success, but
 *   DIFFERENT bytes for a recorded part are rejected 409 (server-side
 *   nonce-reuse guard) — on any 409 we re-fetch status and reconcile;
 * - `complete` retries return the same file id.
 */

/** Parts uploading at once */
const PART_CONCURRENCY = 3;

/** Backoff delays per retry attempt of one part (ms) */
const PART_RETRY_DELAYS = [1_000, 4_000, 10_000];

/** Per-part timeout (ms) — parts are fixed-size, so no size scaling */
const PART_TIMEOUT = 180_000;

/** How many times `complete` is attempted (idempotent server-side) */
const COMPLETE_ATTEMPTS = 3;

interface CreateResponse {
  session_id: string;
  chunk_size: number;
  total_parts: number;
  expires_at: string;
}

interface SessionStatus {
  state: "Pending" | "Completing" | "Completed" | "Aborted";
  chunk_size: number;
  total_size: number;
  total_parts: number;
  parts: number[];
  expires_at: string;
  file_id?: string;
}

class ChunkedUploadError extends Error {
  constructor(
    message: string,
    /** Session is gone/expired — restart from create */
    public readonly sessionLost = false,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Interpret an `X-RateLimit-Reset-After` header defensively: treat it as
 * milliseconds-remaining, clamped to [0.5s, 15s] so a malformed (or
 * absolute-timestamp) value cannot stall the upload for hours.
 */
function resetAfterMs(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1_000;
  return Math.min(Math.max(value, 500), 15_000);
}

/**
 * Upload a file through the chunked path.
 * @param client Authenticated client (supplies the auth header + autumn URL)
 * @param file File to upload
 * @param onProgress Real progress across all parts, 0..1
 * @param onProcessing Server-side assembly phase indicator
 * @returns Attachment id, usable exactly like a single-POST upload response
 */
export async function uploadFileChunked(
  client: Client,
  file: File,
  onProgress: (fraction: number) => void,
  onProcessing: (processing: boolean) => void,
): Promise<string> {
  try {
    return await uploadOnce(client, file, onProgress, onProcessing);
  } catch (error) {
    // One full restart if the session itself was lost (expired/aborted) —
    // transient part failures are retried inside uploadOnce and do NOT
    // restart the whole upload
    if (error instanceof ChunkedUploadError && error.sessionLost) {
      return await uploadOnce(client, file, onProgress, onProcessing);
    }
    throw error;
  } finally {
    onProcessing(false);
  }
}

async function uploadOnce(
  client: Client,
  file: File,
  onProgress: (fraction: number) => void,
  onProcessing: (processing: boolean) => void,
): Promise<string> {
  const baseUrl = `${client.configuration!.features.autumn.url}/attachments/upload`;
  const [authHeader, authHeaderValue] = client.authenticationHeader;
  const headers: Record<string, string> = { [authHeader]: authHeaderValue };

  const created = await jsonRequest<CreateResponse>(
    `${baseUrl}/create`,
    "POST",
    headers,
    {
      filename: file.name,
      total_size: file.size,
      content_type: file.type || undefined,
    },
  );

  const session = created.session_id;
  const chunkSize = created.chunk_size;
  const totalParts = created.total_parts;

  // Real progress: recorded parts count fully, in-flight parts by xhr bytes
  const recorded = new Set<number>();
  const inFlight = new Map<number, number>();
  const partSize = (n: number) =>
    n === totalParts ? file.size - (totalParts - 1) * chunkSize : chunkSize;
  const reportProgress = () => {
    let bytes = 0;
    for (const n of recorded) bytes += partSize(n);
    for (const loaded of inFlight.values()) bytes += loaded;
    onProgress(Math.min(bytes / file.size, 1));
  };

  const pending: number[] = [];
  for (let n = 1; n <= totalParts; n++) pending.push(n);

  /** Refresh the server's view and reconcile (the 409/resume path) */
  const reconcile = async () => {
    const status = await fetchStatus(baseUrl, session, headers);
    if (status.state === "Aborted") {
      throw new ChunkedUploadError("Upload session was cancelled", true);
    }
    for (const n of status.parts) recorded.add(n);
    reportProgress();
  };

  // Fixed worker pool: each worker drains the shared queue. One attempt per
  // part index at a time is guaranteed by parts being handed out once.
  const workers = Array.from({ length: PART_CONCURRENCY }, async () => {
    for (;;) {
      const n = pending.shift();
      if (n === undefined) return;
      if (recorded.has(n)) continue;

      const blob = file.slice((n - 1) * chunkSize, (n - 1) * chunkSize + partSize(n));
      let lastError: unknown;
      let attempt = 0;

      while (attempt < PART_RETRY_DELAYS.length + 1) {
        try {
          const outcome = await putPart(
            `${baseUrl}/${session}/part/${n}`,
            headers,
            blob,
            (loaded) => {
              inFlight.set(n, loaded);
              reportProgress();
            },
          );

          if (outcome.kind === "ok") {
            inFlight.delete(n);
            recorded.add(n);
            reportProgress();
            break;
          }
          if (outcome.kind === "ratelimited") {
            // Wait out the window without consuming a retry attempt
            inFlight.delete(n);
            await sleep(outcome.retryAfterMs);
            continue;
          }
          if (outcome.kind === "conflict") {
            // Another attempt's claim, or the part is already recorded from
            // a PUT whose response we lost — status is the source of truth
            inFlight.delete(n);
            await reconcile();
            if (recorded.has(n)) break;
            lastError = new ChunkedUploadError(`Part ${n} conflicted`);
          } else if (outcome.kind === "gone") {
            throw new ChunkedUploadError("Upload session expired", true);
          } else {
            lastError = new ChunkedUploadError(
              outcome.status
                ? `Part ${n} failed (HTTP ${outcome.status})`
                : `Part ${n} timed out or was interrupted`,
            );
          }
        } catch (error) {
          if (error instanceof ChunkedUploadError && error.sessionLost) throw error;
          lastError = error;
        }

        inFlight.delete(n);
        if (attempt >= PART_RETRY_DELAYS.length) {
          throw lastError instanceof Error
            ? lastError
            : new ChunkedUploadError(`Part ${n} failed`);
        }
        await sleep(PART_RETRY_DELAYS[attempt]);
        attempt += 1;
      }
    }
  });

  await Promise.all(workers);

  onProgress(1);
  onProcessing(true);

  // Idempotent server-side: every attempt returns the same file id
  let lastError: unknown;
  for (let attempt = 0; attempt < COMPLETE_ATTEMPTS; attempt++) {
    try {
      const response = await jsonRequest<{ id: string }>(
        `${baseUrl}/${session}/complete`,
        "POST",
        headers,
      );
      return response.id;
    } catch (error) {
      if (error instanceof ChunkedUploadError && error.sessionLost) throw error;
      lastError = error;
      await sleep(PART_RETRY_DELAYS[Math.min(attempt, PART_RETRY_DELAYS.length - 1)]);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ChunkedUploadError("Upload could not be completed");
}

async function fetchStatus(
  baseUrl: string,
  session: string,
  headers: Record<string, string>,
): Promise<SessionStatus> {
  return jsonRequest<SessionStatus>(`${baseUrl}/${session}`, "GET", headers);
}

async function jsonRequest<T>(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body
      ? { ...headers, "Content-Type": "application/json" }
      : headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 404 || response.status === 410) {
    throw new ChunkedUploadError("Upload session expired", true);
  }
  if (response.status === 429) {
    await sleep(resetAfterMs(response.headers.get("X-RateLimit-Reset-After")));
    return jsonRequest(url, method, headers, body);
  }
  if (!response.ok) {
    throw new ChunkedUploadError(`Upload request failed (HTTP ${response.status})`);
  }
  return (await response.json()) as T;
}

type PartOutcome =
  | { kind: "ok" }
  | { kind: "conflict" }
  | { kind: "gone" }
  | { kind: "ratelimited"; retryAfterMs: number }
  | { kind: "failed"; status: number };

/**
 * PUT one part. XMLHttpRequest rather than fetch for upload progress events
 * (same constraint as the single-POST path).
 */
function putPart(
  url: string,
  headers: Record<string, string>,
  blob: Blob,
  onLoaded: (bytes: number) => void,
): Promise<PartOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onLoaded(event.loaded);
    });

    xhr.addEventListener("loadend", () => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        resolve({ kind: "ok" });
      } else if (xhr.status === 409) {
        resolve({ kind: "conflict" });
      } else if (xhr.status === 404 || xhr.status === 410) {
        resolve({ kind: "gone" });
      } else if (xhr.status === 429) {
        resolve({
          kind: "ratelimited",
          retryAfterMs: resetAfterMs(
            xhr.getResponseHeader("X-RateLimit-Reset-After"),
          ),
        });
      } else {
        resolve({ kind: "failed", status: xhr.status });
      }
    });

    xhr.open("PUT", url, true);
    xhr.timeout = PART_TIMEOUT;
    for (const [header, value] of Object.entries(headers)) {
      xhr.setRequestHeader(header, value);
    }
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.send(blob);
  });
}

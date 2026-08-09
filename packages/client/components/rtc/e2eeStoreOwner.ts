/**
 * Recognise the native refusal "this install's E2EE store was enrolled by a
 * DIFFERENT account".
 *
 * `account` is a single row natively and logout does not wipe it, so a second
 * account logging into the same install meets an `mls_signature_key` that
 * belongs to someone else. Native fails closed — silently re-keying would be
 * far worse — and every MLS call then fails, permanently.
 *
 * Until the native side grew a dedicated variant this arrived as
 * `{ type: "invalid_argument", field: "user_id" }`, indistinguishable from a
 * caller passing junk. All the user saw was a call chip reading NOT ENCRYPTED
 * and a screenshare that published a track and then sent no frames, because the
 * publish gate is never released when the session dies during negotiation.
 * There was no way to tell that from any other loud failure, and no way out of
 * it from the UI.
 *
 * Errors cross the IPC seam as `type`-tagged objects (see `E2EE.#rethrow`,
 * which parses the JSON message back into one), so matching the tag is the
 * house idiom — the same shape `mls_call_full` is matched with.
 */
export interface StoreOwnerMismatch {
  /** The account this install's E2EE store is enrolled to. */
  ownerUserId: string;
  /** The account that just tried to use it — i.e. who is logged in now. */
  requestedUserId: string;
}

/** The native tag. Must match `Error::MlsStoreOwnedByAnotherAccount`. */
const TAG = "mls_store_owned_by_another_account";

/**
 * Returns the two ids when `error` is the owner-mismatch refusal, else null.
 *
 * Deliberately strict: both ids must be present and non-empty. A half-parsed
 * error that yielded a mismatch with blank ids would render a banner claiming
 * the device belongs to nobody, and — worse — offer a destructive reset on the
 * strength of it. Fall through to the generic loud path instead.
 */
export function storeOwnerMismatch(error: unknown): StoreOwnerMismatch | null {
  if (typeof error !== "object" || error === null) return null;

  const e = error as Record<string, unknown>;
  if (e.type !== TAG) return null;

  const ownerUserId = e.owner_user_id;
  const requestedUserId = e.requested_user_id;
  if (typeof ownerUserId !== "string" || !ownerUserId) return null;
  if (typeof requestedUserId !== "string" || !requestedUserId) return null;

  return { ownerUserId, requestedUserId };
}

/** Convenience for `Show when={}` guards. */
export function isStoreOwnerMismatch(error: unknown): boolean {
  return storeOwnerMismatch(error) !== null;
}

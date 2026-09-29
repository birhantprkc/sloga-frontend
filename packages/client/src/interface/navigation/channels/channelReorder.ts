/**
 * Channel + category ordering for a server sidebar, as pure data.
 *
 * WHY THIS EXISTS — two reasons, and the first one is a live data-loss bug.
 *
 * 1. **The staged list must be seeded from RAW ids, never from resolved
 *    channel objects.** `Server.orderedChannels` resolves each id through
 *    `client.channels`, and the client is only ever sent the channels the
 *    viewer can see (`ViewChannel`) — the server object itself still carries
 *    the full id list (`bonfire/src/events/impl.rs` filters the channel
 *    documents, not `server.channels`). `server.edit({ categories })` is a
 *    FULL REPLACE — the backend writes the array it is given. So a payload
 *    built from resolved objects quietly drops every channel the mover cannot
 *    see, and saving a reorder evicts other people's private channels out of
 *    their categories. Seeding from `server.categories` + `server.channelIds`
 *    keeps unresolvable ids in the arrays so they round-trip untouched.
 *
 *    (The backend still prunes ids that are not in the server at all:
 *    `crates/delta/src/routes/servers/server_edit.rs` retains only
 *    `server.channels` members. That list is the full one, so a hidden
 *    channel survives the round trip and a genuinely stale id is cleaned up
 *    server-side. We do not try to second-guess it here.)
 *
 * 2. **It is unit-testable in isolation.** This module has NO imports at all
 *    — same discipline as `components/rtc/doubleClickJoinPolicy.ts` and
 *    `components/state/stores/voiceOverlay.ts`, both split out of larger
 *    modules for exactly this reason. `node --test` can load it unbuilt, so
 *    the ordering rules are specified directly rather than through a mounted
 *    sidebar and a mocked client.
 *
 * The staged mobile reorder mode is being built on these functions, and the
 * desktop drag path is intended to move onto them so the two cannot drift
 * apart. It has NOT moved yet: `ServerSidebar.tsx`'s `handleOrdering` still
 * builds its payload from `orderedChannels`, so the data-loss bug described
 * above is still live on the desktop path until that call site is ported.
 *
 * Every function is pure and total: an unknown id returns the input unchanged
 * rather than throwing, and nothing here ever mutates an argument.
 */

/**
 * Exactly the category shape `server.edit({ categories })` accepts.
 *
 * Kept as its own type so `toEditPayload` can prove, in the type system, that
 * it never leaks a client-only staging field into an API body.
 */
export type CategoryPayload = { id: string; title: string; channels: string[] };

/**
 * One category as the sidebar stages it: ids only, no resolved channels.
 *
 * Structurally the API shape plus one client-only marker, which is deliberate
 * — `toEditPayload` is then a reordering and a strip, not a conversion.
 */
export type StagedCategory = CategoryPayload & {
  /**
   * True only on the uncategorised group this module INVENTED because the
   * server has no category with that id.
   *
   * Never persisted, and never set on a category that came from
   * `server.categories`. It is the only thing that lets `toEditPayload` tell
   * "an empty group nobody created, drop it" apart from "a real, empty, user
   * category — deleting it would be irreversible". Absent on a hand-built
   * staged list, which fails safe: an unmarked category is always persisted.
   */
  synthesised?: boolean;
};

/**
 * The id of the synthetic group holding channels that belong to no category.
 *
 * Not a constant the server knows about: `orderedChannels` invents this same
 * id client-side, and the backend happily stores a category called "default"
 * if one is ever saved — its only constraint is `length(min = 1, max = 32)`
 * (`crates/core/models/src/v0/servers.rs`), no format check, so an API- or
 * bot-created category can legitimately be called "default". Keeping the
 * spelling in one place is what stops the staged list and the render from
 * disagreeing about which group is which.
 */
const DEFAULT_CATEGORY_ID = "default";

/** Title used for the synthesised uncategorised group. */
const DEFAULT_CATEGORY_TITLE = "Default";

/**
 * Build the staged list from the server's RAW state.
 *
 * @param categories `server.categories` verbatim — may be undefined-ish/empty
 *                   on a server that has never had a category.
 * @param channelIds `server.channelIds` verbatim (spread the ReactiveSet).
 *
 * Category order and each category's channel order are preserved exactly.
 * Channels present in `channelIds` but listed in no category are collected
 * into the `default` group in `channelIds` order.
 *
 * WHERE THAT GROUP SITS is dictated by `Server.orderedChannels` in stoat.js,
 * because the two lists describing the same sidebar must not disagree. That
 * getter does three things with a category whose id is "default":
 *
 * - it has channels  -> kept at its own position, and the uncategorised ids
 *                       are appended to it there;
 * - it has none      -> `continue`d, i.e. dropped from the render entirely,
 *                       and the group is `unshift`ed to index 0 instead;
 * - there is none    -> the group is `unshift`ed to index 0.
 *
 * We mirror all three, with ONE deliberate difference in the middle case: a
 * category that exists on the server is relocated to index 0, never discarded.
 * The render can afford to drop a row because rendering persists nothing; we
 * cannot, because the save is a full replace and a dropped row is a permanent
 * deletion of something a user or bot created.
 *
 * A second "default" group is never created — two groups with the same id
 * would make `applyMove` ambiguous and would round-trip as a duplicate.
 *
 * KNOWN, ACCEPTED DIVERGENCE: `orderedChannels` decides "has channels" after
 * resolving ids through `client.channels`, so a real `default` holding only
 * channels the viewer cannot see renders as if empty (group at index 0) while
 * we stage it in place. Detecting that needs the client, which would cost this
 * module its imports and its unbuilt testability — and the consequence is
 * cosmetic, whereas guessing wrong about which ids exist is the data-loss bug
 * this module was written to prevent.
 *
 * KNOWN, ACCEPTED DIVERGENCE #2: relocating a real, empty `default` keeps ITS
 * OWN TITLE, so the uncategorised group can look renamed once the save lands.
 * Before the save the renderer `continue`s that empty row and draws its own
 * invented group, titled "Default", at index 0; we stage the real row there
 * instead, under the title the server stored. After the save that row has
 * channels, so `orderedChannels` renders it in place — still index 0 — and
 * the sidebar now labels the uncategorised group with the stored title. A bot
 * that created a category with id "default" and title "Archive" therefore
 * turns "Default" into "Archive" the first time anybody saves a reorder.
 * Accepted, because both alternatives are worse: overriding the title to
 * "Default" would silently rewrite a title its creator chose, and dropping
 * the row rather than relocating it would hand it to the omit-when-empty rule
 * in `toEditPayload` — i.e. delete it. This divergence is purely cosmetic: no
 * channel moves and no category is created or destroyed. It is also barely
 * reachable, since this client only ever mints ULID category ids.
 */
export function seedStaged(
  categories: StagedCategory[],
  channelIds: string[],
): StagedCategory[] {
  // Copy every category, including ids we cannot resolve to a channel. The
  // marker is not copied from the input: only this function may set it, so a
  // caller cannot talk `toEditPayload` into dropping a real category.
  const staged: StagedCategory[] = (categories ?? []).map((category) => ({
    id: category.id,
    title: category.title,
    channels: [...(category.channels ?? [])],
  }));

  // Everything any category claims, so the leftovers can be worked out. A
  // Set (not an array scan) because a large server has thousands of ids.
  const claimed = new Set<string>();
  for (const category of staged) {
    for (const id of category.channels) claimed.add(id);
  }

  const uncategorised = (channelIds ?? []).filter((id) => !claimed.has(id));

  const existingIndex = staged.findIndex(
    (category) => category.id === DEFAULT_CATEGORY_ID,
  );

  if (existingIndex !== -1) {
    const existing = staged[existingIndex];
    // Emptiness is read BEFORE absorbing, because that is the state the
    // renderer sees when it decides whether to keep the row in place.
    const rendersInPlace = existing.channels.length > 0;

    existing.channels = [...existing.channels, ...uncategorised];

    if (!rendersInPlace) {
      // The renderer drops this row and puts the group at index 0; move the
      // real category there rather than inventing a rival with the same id.
      staged.splice(existingIndex, 1);
      staged.unshift(existing);
    }

    return staged;
  }

  // Synthesised at index 0 to match `orderedChannels`, which unshifts its
  // uncategorised group — the staged list and the rendered list then agree
  // about where the uncategorised channels sit. Created even when empty so
  // the mobile mode has a drop target to move the last channel back into;
  // `toEditPayload` is what decides not to persist an empty one.
  staged.unshift({
    id: DEFAULT_CATEGORY_ID,
    title: DEFAULT_CATEGORY_TITLE,
    channels: [...uncategorised],
    synthesised: true,
  });

  return staged;
}

/**
 * Replace ONE category's channel list wholesale.
 *
 * Wholesale rather than a move descriptor because that is what the drag
 * library actually delivers: `Draggable`'s `onChange` hands back the complete
 * `string[]` for the zone that changed, never a from/to pair.
 *
 * An unknown `categoryId` returns the SAME array reference, not a copy — a
 * no-op must not look like a change to a Solid signal, or a drag that landed
 * back where it started would re-render the whole sidebar.
 */
export function applyMove(
  staged: StagedCategory[],
  categoryId: string,
  channelIds: string[],
): StagedCategory[] {
  if (!staged.some((category) => category.id === categoryId)) return staged;

  return staged.map((category) =>
    category.id === categoryId
      ? { ...category, channels: [...channelIds] }
      : category,
  );
}

/**
 * Reorder the top-level categories to match `categoryIds`.
 *
 * Ids listed in `categoryIds` that are not staged are ignored, and staged
 * categories missing from `categoryIds` keep their relative order at the END
 * rather than being dropped. That asymmetry is the whole point: the drag
 * source only knows about the categories it rendered, and a category the
 * viewer cannot see any channel in must survive a reorder it never appeared
 * in — same failure the raw-id seeding guards against, one level up.
 */
export function applyCategoryOrder(
  staged: StagedCategory[],
  categoryIds: string[],
): StagedCategory[] {
  const taken = new Set<string>();
  const ordered: StagedCategory[] = [];

  for (const id of categoryIds ?? []) {
    if (taken.has(id)) continue; // a repeated id must not clone a category
    const category = staged.find((candidate) => candidate.id === id);
    if (!category) continue;
    taken.add(id);
    ordered.push(category);
  }

  for (const category of staged) {
    if (!taken.has(category.id)) ordered.push(category);
  }

  return ordered;
}

/**
 * Turn the staged list into the body for `server.edit({ categories })`.
 *
 * The decisions here key on the SYNTHESISED MARKER, never on the id, because
 * `server.edit` is a full replace and the two cases need opposite handling:
 *
 * - The synthesised group is emitted FIRST when it has channels, because
 *   `orderedChannels` unshifts it to index 0 unconditionally. Persisting it
 *   anywhere else would make the list jump the moment the save round-trips,
 *   even though nothing the user dragged had moved.
 * - The synthesised group is OMITTED when empty, because persisting it would
 *   materialise a real, permanent, empty category called "Default" that the
 *   user never created and (having no channels) cannot easily get rid of.
 * - A REAL category — including one a bot happened to name "default" — is
 *   emitted at its staged position even when the user has just emptied it.
 *   Omitting it would delete it for everyone, permanently, with no undo, and
 *   moving it to index 0 would silently reorder the sidebar on every save.
 *
 * The marker itself is stripped: the body must be exactly what the API takes.
 */
export function toEditPayload(staged: StagedCategory[]): {
  categories: CategoryPayload[];
} {
  const categories: CategoryPayload[] = [];
  let synthesisedDefault: CategoryPayload | undefined;

  for (const category of staged) {
    const copy: CategoryPayload = {
      id: category.id,
      title: category.title,
      channels: [...category.channels],
    };

    if (category.synthesised && !synthesisedDefault) {
      synthesisedDefault = copy;
      continue;
    }

    categories.push(copy);
  }

  if (synthesisedDefault && synthesisedDefault.channels.length > 0) {
    categories.unshift(synthesisedDefault);
  }

  return { categories };
}

/**
 * Whether any channel id appears more than once across the staged list.
 *
 * The caller gates Save on this. The backend rejects the ENTIRE edit with
 * `InvalidOperation` the moment it sees a repeated id
 * (`crates/delta/src/routes/servers/server_edit.rs`, the `HashSet` walk over
 * every category's channels) — so without this check a duplicate produced by
 * a half-applied drag would throw away the user's whole reorder at save time
 * with an error that names nothing.
 *
 * Deliberately a superset of "appears in two categories": the backend's set
 * is global, so the same id twice inside ONE category is rejected too, and
 * this returns true for that as well.
 */
export function hasDuplicateChannel(staged: StagedCategory[]): boolean {
  const seen = new Set<string>();

  for (const category of staged) {
    for (const id of category.channels) {
      if (seen.has(id)) return true;
      seen.add(id);
    }
  }

  return false;
}

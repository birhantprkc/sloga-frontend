// Unit spec for the sidebar channel/category ordering module — run with
// Node's built-in runner:
//   node --test --conditions=browser src/interface/navigation/channels/channelReorder.test.ts
// Focus: the staged list is seeded from RAW ids so a channel the viewer
// cannot see survives a reorder (the data-loss bug this module exists to
// fix), the staged list agrees with what `Server.orderedChannels` actually
// renders, the `default` group is synthesised exactly once and persisted only
// when it has channels, a REAL category is never deleted or repositioned by a
// save, every operation is total and non-mutating, and a duplicate id is
// caught before the backend rejects the whole edit.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type StagedCategory,
  applyCategoryOrder,
  applyMove,
  hasDuplicateChannel,
  seedStaged,
  toEditPayload,
} from "./channelReorder.ts";

/** A server with two real categories and one uncategorised channel. */
function fixture(): {
  categories: StagedCategory[];
  channelIds: string[];
} {
  return {
    categories: [
      { id: "cat-a", title: "Alpha", channels: ["c1", "c2"] },
      { id: "cat-b", title: "Beta", channels: ["c3"] },
    ],
    channelIds: ["c1", "c2", "c3", "c4"],
  };
}

/**
 * A transcription of `Server.orderedChannels` (stoat.js
 * `packages/stoat.js/src/classes/Server.ts`) over plain ids, so "the staged
 * list matches what the sidebar renders" can be ASSERTED rather than assumed.
 *
 * Copied structurally on purpose, including the `continue` that drops an
 * empty `default` — if the real getter changes, this is the thing that has to
 * be updated, and the agreement tests below are what will notice.
 *
 * The real getter resolves ids through `client.channels` first, so its notion
 * of "empty" is about VISIBLE channels; every fixture that compares against
 * this helper uses ids that are all visible, which is where the module and
 * the renderer are contracted to agree exactly.
 */
function renderOrder(
  categories: StagedCategory[],
  channelIds: string[],
): { id: string; channels: string[] }[] {
  const uncategorised = new Set(channelIds);

  const elements: { id: string; title: string; channels: string[] }[] = [];
  let defaultCategory:
    | { id: string; title: string; channels: string[] }
    | undefined;

  for (const category of categories) {
    const channels: string[] = [];
    for (const key of category.channels) {
      if (uncategorised.delete(key)) channels.push(key);
    }

    const cat = { ...category, channels };

    if (cat.id === "default") {
      if (channels.length === 0) continue;
      defaultCategory = cat;
    }

    elements.push(cat);
  }

  const channels = [...uncategorised];

  if (defaultCategory) {
    defaultCategory.channels = [...defaultCategory.channels, ...channels];
  } else {
    elements.unshift({ id: "default", title: "Default", channels });
  }

  return elements.map((category) => ({
    id: category.id,
    channels: category.channels,
  }));
}

/** The staged list reduced to what `renderOrder` reports, for comparison. */
function shape(staged: StagedCategory[]): { id: string; channels: string[] }[] {
  return staged.map((category) => ({
    id: category.id,
    channels: category.channels,
  }));
}

/* ------------------------------------------------------------------ seed */

test("seedStaged preserves category order and per-category channel order", () => {
  const { categories, channelIds } = fixture();
  const staged = seedStaged(categories, channelIds);

  // The synthetic group sits at index 0, mirroring `orderedChannels`.
  assert.deepEqual(
    staged.map((category) => category.id),
    ["default", "cat-a", "cat-b"],
  );
  assert.deepEqual(staged[1].channels, ["c1", "c2"]);
  assert.deepEqual(staged[2].channels, ["c3"]);
  assert.equal(staged[1].title, "Alpha");
  assert.deepEqual(shape(staged), renderOrder(categories, channelIds));
});

test("uncategorised ids land in a synthesised default group, in channelIds order", () => {
  const staged = seedStaged(
    [{ id: "cat-a", title: "Alpha", channels: ["c2"] }],
    // Deliberately not sorted: the group must follow channelIds, not the
    // alphabet, or the sidebar reshuffles itself on every seed.
    ["c9", "c2", "c1", "c5"],
  );

  assert.equal(staged[0].id, "default");
  assert.equal(staged[0].title, "Default");
  assert.deepEqual(staged[0].channels, ["c9", "c1", "c5"]);
  // Marked, because this module invented it — nothing on the server has it.
  assert.equal(staged[0].synthesised, true);
});

test("a NON-EMPTY existing default absorbs uncategorised ids IN PLACE, as the renderer does", () => {
  // It has a channel of its own, so `orderedChannels` keeps the row where it
  // is and appends the leftovers to it — index 0 is NOT where it belongs.
  const categories: StagedCategory[] = [
    { id: "cat-a", title: "Alpha", channels: ["c1"] },
    { id: "default", title: "Default", channels: ["c2"] },
  ];
  const channelIds = ["c1", "c2", "c3"];

  const staged = seedStaged(categories, channelIds);

  assert.deepEqual(
    staged.map((category) => category.id),
    ["cat-a", "default"],
  );
  assert.equal(
    staged.filter((category) => category.id === "default").length,
    1,
  );
  // Appended after what the real category already held.
  assert.deepEqual(staged[1].channels, ["c2", "c3"]);
  // It came from the server, so it is NOT the synthesised group and must
  // never be dropped or moved by a save.
  assert.equal(staged[1].synthesised, undefined);
  assert.deepEqual(shape(staged), renderOrder(categories, channelIds));
});

test("an EMPTY existing default moves to index 0, exactly where the renderer puts the group", () => {
  // The bug this case was written for: `orderedChannels` `continue`s an empty
  // `default`, so the group is unshifted to index 0 and the sidebar shows
  // [default, cat-a]. Staging it at its stored position instead would make
  // the mobile reorder screen disagree with the sidebar behind it.
  const categories: StagedCategory[] = [
    { id: "cat-a", title: "Alpha", channels: ["c1"] },
    { id: "default", title: "Default", channels: [] },
  ];
  const channelIds = ["c1", "c2"];

  const staged = seedStaged(categories, channelIds);

  assert.deepEqual(
    staged.map((category) => category.id),
    ["default", "cat-a"],
  );
  assert.deepEqual(staged[0].channels, ["c2"]);
  assert.deepEqual(shape(staged), renderOrder(categories, channelIds));

  // Relocated, NOT replaced: the row exists on the server, so it stays real
  // and a save can never quietly delete it.
  assert.equal(staged[0].synthesised, undefined);
});

test("an empty real default is relocated rather than discarded, and still round-trips", () => {
  // Nothing to move into it and nothing uncategorised: the payload must still
  // carry the category, because `server.edit` is a full replace and an
  // omitted category is deleted for everyone with no undo.
  const staged = seedStaged(
    [
      { id: "cat-a", title: "Alpha", channels: ["c1"] },
      { id: "default", title: "Uncategorised", channels: [] },
    ],
    ["c1"],
  );

  const { categories } = toEditPayload(staged);

  assert.deepEqual(
    categories.map((category) => category.id),
    ["default", "cat-a"],
  );
  // Its own title survives — we relocate the user's row, we do not rename it.
  assert.equal(categories[0].title, "Uncategorised");
  assert.deepEqual(categories[0].channels, []);
});

test("a channel the viewer cannot see round-trips through seed and toEditPayload", () => {
  // `c-hidden` is in a category but NOT in channelIds — exactly what a
  // channel gated behind ViewChannel looks like to this client. If the
  // staged list were built from resolved channel objects it would vanish
  // here, and the full-replace edit would evict it from its category for
  // everyone.
  const staged = seedStaged(
    [{ id: "cat-a", title: "Alpha", channels: ["c1", "c-hidden", "c2"] }],
    ["c1", "c2", "c4"],
  );

  assert.deepEqual(staged[1].channels, ["c1", "c-hidden", "c2"]);

  const { categories } = toEditPayload(staged);
  const alpha = categories.find((category) => category.id === "cat-a");

  assert.ok(alpha);
  assert.deepEqual(alpha.channels, ["c1", "c-hidden", "c2"]);
  // It must not also be treated as uncategorised and land in the default
  // group — that would be a duplicate, and the backend rejects the edit.
  assert.deepEqual(categories[0].channels, ["c4"]);
  assert.equal(hasDuplicateChannel(staged), false);
});

test("seedStaged copies the input arrays rather than aliasing them", () => {
  const { categories, channelIds } = fixture();
  const staged = seedStaged(categories, channelIds);

  staged[1].channels.push("c-injected");

  assert.deepEqual(categories[0].channels, ["c1", "c2"]);
});

test("seedStaged does not mutate an existing default it relocates", () => {
  const categories: StagedCategory[] = [
    { id: "cat-a", title: "Alpha", channels: ["c1"] },
    { id: "default", title: "Default", channels: [] },
  ];

  seedStaged(categories, ["c1", "c2"]);

  // `server.categories` is the live client object; absorbing into it would
  // corrupt the source of truth for every other reader.
  assert.deepEqual(
    categories.map((category) => category.id),
    ["cat-a", "default"],
  );
  assert.deepEqual(categories[1].channels, []);
});

test("seedStaged handles a server with no categories at all", () => {
  const staged = seedStaged([], ["c1", "c2"]);

  assert.deepEqual(staged, [
    {
      id: "default",
      title: "Default",
      channels: ["c1", "c2"],
      synthesised: true,
    },
  ]);
});

/* ------------------------------------------------------------------ move */

test("applyMove replaces one category and leaves its siblings untouched", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const moved = applyMove(staged, "cat-a", ["c2", "c1"]);

  assert.deepEqual(moved[1].channels, ["c2", "c1"]);
  assert.deepEqual(moved[2].channels, ["c3"]);
  assert.deepEqual(moved[0].channels, ["c4"]);
  assert.equal(moved[1].title, "Alpha");
});

test("applyMove does not mutate its input", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const before = JSON.stringify(staged);

  applyMove(staged, "cat-a", ["c2", "c1"]);

  assert.equal(JSON.stringify(staged), before);
});

test("applyMove carries the synthesised marker through", () => {
  // Losing it on the first drag would resurrect the "empty Default category
  // gets materialised on the server" bug that `toEditPayload` prevents.
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const moved = applyMove(staged, "default", []);

  assert.equal(moved[0].synthesised, true);
  assert.deepEqual(
    toEditPayload(moved).categories.map((category) => category.id),
    ["cat-a", "cat-b"],
  );
});

test("applyMove on an unknown category is a no-op", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const result = applyMove(staged, "cat-deleted", ["c1"]);

  // Same reference, so a Solid signal set from this does not re-render.
  assert.equal(result, staged);
});

test("applyMove can empty a category and can fill an empty one", () => {
  const staged = seedStaged(
    [
      { id: "cat-a", title: "Alpha", channels: ["c1"] },
      { id: "cat-b", title: "Beta", channels: [] },
    ],
    ["c1"],
  );

  // Last channel out of Alpha, into the previously empty Beta.
  const emptied = applyMove(staged, "cat-a", []);
  const filled = applyMove(emptied, "cat-b", ["c1"]);

  assert.deepEqual(filled[1].channels, []);
  assert.deepEqual(filled[2].channels, ["c1"]);
  assert.equal(hasDuplicateChannel(filled), false);
  // An emptied real category is still persisted — only the SYNTHESISED group
  // is dropped.
  assert.deepEqual(
    toEditPayload(filled).categories.map((category) => category.id),
    ["cat-a", "cat-b"],
  );
});

/* -------------------------------------------------------- category order */

test("applyCategoryOrder reorders the top-level list", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const ordered = applyCategoryOrder(staged, ["cat-b", "cat-a", "default"]);

  assert.deepEqual(
    ordered.map((category) => category.id),
    ["cat-b", "cat-a", "default"],
  );
});

test("applyCategoryOrder keeps unlisted categories, in relative order, at the end", () => {
  const staged: StagedCategory[] = [
    { id: "cat-a", title: "Alpha", channels: [] },
    { id: "cat-b", title: "Beta", channels: [] },
    { id: "cat-c", title: "Gamma", channels: [] },
    { id: "cat-d", title: "Delta", channels: [] },
  ];

  // Only two ids were rendered by the drag source; the other two must not
  // be dropped from the server's categories.
  const ordered = applyCategoryOrder(staged, ["cat-c", "cat-a"]);

  assert.deepEqual(
    ordered.map((category) => category.id),
    ["cat-c", "cat-a", "cat-b", "cat-d"],
  );
});

test("applyCategoryOrder ignores ids that are not staged", () => {
  const staged: StagedCategory[] = [
    { id: "cat-a", title: "Alpha", channels: [] },
    { id: "cat-b", title: "Beta", channels: [] },
  ];

  const ordered = applyCategoryOrder(staged, ["ghost", "cat-b", "cat-a"]);

  assert.deepEqual(
    ordered.map((category) => category.id),
    ["cat-b", "cat-a"],
  );
});

test("applyCategoryOrder does not mutate its input", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const before = staged.map((category) => category.id).join();

  applyCategoryOrder(staged, ["cat-b", "cat-a", "default"]);

  assert.equal(staged.map((category) => category.id).join(), before);
});

test("applyCategoryOrder carries the synthesised marker through a reorder", () => {
  // The marker survives here only because this function re-uses the original
  // category objects. A rewrite to `.map()` with an explicit field list would
  // drop it silently: `toEditPayload` would then persist the invented group
  // as a real "Default" category and stop protecting a real one — the
  // deletion bug this module exists to prevent — with nothing in the spec
  // going red. So assert the marker itself, not only its downstream effect.
  const staged = seedStaged(fixture().categories, fixture().channelIds);

  assert.equal(staged[0].synthesised, true);

  // Dragged away from index 0 ...
  const moved = applyCategoryOrder(staged, ["cat-a", "default", "cat-b"]);

  assert.deepEqual(
    moved.map((category) => category.id),
    ["cat-a", "default", "cat-b"],
  );
  assert.equal(moved[1].synthesised, true);
  // ... without a real category picking the marker up on the way through.
  assert.equal(moved[0].synthesised, undefined);
  assert.equal(moved[2].synthesised, undefined);

  // ... and dragged back again.
  const back = applyCategoryOrder(moved, ["default", "cat-a", "cat-b"]);

  assert.equal(back[0].synthesised, true);

  // The unlisted-tail path carries it too: the drag source may never have
  // rendered the group, in which case its id is absent from `categoryIds`.
  const untouched = applyCategoryOrder(staged, ["cat-b"]);

  assert.deepEqual(
    untouched.map((category) => category.id),
    ["cat-b", "default", "cat-a"],
  );
  assert.equal(untouched[1].synthesised, true);
});

test("a synthesised group emptied AFTER a reorder is still dropped from the payload", () => {
  // The consequence the marker exists for, exercised through a reorder rather
  // than straight out of `seedStaged`: a marker lost in `applyCategoryOrder`
  // would materialise an empty "Default" category on the server that nobody
  // created and, having no channels, nobody can easily delete.
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const ordered = applyCategoryOrder(staged, ["cat-a", "cat-b", "default"]);
  const emptied = applyMove(ordered, "default", []);

  assert.deepEqual(
    toEditPayload(emptied).categories.map((category) => category.id),
    ["cat-a", "cat-b"],
  );
});

/* --------------------------------------------------------------- payload */

test("toEditPayload emits the SYNTHESISED default group FIRST when it has channels", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  // Push it away from index 0 so the ordering is actually being asserted.
  const ordered = applyCategoryOrder(staged, ["cat-a", "cat-b", "default"]);

  const { categories } = toEditPayload(ordered);

  assert.deepEqual(
    categories.map((category) => category.id),
    ["default", "cat-a", "cat-b"],
  );
  assert.deepEqual(categories[0].channels, ["c4"]);
});

test("toEditPayload OMITS the SYNTHESISED default group when it is empty", () => {
  const staged = seedStaged(fixture().categories, ["c1", "c2", "c3"]);

  assert.deepEqual(staged[0], {
    id: "default",
    title: "Default",
    channels: [],
    synthesised: true,
  });

  const { categories } = toEditPayload(staged);

  assert.deepEqual(
    categories.map((category) => category.id),
    ["cat-a", "cat-b"],
  );
});

test("toEditPayload KEEPS a real category called 'default' that the user just emptied", () => {
  // Category ids are normally ULIDs, but the backend only validates
  // length(min = 1, max = 32) with no format constraint
  // (crates/core/models/src/v0/servers.rs), so a bot- or API-created category
  // can legitimately be called "default". Omitting it from a full-replace
  // edit would delete it permanently the first time a user drags its last
  // channel out.
  const staged = seedStaged(
    [
      { id: "cat-a", title: "Alpha", channels: ["c1"] },
      { id: "default", title: "Team stuff", channels: ["c2"] },
    ],
    ["c1", "c2"],
  );

  const emptied = applyMove(staged, "default", []);
  const { categories } = toEditPayload(emptied);

  assert.deepEqual(
    categories.map((category) => category.id),
    ["cat-a", "default"],
  );
  assert.equal(categories[1].title, "Team stuff");
  assert.deepEqual(categories[1].channels, []);
});

test("toEditPayload does not move a real category called 'default' to the front", () => {
  // The unshift exists so the synthesised group is persisted where the
  // renderer always draws it. Applying it to a real category would silently
  // reorder the server's sidebar on every single save.
  const staged = seedStaged(
    [
      { id: "cat-a", title: "Alpha", channels: ["c1"] },
      { id: "default", title: "Team stuff", channels: ["c2"] },
      { id: "cat-b", title: "Beta", channels: ["c3"] },
    ],
    ["c1", "c2", "c3"],
  );

  const { categories } = toEditPayload(staged);

  assert.deepEqual(
    categories.map((category) => category.id),
    ["cat-a", "default", "cat-b"],
  );
});

test("toEditPayload never leaks the staging marker into the API body", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const { categories } = toEditPayload(staged);

  for (const category of categories) {
    assert.deepEqual(Object.keys(category).sort(), ["channels", "id", "title"]);
  }
});

test("toEditPayload persists an unmarked category list unchanged", () => {
  // A staged list that did not come from `seedStaged` carries no markers, so
  // nothing is treated as synthesised and nothing is dropped. Failing safe
  // matters: the alternative is deleting a category on a caller's mistake.
  const staged: StagedCategory[] = [
    { id: "cat-a", title: "Alpha", channels: ["c1"] },
    { id: "default", title: "Default", channels: [] },
  ];

  assert.deepEqual(
    toEditPayload(staged).categories.map((category) => category.id),
    ["cat-a", "default"],
  );
});

test("toEditPayload does not alias the staged arrays", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);
  const { categories } = toEditPayload(staged);

  categories[1].channels.push("c-injected");

  assert.deepEqual(staged[1].channels, ["c1", "c2"]);
});

/* ------------------------------------------------------------ duplicates */

test("hasDuplicateChannel is true when an id appears in two categories", () => {
  const staged: StagedCategory[] = [
    { id: "cat-a", title: "Alpha", channels: ["c1", "c2"] },
    { id: "cat-b", title: "Beta", channels: ["c2"] },
  ];

  assert.equal(hasDuplicateChannel(staged), true);
});

test("hasDuplicateChannel is true for a repeat inside ONE category", () => {
  // The backend's HashSet is global, so this is rejected too.
  const staged: StagedCategory[] = [
    { id: "cat-a", title: "Alpha", channels: ["c1", "c1"] },
  ];

  assert.equal(hasDuplicateChannel(staged), true);
});

test("hasDuplicateChannel is false for a clean list", () => {
  const staged = seedStaged(fixture().categories, fixture().channelIds);

  assert.equal(hasDuplicateChannel(staged), false);
  assert.equal(hasDuplicateChannel([]), false);
});

import type { WowClass } from "stoat.js";

/**
 * Shared soft-reserve presentation data (no imports on purpose — this is
 * pulled in from both the message card and the modal layer, and a
 * dependency here would risk an import cycle through the modal index).
 */

/**
 * The classes a raider can declare, in game order. `deathknight` is valid
 * on Wrath sheets only (the class does not exist in Classic/TBC) — the
 * server rejects it elsewhere, and pickers must not offer it.
 */
export const WOW_CLASSES: WowClass[] = [
  "warrior",
  "paladin",
  "hunter",
  "rogue",
  "priest",
  "shaman",
  "mage",
  "warlock",
  "druid",
  "deathknight",
];

/** Display names (proper nouns — deliberately not localized) */
export const WOW_CLASS_NAMES: Record<WowClass, string> = {
  warrior: "Warrior",
  paladin: "Paladin",
  hunter: "Hunter",
  rogue: "Rogue",
  priest: "Priest",
  shaman: "Shaman",
  mage: "Mage",
  warlock: "Warlock",
  druid: "Druid",
  deathknight: "Death Knight",
};

/** Blizzard's canonical class colors */
export const WOW_CLASS_COLORS: Record<WowClass, string> = {
  warrior: "#C79C6E",
  paladin: "#F58CBA",
  hunter: "#ABD473",
  rogue: "#FFF569",
  priest: "#FFFFFF",
  shaman: "#0070DE",
  mage: "#69CCF0",
  warlock: "#9482C9",
  druid: "#FF7D0A",
  deathknight: "#C41F3B",
};

/** WoW item-quality colors (2 uncommon / 3 rare / 4 epic / 5 legendary) */
export const WOW_QUALITY_COLORS: Record<number, string> = {
  2: "#1EFF00",
  3: "#0070DD",
  4: "#A335EE",
  5: "#FF8000",
};

/** Classes offered for a sheet of the given edition */
export function classesForEdition(edition: string | undefined): WowClass[] {
  return edition === "wrath"
    ? WOW_CLASSES
    : WOW_CLASSES.filter((entry) => entry !== "deathknight");
}

import { For, Show, createResource, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { SoftResExportFormat } from "stoat.js";

import { styled } from "styled-system/jsx";

import { Column, Dialog, DialogProps } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { Modals } from "../types";

const FORMATS: { id: SoftResExportFormat; name: string }[] = [
  { id: "gargul", name: "Gargul" },
  { id: "raidres", name: "RollFor (Turtle)" },
  { id: "csv", name: "CSV" },
];

/**
 * Export modal: renders the sheet's FULL reserve data (the export route
 * is creator/moderator-gated and ignores `hidden` by design) in one of
 * the addon-importable formats, with a copy box.
 */
export function SoftResExportModal(
  props: DialogProps & Modals & { type: "softres_export" },
) {
  const [format, setFormat] = createSignal<SoftResExportFormat>("gargul");
  const [copied, setCopied] = createSignal(false);

  const [payload] = createResource(format, async (active) => {
    const response = await props.message.exportSoftRes(active);
    return response?.payload ?? "";
  });

  function copy() {
    const text = payload();
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Export soft reserves</Trans>}
      actions={[{ text: <Trans>Close</Trans> }]}
    >
      <Column>
        <Tabs>
          <For each={FORMATS}>
            {(entry) => (
              <Tab
                type="button"
                data-selected={format() === entry.id || undefined}
                onClick={() => {
                  setFormat(entry.id);
                  setCopied(false);
                }}
              >
                {entry.name}
              </Tab>
            )}
          </For>
        </Tabs>

        <Show when={payload.loading}>
          <Empty>
            <Trans>Rendering export…</Trans>
          </Empty>
        </Show>
        <Show when={payload.error}>
          <Empty>
            <Trans>Could not render the export.</Trans>
          </Empty>
        </Show>

        <Show when={!payload.loading && !payload.error}>
          <CopyBox readonly value={payload() ?? ""} rows={8} />
          <CopyButton type="button" onClick={copy}>
            <Symbol size={16}>{copied() ? "check" : "content_copy"}</Symbol>
            <Show when={copied()} fallback={<Trans>Copy to clipboard</Trans>}>
              <Trans>Copied</Trans>
            </Show>
          </CopyButton>
        </Show>

        <Instructions>
          <Show when={format() === "gargul"}>
            {/* Sibling fragments — nested JSX inside one <Trans> triples
                the nested text under @lingui-solid */}
            <Trans>In-game, type</Trans> <Code>/gl sr</Code>{" "}
            <Trans>
              to open Gargul's soft-reserve window, paste the string and
              import.
            </Trans>
          </Show>
          <Show when={format() === "raidres"}>
            <Trans>
              For the RollFor addon on Turtle WoW: open its soft-res
              import window, paste the string and import.
            </Trans>
          </Show>
          <Show when={format() === "csv"}>
            <Trans>
              One row per reserved item (ItemId, Name, Class, Note, Plus)
              — for spreadsheets or any addon that accepts CSV.
            </Trans>
          </Show>
        </Instructions>
      </Column>
    </Dialog>
  );
}

const Tabs = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
  },
});

const Tab = styled("button", {
  base: {
    padding: "6px 12px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    fontSize: "0.8125rem",
    border: "1px solid transparent",
    "&[data-selected]": {
      background: "var(--md-sys-color-primary-container)",
      color: "var(--md-sys-color-on-primary-container)",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const CopyBox = styled("textarea", {
  base: {
    width: "100%",
    resize: "vertical",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontFamily: "var(--fonts-monospace)",
    fontSize: "0.75rem",
    wordBreak: "break-all",
  },
});

const CopyButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    padding: "8px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-primary-container)",
    color: "var(--md-sys-color-on-primary-container)",
    fontWeight: "600",
    fontSize: "0.8125rem",
    cursor: "pointer",
  },
});

const Empty = styled("span", {
  base: {
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "6px 2px",
  },
});

const Instructions = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Code = styled("code", {
  base: {
    fontFamily: "var(--fonts-monospace)",
    background: "var(--md-sys-color-surface-container-high)",
    padding: "1px 5px",
    borderRadius: "4px",
  },
});

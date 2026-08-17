import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import {
  clearDiscordImport,
  discordImportErrorType,
  discordImportView,
  importDiscordStickerClientId,
  resumeDiscordImport,
  trackDiscordImport,
  trackDiscordImportJob,
} from "@revolt/client/discordImport";
import { inviteUrl } from "@revolt/common";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { streamerModeHides } from "@revolt/state/streamer";
import { Column, Dialog, DialogProps, Text, TextField } from "@revolt/ui";

import { Modals } from "../types";

/**
 * Where the user finds a template link in Discord.
 */
const BREADCRUMB = "Discord → Server Settings → Templates → Create Template";

/**
 * Track that reads as indeterminate when the server has not told us how many
 * items the current stage has.
 */
const ProgressTrack = styled("div", {
  base: {
    height: "6px",
    width: "100%",
    overflow: "hidden",
    borderRadius: "999px",
    background: "var(--md-sys-color-surface-container-highest)",
  },
});

const ProgressFill = styled("div", {
  base: {
    height: "100%",
    borderRadius: "999px",
    background: "var(--md-sys-color-primary)",
    transition: "width 0.3s ease",
  },
  variants: {
    // No usable total: sweep instead of pretending to know a percentage.
    // Reuses the existing `skeletonShimmer` keyframe rather than adding a new
    // one, so this needs no panda config change.
    indeterminate: {
      true: {
        width: "100%",
        background: "transparent",
        backgroundImage:
          "linear-gradient(90deg, transparent 0%, var(--md-sys-color-primary) 50%, transparent 100%)",
        backgroundSize: "200% 100%",
        animationName: "skeletonShimmer",
        animationDuration: "1.4s",
        animationIterationCount: "infinite",
        animationTimingFunction: "linear",
      },
    },
  },
});

/**
 * Invite block, mirroring the create-invite modal (including the Streamer Mode
 * blur, so finishing an import on stream does not leak the link).
 */
const Invite = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",

    "& code": {
      padding: "1em",
      userSelect: "all",
      wordBreak: "break-all",
      fontSize: "1.1em",
      textAlign: "center",
      fontFamily: "var(--fonts-monospace)",
    },
  },
  variants: {
    concealed: {
      true: {
        "& code": {
          filter: "blur(8px)",
          transition: "filter 0.15s ease",
          _hover: {
            filter: "none",
          },
        },
      },
    },
  },
});

/**
 * Import a Discord server's structure from a guild-template link.
 */
export function ImportDiscordModal(
  props: DialogProps & Modals & { type: "import_discord" },
) {
  const { t } = useLingui();
  const state = useState();
  const navigate = useNavigate();

  const [template, setTemplate] = createSignal("");
  const [starting, setStarting] = createSignal(false);
  const [startError, setStartError] = createSignal<string | undefined>();

  const view = discordImportView;
  const concealed = () => streamerModeHides(state.settings, "invites");

  /**
   * Which screen to show. Derived entirely from the shared store so the modal
   * can be dismissed and reopened without losing the job.
   */
  const screen = () => {
    const current = view();
    if (!current) return "explain" as const;
    if (current.status === "Completed") return "done" as const;
    if (current.status === "Failed") return "failed" as const;
    return "importing" as const;
  };

  /**
   * Human label for an opaque server stage string. Unknown stages fall back to
   * the raw value rather than rendering "undefined" — later slices add stages
   * that this build has never heard of.
   */
  function stageLabel(stage: string): string {
    switch (stage) {
      case "Fetching":
        return t`Reading the Discord template…`;
      case "Server":
        return t`Creating your server…`;
      case "Roles":
        return t`Recreating roles and permissions…`;
      case "Channels":
        return t`Recreating channels…`;
      case "Membership":
        return t`Setting you up as the owner…`;
      case "Invite":
        return t`Generating an invite…`;
      case "Stickers":
        return t`Importing stickers…`;
      case "Done":
        return t`Finishing up…`;
      case "":
        return t`Waiting for a worker…`;
      default:
        return stage;
    }
  }

  const link = () => {
    const code = view()?.inviteCode;
    return code ? inviteUrl(code) : "";
  };

  /** Whether the tracked job is a sticker run rather than a template import. */
  const isStickerJob = () => view()?.kind === "Stickers";

  /**
   * Whether the finished template import can offer the sticker step: the
   * instance has the bot configured AND the job knows its source guild
   * (pre-slice-2 jobs don't).
   */
  const stickerOffer = () =>
    !isStickerJob() && !!view()?.sourceGuildId && !!importDiscordStickerClientId();

  /**
   * Bot-invite URL, guild preselected. `permissions=0` on purpose — reading
   * the sticker list needs no permission bits, and asking for none is the
   * honest ask.
   */
  const botInviteUrl = () => {
    const clientId = importDiscordStickerClientId();
    const guildId = view()?.sourceGuildId;
    return clientId && guildId
      ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=0&guild_id=${guildId}&disable_guild_select=true`
      : "";
  };

  // Land the user in the server they just imported. Deferred a tick, as in the
  // create-server modal, so the navigation does not race the modal's own
  // render. The modal is portaled and survives the route change, so the invite
  // stays on screen.
  // Keyed by job id, not a plain boolean, so a second import started from this
  // same modal instance still navigates.
  let navigatedJobId: string | undefined;
  createEffect(() => {
    const current = view();
    if (!current || current.status !== "Completed" || !current.serverId) return;
    // A finished STICKER run must not re-navigate: it has a fresh job id and
    // carries `serverId`, but the user is already wherever they want to be —
    // yanking them to the server mid-flow reads as a glitch.
    if (current.kind === "Stickers") return;
    if (navigatedJobId === current.jobId) return;
    navigatedJobId = current.jobId;
    setTimeout(() => navigate(`/server/${current.serverId}`));
  });

  /**
   * Kick off the import.
   */
  async function start() {
    const value = template().trim();
    if (!value || starting()) return;

    setStarting(true);
    setStartError(undefined);

    try {
      const { job_id } = await props.client.importDiscordTemplate(value);
      trackDiscordImport(job_id);
    } catch (error) {
      // The raw-fetch helper throws the PARSED BODY, not an Error, and drops
      // the status code — 409 is only identifiable by this tag.
      switch (discordImportErrorType(error)) {
        case "ImportAlreadyInProgress":
          setStartError(
            t`You already have an import running. Wait for it to finish before starting another.`,
          );
          // Adopt the job we collided with, so the user lands on its progress
          // instead of a dead-end error.
          resumeDiscordImport(props.client);
          break;
        case "TooManyServers":
          setStartError(
            t`You've reached the maximum number of servers you can be in.`,
          );
          break;
        case "InvalidOperation":
          setStartError(
            t`That doesn't look like a Discord server template link.`,
          );
          break;
        case "OperationFailed":
          setStartError(t`Importing from Discord is not available right now.`);
          break;
        default:
          setStartError(t`Could not start the import. Try again shortly.`);
      }
    } finally {
      setStarting(false);
    }
  }

  /**
   * Kick off the sticker step against a Completed template job. The modal
   * flips back to the importing screen the moment the returned job row is
   * tracked; all the existing worker/poll/resume machinery follows the new
   * job unchanged.
   * @param parentJobId The Completed TEMPLATE job's id
   */
  async function startStickers(parentJobId: string) {
    if (starting()) return;

    setStarting(true);
    setStartError(undefined);

    try {
      const job = await props.client.importDiscordStickers(parentJobId);
      trackDiscordImportJob(job);
    } catch (error) {
      switch (discordImportErrorType(error)) {
        case "ImportAlreadyInProgress":
          setStartError(
            t`You already have an import running. Wait for it to finish before starting another.`,
          );
          resumeDiscordImport(props.client);
          break;
        case "InvalidOperation":
          setStartError(
            t`Stickers can't be imported for this server. Try running the import again first.`,
          );
          break;
        case "OperationFailed":
          setStartError(t`Sticker import is not available right now.`);
          break;
        default:
          setStartError(t`Could not start the sticker import. Try again shortly.`);
      }
    } finally {
      setStarting(false);
    }
  }

  /**
   * Acknowledge a finished import and reset back to the explain screen.
   */
  function finish() {
    clearDiscordImport();
    setTemplate("");
    setStartError(undefined);
    props.onClose();
  }

  /**
   * Actions per screen. Every handler returns `false`: a Dialog action that
   * returns a promise (or undefined) auto-closes the dialog, which would
   * unmount this the instant the import starts.
   */
  const actions = () => {
    switch (screen()) {
      case "explain":
        return [
          { text: <Trans>Cancel</Trans> },
          {
            text: <Trans>Start import</Trans>,
            onClick: () => {
              start();
              return false;
            },
            isDisabled: !template().trim() || starting(),
          },
        ];
      case "importing":
        return [{ text: <Trans>Hide</Trans> }];
      case "done": {
        // A finished sticker run has no invite to copy — but if some
        // stickers didn't make it, offer to run again (creation is
        // idempotent by name, so a retry only fills the gaps).
        if (isStickerJob()) {
          const current = view()!;
          const canRetry =
            !!current.parentJobId &&
            (current.summary?.stickers_skipped ?? 0) > 0;
          return [
            ...(canRetry
              ? [
                  {
                    text: <Trans>Run again</Trans>,
                    onClick: () => {
                      if (!starting()) startStickers(current.parentJobId!);
                      return false;
                    },
                    isDisabled: starting(),
                  },
                ]
              : []),
            {
              text: <Trans>Done</Trans>,
              onClick: () => {
                finish();
                return false;
              },
            },
          ];
        }

        return [
          // Only once the user has had a chance to add the bot (the link is
          // in the body copy above these actions).
          ...(stickerOffer()
            ? [
                {
                  text: <Trans>Import stickers</Trans>,
                  onClick: () => {
                    startStickers(view()!.jobId);
                    return false;
                  },
                  isDisabled: starting(),
                },
              ]
            : []),
          {
            text: <Trans>Copy invite</Trans>,
            onClick: () => {
              navigator.clipboard.writeText(link());
              return false;
            },
          },
          {
            text: <Trans>Done</Trans>,
            onClick: () => {
              finish();
              return false;
            },
          },
        ];
      }
      case "failed":
        return [
          {
            text: <Trans>Close</Trans>,
            onClick: () => {
              finish();
              return false;
            },
          },
          {
            text: <Trans>Try again</Trans>,
            onClick: () => {
              // A second click while a retry POST is in flight must be a
              // no-op — falling through to the template-reset branch would
              // wipe the failed sticker context out of the store mid-flight.
              if (starting()) return false;

              // A failed sticker run retries the sticker POST against its
              // parent (both ride the wire, so this survives a reload); a
              // failed template import starts over from the explain screen.
              const current = view();
              if (current?.kind === "Stickers" && current.parentJobId) {
                startStickers(current.parentJobId);
              } else {
                clearDiscordImport();
                setStartError(undefined);
              }
              return false;
            },
          },
        ];
    }
  };

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Import from Discord</Trans>}
      actions={actions()}
    >
      <Switch>
        {/* ---------------------------------------------------- explain -- */}
        <Match when={screen() === "explain"}>
          <Column>
            <Text>
              <Trans>
                Paste a Discord server template link and we'll rebuild that
                server's layout here.
              </Trans>
            </Text>

            <Text class="label">
              <Trans>What comes across</Trans>
            </Text>
            <Text>
              <Trans>
                The server name, its categories and its channels in order, its
                roles with their colors and ranking, and who can see and do what
                in each channel — private channels included.
              </Trans>
            </Text>

            <Text class="label">
              <Trans>What doesn't</Trans>
            </Text>
            <Text>
              <Trans>
                Custom emojis and the server icon aren't in a Discord template,
                so they can't come across this way.
              </Trans>
            </Text>
            <Show when={importDiscordStickerClientId()}>
              <Text>
                <Trans>
                  Stickers can come across, though — once the import finishes,
                  we'll offer to fetch them for you.
                </Trans>
              </Text>
            </Show>
            <Text>
              <Trans>
                Bots aren't data — they're separate programs running against
                Discord, so there's nothing to copy. You'll set them up again
                here.
              </Trans>
            </Text>
            <Text>
              <Trans>
                Members can't be copied either; we'll hand you an invite link
                at the end to bring them over.
              </Trans>
            </Text>
            <Text>
              <Trans>Message history stays on Discord.</Trans>
            </Text>

            <Text class="label">
              <Trans>Getting a link</Trans>
            </Text>
            {/* Sibling nodes, never nested inside <Trans>: an element inside a
                <Trans> is rendered once per branch, tripling its content. */}
            <Text>
              <Trans>In Discord, go to:</Trans>
            </Text>
            <Text>{BREADCRUMB}</Text>
            <Text>
              <Trans>then copy the link it gives you.</Trans>
            </Text>

            <TextField
              value={template()}
              variant="filled"
              label={t`Template link`}
              placeholder="https://discord.new/xxxxxxxxxxxx"
              // `onInput` catches a paste (the normal way a link arrives here);
              // `onChange` catches blur/enter on the mdui custom element.
              onInput={(e) => setTemplate(e.currentTarget.value)}
              onChange={(e) => setTemplate(e.currentTarget.value)}
            />

            <Show when={startError()}>
              <Text class="label">{startError()}</Text>
            </Show>
          </Column>
        </Match>

        {/* -------------------------------------------------- importing -- */}
        <Match when={screen() === "importing"}>
          <Column>
            <Text>{stageLabel(view()!.stage)}</Text>
            <ProgressTrack>
              {/* `total` is legitimately 0 while a stage is indeterminate —
                  dividing by it would render a NaN-wide bar. */}
              <ProgressFill
                indeterminate={!(view()!.total > 0)}
                style={
                  view()!.total > 0
                    ? {
                        width: `${Math.min(
                          100,
                          Math.round((view()!.done / view()!.total) * 100),
                        )}%`,
                      }
                    : undefined
                }
              />
            </ProgressTrack>
            <Show when={view()!.total > 0}>
              <Text class="label">
                {view()!.done} / {view()!.total}
              </Text>
            </Show>
            <Text class="label">
              <Trans>
                You can close this — the import keeps going and we'll let you
                know when it's ready.
              </Trans>
            </Text>
          </Column>
        </Match>

        {/* ------------------------------------------------- done: stickers */}
        <Match when={screen() === "done" && isStickerJob()}>
          <Column>
            <Text>
              {t`Imported ${view()!.summary?.stickers_created ?? 0} stickers.`}
            </Text>
            <Text class="label">
              <Trans>
                You can kick the importer bot from your Discord server now —
                it doesn't need to stay.
              </Trans>
            </Text>
            <Show when={view()!.summary?.notes.length}>
              <Text class="label">
                <Trans>Notes</Trans>
              </Text>
              {/* Server-generated English; intentionally rendered verbatim. */}
              <For each={view()!.summary!.notes}>
                {(note) => <Text class="label">{note}</Text>}
              </For>
            </Show>
          </Column>
        </Match>

        {/* ------------------------------------------------------- done -- */}
        <Match when={screen() === "done"}>
          <Column>
            <Text>
              <Trans>
                Your server is ready. Paste this invite in Discord to bring
                your members over.
              </Trans>
            </Text>

            <Invite concealed={concealed()}>
              <code>{link()}</code>
              <Show when={concealed()}>
                <Text class="label">
                  <Trans>
                    Streamer Mode is hiding your invite link — hover over it to
                    reveal.
                  </Trans>
                </Text>
              </Show>
            </Invite>

            <Show when={view()!.summary}>
              <Text class="label">
                <Trans>Notes</Trans>
              </Text>
              <Text>
                {t`Created ${view()!.summary!.channels_created} channels, ${view()!.summary!.categories_created} categories and ${view()!.summary!.roles_created ?? 0} roles.`}
              </Text>
              {/* Server-generated English; intentionally rendered verbatim. */}
              <For each={view()!.summary!.notes}>
                {(note) => <Text class="label">{note}</Text>}
              </For>
            </Show>

            <Show when={stickerOffer()}>
              <Text class="label">
                <Trans>Stickers</Trans>
              </Text>
              <Text>
                <Trans>
                  Want your Discord server's stickers too? Add our importer
                  bot to it, then press Import stickers below.
                </Trans>
              </Text>
              {/* Sibling nodes, never nested inside <Trans> (triple-render
                  trap). External link: the desktop shell routes target=_blank
                  through the system browser. */}
              <Text>
                <a href={botInviteUrl()} target="_blank" rel="noreferrer">
                  <Trans>Add the importer bot on Discord</Trans>
                </a>
              </Text>
              <Text class="label">
                <Trans>
                  The bot only reads stickers, and you can kick it as soon as
                  they're in.
                </Trans>
              </Text>
            </Show>

            <Show when={startError()}>
              <Text class="label">{startError()}</Text>
            </Show>
          </Column>
        </Match>

        {/* ----------------------------------------------------- failed -- */}
        <Match when={screen() === "failed"}>
          <Column>
            <Text>
              <Trans>The import didn't finish.</Trans>
            </Text>
            {/* Already user-safe server-side; shown verbatim. */}
            <Text>{view()!.error}</Text>
            {/* Live-smoke finding: the "bot not added yet" failure tells the
                user to add the bot but gave them nowhere to do it — the
                invite link lived only on the parent's done screen, which is
                gone by now. The view still knows the guild, so offer it. */}
            <Show when={isStickerJob() && botInviteUrl()}>
              <Text>
                <a href={botInviteUrl()} target="_blank" rel="noreferrer">
                  <Trans>Add the importer bot on Discord</Trans>
                </a>
              </Text>
            </Show>
            <Show when={startError()}>
              <Text class="label">{startError()}</Text>
            </Show>
          </Column>
        </Match>
      </Switch>
    </Dialog>
  );
}

/**
 * Linux screen-share audio — what a share's audio is allowed to cover
 * (screenshare-audio design §9), as pure functions over the shell's
 * answers.
 *
 * This is the renderer's half of §9's privacy rule, kept dependency-free
 * so it can be tested directly: a share may capture system-wide audio
 * only when it is genuinely a full-screen share, and anything the shell
 * cannot attribute — plus anything that goes wrong on the way to finding
 * out — must ask the user instead. A silent wrong answer broadcasts an
 * application the user never chose, which the design classifies as a
 * privacy failure rather than a UX nit. Every branch below therefore
 * fails toward `ask`, and `system` is only ever reached deliberately.
 *
 * `screenAudioNative.ts` owns the IPC, the deadline and the capture; it
 * makes no decisions of its own.
 */

/** What a capture should link. `system` is slice 1's headline — everything
 * except Sloga's own playback; `include` holds the shell's stable
 * application identities, never PipeWire node ids (the daemon recycles
 * those onto other applications between a chooser pick and its use). */
export type ScreenAudioTargets =
  | { mode: "system" }
  | { mode: "targets"; include: string[] };

/**
 * The verdict for the share that just started:
 * - a capture plan (`system` / `targets`),
 * - `ask` when the shared window cannot be attributed to exactly one
 *   application, so the user has to say which app's sound to send,
 * - `skip` when this shell cannot answer the question at all and the
 *   chooser cannot help either. No audio, no dialog.
 */
export type ScreenAudioPlan =
  | ScreenAudioTargets
  | { mode: "ask"; reason: string }
  | { mode: "skip"; reason: string };

/** One application the chooser can offer. */
export interface ScreenAudioApp {
  /** The shell's stable identity for this application — the row key AND
   * what gets sent back as the target. */
  key: string;
  name: string;
}

/** The shell's raw answer to "what should this share's audio cover?". */
export interface ShellTargetAnswer {
  mode?: string;
  include?: string[];
  appLabel?: string;
  reason?: string;
}

/** One entry of the shell's audio-stream roster. */
export interface ShellAppStream {
  id: number;
  identity?: string;
  appName?: string;
  binary?: string;
  nodeName?: string;
}

/**
 * The plan for a shell with no slice-2 targeting surface at all.
 *
 * A capability gap must never be read as consent. Such a shell can still
 * produce a window share — the Wayland portal's picker offers windows —
 * and answering `system` there would put the whole machine's audio on a
 * share the user made of one window. Only a monitor share may fall back
 * to slice-1 behavior; anything else gets no audio, because the chooser
 * needs `setTargets`, which that shell does not have either.
 */
export function planWithoutTargeting(displaySurface?: string): ScreenAudioPlan {
  return displaySurface === "monitor"
    ? { mode: "system" }
    : { mode: "skip", reason: "shell_cannot_target" };
}

/**
 * The plan implied by the shell's answer, cross-checked against what the
 * renderer knows first-hand.
 *
 * `answer` is undefined when the shell did not produce one (a timeout, a
 * rejection); `noAnswerReason` names which, for the logs.
 */
export function planFromAnswer(
  answer: ShellTargetAnswer | undefined,
  displaySurface?: string,
  noAnswerReason = "unknown_window",
): ScreenAudioPlan {
  if (!answer) return { mode: "ask", reason: noAnswerReason };

  if (answer.mode === "targets" && answer.include?.length) {
    return { mode: "targets", include: answer.include };
  }

  if (answer.mode === "system") {
    // Cross-check the shell's most consequential answer against something
    // the renderer knows first-hand. `resolveTarget` reads ambient
    // main-process state ("the source we last granted"), so a rapid
    // stop→start, a second window, or any lag in that record could answer
    // for the WRONG share — and the wrong answer in this direction turns
    // a one-window share into a whole-desktop audio broadcast. The
    // share's own displaySurface disagreeing is enough to fall back to
    // asking. An unknown surface cannot contradict anything, so it does
    // not.
    return displaySurface === undefined || displaySurface === "monitor"
      ? { mode: "system" }
      : { mode: "ask", reason: "surface_mismatch" };
  }

  // Everything else — an explicit `ask`, `targets` narrowed to nothing, a
  // mode this build does not recognize — asks.
  return { mode: "ask", reason: answer.reason ?? noAnswerReason };
}

/**
 * The chooser's roster: one row per application.
 *
 * Grouped on the shell's identity key, never on the display name: that
 * reads "Chromium" for every Chromium-derived app, so grouping on it
 * would merge unrelated applications into one row and therefore one
 * target set. A stream with no identity (an older shell) gets a
 * per-stream key rather than sharing a constant one, so two unnamed apps
 * never collapse into a single row either.
 */
export function groupAppRoster(
  streams: ShellAppStream[] | undefined,
): ScreenAudioApp[] {
  const apps = new Map<string, ScreenAudioApp>();
  for (const stream of streams ?? []) {
    const key = stream.identity || `id:${stream.id}`;
    if (apps.has(key)) continue;
    apps.set(key, {
      key,
      name: stream.appName || stream.binary || stream.nodeName || key,
    });
  }
  return [...apps.values()];
}

import { createEffect, onCleanup, onMount } from "solid-js";

import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import {
  ANNOTATION_CLEAR_MS,
  ANNOTATION_COORD_SCALE,
  ANNOTATION_FADE_START_MS,
  ANNOTATION_LAYER_ALPHA,
  ANNOTATION_PALETTE,
  ANNOTATION_WIDTHS,
} from "@revolt/rtc/annotations/liveAnnotations";

/**
 * Passive ink overlay on a screenshare tile (tech-support-mode plan §2.5).
 * Renders every live annotation batch addressed to this participant's
 * surface. Mounted on the SCREEN-SHARE branch of the tile, `pointer-events:
 * none` at z5 — the `ParticipantCaption` layering precedent: above the
 * video and the hover `Overlay`, below the z20 remote-control capture
 * surface, never intercepting a click.
 *
 * THE OPACITY CAP (§2.4, non-negotiable): strokes draw OPAQUE onto an
 * offscreen canvas, and that whole layer composites onto the visible canvas
 * once, at `ANNOTATION_LAYER_ALPHA`. Per-stroke translucency cannot bound
 * what stacked strokes composite to — this structure can: no pixel of ink
 * ever exceeds the cap, no matter how many strokes pile up, so "translucent
 * ink" stays true against an adversarial redrawer, not just a polite one.
 */
export function AnnotationLayer(props: {
  identity: string;
  /** Intrinsic video dimensions from the tile's `videoDims` signal —
   *  {0,0} until the first `resize`, in which case the whole element box is
   *  treated as content (a brief mis-scale, corrected on the next frame). */
  videoDims: () => { width: number; height: number };
}) {
  const voice = useVoice();

  let canvasRef: HTMLCanvasElement | undefined;
  let offscreen: HTMLCanvasElement | undefined;
  let raf: number | undefined;

  const draw = () => {
    raf = undefined;
    const canvas = canvasRef;
    if (!canvas) return;
    const batches = voice.annotations.batches.get(props.identity);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(rect.width * dpr);
    const pixelHeight = Math.round(rect.height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!batches || batches.length === 0) return;

    // The video letterboxes (`object-fit: contain`), so stroke coordinates
    // map into the CONTENT box, not the element box — the same geometry
    // `normalizeToContentBox` applies on capture, inverted. Until the first
    // `resize` populates `videoDims` we draw NOTHING rather than mis-scale
    // full-frame for a frame or two (review: skip, don't approximate);
    // the reactive kick redraws as soon as real dims land.
    const dims = props.videoDims();
    if (!dims || dims.width <= 0 || dims.height <= 0) {
      raf = requestAnimationFrame(draw);
      return;
    }
    const scale = Math.min(
      canvas.width / dims.width,
      canvas.height / dims.height,
    );
    const contentWidth = dims.width * scale;
    const contentHeight = dims.height * scale;
    const left = (canvas.width - contentWidth) / 2;
    const top = (canvas.height - contentHeight) / 2;

    offscreen ??= document.createElement("canvas");
    if (offscreen.width !== canvas.width) offscreen.width = canvas.width;
    if (offscreen.height !== canvas.height) offscreen.height = canvas.height;
    const off = offscreen.getContext("2d");
    if (!off) return;
    off.clearRect(0, 0, offscreen.width, offscreen.height);
    off.lineCap = "round";
    off.lineJoin = "round";

    const now = Date.now();
    let anyLive = false;
    for (const batch of batches) {
      const age = now - batch.at;
      if (age >= ANNOTATION_CLEAR_MS) continue;
      anyLive = true;
      // Fade applies per BATCH on the offscreen layer; even where faded
      // strokes overlap and re-sum toward opaque there, the single capped
      // composite below still bounds the on-screen result.
      off.globalAlpha =
        age <= ANNOTATION_FADE_START_MS
          ? 1
          : 1 -
            (age - ANNOTATION_FADE_START_MS) /
              (ANNOTATION_CLEAR_MS - ANNOTATION_FADE_START_MS);
      for (const stroke of batch.strokes) {
        const palette =
          ANNOTATION_PALETTE[stroke.color] ?? ANNOTATION_PALETTE[0];
        const width = ANNOTATION_WIDTHS[stroke.width] ?? ANNOTATION_WIDTHS[0];
        off.strokeStyle = palette;
        off.lineWidth = width * (canvas.width / 1920 || 1);
        off.beginPath();
        for (let i = 0; i + 1 < stroke.points.length; i += 2) {
          const x =
            left + (stroke.points[i] / ANNOTATION_COORD_SCALE) * contentWidth;
          const y =
            top +
            (stroke.points[i + 1] / ANNOTATION_COORD_SCALE) * contentHeight;
          if (i === 0) off.moveTo(x, y);
          else off.lineTo(x, y);
        }
        // A single point still marks (a dot is a legitimate "here").
        if (stroke.points.length === 2) {
          off.lineTo(
            left +
              (stroke.points[0] / ANNOTATION_COORD_SCALE) * contentWidth +
              0.01,
            top + (stroke.points[1] / ANNOTATION_COORD_SCALE) * contentHeight,
          );
        }
        off.stroke();
      }
    }
    off.globalAlpha = 1;

    // THE CAP: one composite at the fixed ceiling — clipped to the video
    // content box so edge strokes cannot bleed line-width into the
    // letterbox (review: ink stays on the picture, nowhere else).
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, contentWidth, contentHeight);
    ctx.clip();
    ctx.globalAlpha = ANNOTATION_LAYER_ALPHA;
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();

    if (anyLive && raf === undefined) {
      raf = requestAnimationFrame(draw);
    }
  };

  const kick = () => {
    if (raf === undefined) raf = requestAnimationFrame(draw);
  };

  onMount(kick);
  // Reactive kick: a new batch (or a consent clear emptying the array)
  // restarts/refreshes the loop; the loop parks itself when nothing is live.
  createEffect(() => {
    voice.annotations.batches.get(props.identity);
    kick();
  });
  onCleanup(() => {
    if (raf !== undefined) cancelAnimationFrame(raf);
  });

  return <InkCanvas ref={canvasRef} />;
}

const InkCanvas = styled("canvas", {
  base: {
    gridArea: "1/1",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: 5,
  },
});

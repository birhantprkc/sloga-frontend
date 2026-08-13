import { createSignal, onCleanup } from "solid-js";

import { styled } from "styled-system/jsx";

import { normalizeToContentBox, useVoice } from "@revolt/rtc";
import {
  type AnnotationStrokeData,
  ANNOTATION_COORD_SCALE,
  ANNOTATION_SEND_INTERVAL_MS,
  MAX_POINT_VALUES_PER_STROKE,
  MAX_STROKES_PER_BATCH,
} from "@revolt/rtc/annotations/liveAnnotations";

/**
 * Pointer-capture surface for DRAWING on someone else's screenshare tile
 * (tech-support-mode plan §2.5). Mounted only while the sharer's consent
 * allowlist names this user and draw mode is toggled on — and never while a
 * remote-control session is live on this tile (the z20 RC capture surface
 * keeps exclusive input; this sits at z8, above passive chrome, below RC).
 *
 * ISOLATION CONTRACT (plan §0.3): a stroke is a picture. This component
 * shares exactly ONE thing with remote control — the pure, read-only
 * `normalizeToContentBox` geometry — and must never import from or call
 * into the seal/inject path. Strokes leave over REST
 * (`Channel.sendAnnotation`), never a sealed data topic.
 *
 * Coalescing (plan §2.3): pointer samples accumulate into the current
 * polyline and flush on a fixed interval (≤10 Hz), one request carrying
 * everything since the last tick — the primary rate control; the server
 * bucket only bounds a hostile client.
 */
export function AnnotationCapture(props: {
  video: HTMLVideoElement | undefined;
  videoDims: () => { width: number; height: number };
  sharerIdentity: string;
  sharerUserId: string;
  /** Called when the server refuses a send (consent revoked mid-draw). */
  onRefused: () => void;
}) {
  const voice = useVoice();

  const [drawing, setDrawing] = createSignal(false);

  let seq = 0;
  /** Strokes completed since the last flush. */
  let pending: AnnotationStrokeData[] = [];
  /** The stroke currently under the pointer (points still accumulating). */
  let current: number[] | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  const colorIndex = () => voice.annotationColor();

  const toFixed = (value: number) =>
    Math.max(
      0,
      Math.min(
        ANNOTATION_COORD_SCALE,
        Math.round(value * ANNOTATION_COORD_SCALE),
      ),
    );

  const samplePoint = (
    event: PointerEvent,
  ): { x: number; y: number } | undefined => {
    const video = props.video;
    if (!video) return undefined;
    const normalized = normalizeToContentBox(
      video.getBoundingClientRect(),
      props.videoDims(),
      event,
    );
    if (!normalized) return undefined;
    return { x: toFixed(normalized.x), y: toFixed(normalized.y) };
  };

  const flush = () => {
    // Close out an in-progress stroke SEGMENT so long drags render live:
    // ship what we have and continue the stroke from its last point.
    if (current && current.length >= 4) {
      pending.push({ points: current, color: colorIndex(), width: 1 });
      current = [current[current.length - 2], current[current.length - 1]];
    }
    if (pending.length === 0) return;
    const batch = pending.slice(0, MAX_STROKES_PER_BATCH);
    pending = pending.slice(MAX_STROKES_PER_BATCH);
    const channel = voice.channel();
    if (!channel) return;
    seq += 1;
    const thisSeq = seq;
    // Local self-mirror first (the relay skips the sender).
    voice.annotations.addLocalStrokes(
      props.sharerIdentity,
      props.sharerUserId,
      batch,
      thisSeq,
    );
    void channel
      .sendAnnotation(props.sharerUserId, batch, thisSeq)
      .then((ok) => {
        // A refusal means consent went away mid-draw (or the share ended):
        // stop capturing rather than spamming refused requests.
        if (!ok) props.onRefused();
      });
  };

  const startFlushing = () => {
    flushTimer ??= setInterval(flush, ANNOTATION_SEND_INTERVAL_MS);
  };
  const stopFlushing = () => {
    flush();
    if (flushTimer !== undefined) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
  };

  onCleanup(() => {
    current = undefined;
    pending = [];
    stopFlushing();
  });

  return (
    <DrawSurface
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const point = samplePoint(event);
        if (!point) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.stopPropagation();
        setDrawing(true);
        current = [point.x, point.y];
        startFlushing();
      }}
      onPointerMove={(event) => {
        if (!drawing() || !current) return;
        const point = samplePoint(event);
        if (!point) return;
        // Skip zero-motion samples; cap the stroke's point budget by
        // splitting (flush handles shipping the closed segment).
        const lastX = current[current.length - 2];
        const lastY = current[current.length - 1];
        if (point.x === lastX && point.y === lastY) return;
        current.push(point.x, point.y);
        if (current.length >= MAX_POINT_VALUES_PER_STROKE) flush();
      }}
      onPointerUp={(event) => {
        if (!drawing()) return;
        event.stopPropagation();
        setDrawing(false);
        if (current && current.length >= 2) {
          // A tap becomes a dot (two identical coordinate pairs).
          if (current.length === 2) current.push(current[0], current[1]);
          pending.push({ points: current, color: colorIndex(), width: 1 });
        }
        current = undefined;
        stopFlushing();
      }}
      onPointerCancel={() => {
        setDrawing(false);
        current = undefined;
        stopFlushing();
      }}
      // The tile beneath toggles focus on click; a draw gesture must not.
      onClick={(event) => event.stopPropagation()}
    />
  );
}

const DrawSurface = styled("div", {
  base: {
    gridArea: "1/1",
    width: "100%",
    height: "100%",
    // Above the passive ink layer (z5) and hover chrome, BELOW the z20
    // remote-control capture surface — RC keeps exclusive input when armed
    // (the tile unmounts this surface then anyway).
    zIndex: 8,
    cursor: "crosshair",
    touchAction: "none",
  },
});

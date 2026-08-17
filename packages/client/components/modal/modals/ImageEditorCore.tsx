import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * The image editor proper — loaded behind a dynamic import so none of this
 * (or its future OCR dependency) lands in the boot chunk.
 *
 * All geometry is stored in image space (natural pixels); the canvas is
 * scaled down for display with CSS only, so drawings render at native
 * resolution in the exported file.
 */

type ToolId =
  | "crop"
  | "pen"
  | "highlight"
  | "rect"
  | "ellipse"
  | "arrow"
  | "bar"
  | "pixelate";

type StrokeShape = {
  kind: "pen" | "highlight";
  points: number[];
  color: string;
  width: number;
};

type BoxShape = {
  kind: "rect" | "ellipse" | "arrow" | "bar" | "pixelate";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
};

type Shape = StrokeShape | BoxShape;

type Box = { x: number; y: number; w: number; h: number };

interface Props {
  file: File;
  onCancel: () => void;
  onApply: (file: File) => void;
}

const COLORS = [
  "#E53935",
  "#FDD835",
  "#43A047",
  "#1E88E5",
  "#FFFFFF",
  "#000000",
];

/** Stroke width presets, scaled up for large images at draw time */
const WIDTHS = [3, 6, 12];

/**
 * Freehand shapes store a point trail; everything else stores a drag box
 */
function isStroke(s: Shape): s is StrokeShape {
  return s.kind === "pen" || s.kind === "highlight";
}

/**
 * Normalise a dragged box (x1/y1..x2/y2 in any direction) to x/y/w/h
 */
function normalise(s: { x1: number; y1: number; x2: number; y2: number }): Box {
  return {
    x: Math.min(s.x1, s.x2),
    y: Math.min(s.y1, s.y2),
    w: Math.abs(s.x2 - s.x1),
    h: Math.abs(s.y2 - s.y1),
  };
}

export function ImageEditorCore(props: Props) {
  const { t } = useLingui();

  const [shapes, setShapes] = createSignal<Shape[]>([]);
  const [redoStack, setRedoStack] = createSignal<Shape[]>([]);
  const [tool, setTool] = createSignal<ToolId>("pen");
  const [color, setColor] = createSignal(COLORS[0]);
  const [width, setWidth] = createSignal(WIDTHS[1]);
  const [crop, setCrop] = createSignal<Box | null>(null);
  const [ready, setReady] = createSignal(false);

  let canvas!: HTMLCanvasElement;
  let image!: HTMLImageElement;
  let drag: { shape: Shape | null; cropBox: Box | null } | null = null;

  // the modal recreates this component per file; props are fixed for its life
  // eslint-disable-next-line solid/reactivity
  const sourceUrl = URL.createObjectURL(props.file);
  onCleanup(() => URL.revokeObjectURL(sourceUrl));

  /**
   * Stroke widths are stored as presets; large screenshots need thicker
   * absolute strokes for the same visual weight.
   */
  function effectiveWidth(preset: number) {
    return Math.max(preset, (preset * image.naturalWidth) / 1200);
  }

  /**
   * Draw one shape onto a context (used by both preview and export)
   */
  function drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (isStroke(s)) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.kind === "highlight" ? s.width * 3.5 : s.width;
      if (s.kind === "highlight") ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(s.points[0], s.points[1]);
      for (let i = 2; i < s.points.length; i += 2) {
        ctx.lineTo(s.points[i], s.points[i + 1]);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    const box = normalise(s);

    switch (s.kind) {
      case "rect": {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        break;
      }
      case "ellipse": {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.beginPath();
        ctx.ellipse(
          box.x + box.w / 2,
          box.y + box.h / 2,
          box.w / 2,
          box.h / 2,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        break;
      }
      case "arrow": {
        const head = Math.max(14, s.width * 3.5);
        const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(
          s.x2 - head * 0.7 * Math.cos(angle),
          s.y2 - head * 0.7 * Math.sin(angle),
        );
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(
          s.x2 - head * Math.cos(angle - 0.45),
          s.y2 - head * Math.sin(angle - 0.45),
        );
        ctx.lineTo(
          s.x2 - head * Math.cos(angle + 0.45),
          s.y2 - head * Math.sin(angle + 0.45),
        );
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "bar": {
        // redaction is always solid black; recoverable styles defeat the point
        ctx.fillStyle = "#000000";
        ctx.fillRect(box.x, box.y, box.w, box.h);
        break;
      }
      case "pixelate": {
        if (box.w < 2 || box.h < 2) break;
        // sample the base image, not the composite — a redaction region
        // must not depend on annotation draw order
        const block = Math.max(
          8,
          Math.round(Math.max(image.naturalWidth, image.naturalHeight) / 64),
        );
        const small = document.createElement("canvas");
        small.width = Math.max(1, Math.round(box.w / block));
        small.height = Math.max(1, Math.round(box.h / block));
        small
          .getContext("2d")!
          .drawImage(
            image,
            box.x,
            box.y,
            box.w,
            box.h,
            0,
            0,
            small.width,
            small.height,
          );
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          small,
          0,
          0,
          small.width,
          small.height,
          box.x,
          box.y,
          box.w,
          box.h,
        );
        break;
      }
    }

    ctx.restore();
  }

  /**
   * Redraw the working canvas: image, committed shapes, the in-progress
   * shape, and the crop dimming overlay.
   */
  function redraw(preview?: Shape | null, cropPreview?: Box | null) {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    for (const s of shapes()) drawShape(ctx, s);
    if (preview) drawShape(ctx, preview);

    const c = cropPreview ?? crop();
    if (c && c.w > 0 && c.h > 0) {
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(0, 0, canvas.width, c.y);
      ctx.fillRect(0, c.y, c.x, c.h);
      ctx.fillRect(c.x + c.w, c.y, canvas.width - c.x - c.w, c.h);
      ctx.fillRect(0, c.y + c.h, canvas.width, canvas.height - c.y - c.h);
      ctx.strokeStyle = "#FFFFFF";
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = Math.max(1, image.naturalWidth / 800);
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.restore();
    }
  }

  onMount(() => {
    image = new Image();
    image.onload = () => {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      setReady(true);
      redraw();
    };
    image.src = sourceUrl;

    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        undo();
      } else if (
        event.key.toLowerCase() === "y" ||
        (event.key.toLowerCase() === "z" && event.shiftKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        redo();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
  });

  /**
   * Translate a pointer event to image-space coordinates
   */
  function toImage(event: PointerEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) * canvas.width) / rect.width,
      ((event.clientY - rect.top) * canvas.height) / rect.height,
    ];
  }

  function onPointerDown(event: PointerEvent) {
    if (!ready()) return;
    event.preventDefault();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // a pointer that vanished mid-gesture (or a synthetic event) just
      // means we track without capture
    }
    const [x, y] = toImage(event);
    const current = tool();

    if (current === "crop") {
      drag = { shape: null, cropBox: { x, y, w: 0, h: 0 } };
    } else if (current === "pen" || current === "highlight") {
      drag = {
        shape: {
          kind: current,
          points: [x, y],
          color: color(),
          width: effectiveWidth(width()),
        },
        cropBox: null,
      };
    } else {
      drag = {
        shape: {
          kind: current,
          x1: x,
          y1: y,
          x2: x,
          y2: y,
          color: color(),
          width: effectiveWidth(width()),
        },
        cropBox: null,
      };
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag) return;
    const [x, y] = toImage(event);

    if (drag.cropBox) {
      drag.cropBox.w = x - drag.cropBox.x;
      drag.cropBox.h = y - drag.cropBox.y;
      redraw(
        null,
        normalise({
          x1: drag.cropBox.x,
          y1: drag.cropBox.y,
          x2: x,
          y2: y,
        }),
      );
      return;
    }

    const shape = drag.shape!;
    if (isStroke(shape)) {
      shape.points.push(x, y);
    } else {
      shape.x2 = x;
      shape.y2 = y;
    }
    redraw(shape);
  }

  function onPointerUp(event: PointerEvent) {
    if (!drag) return;
    const [x, y] = toImage(event);
    const finished = drag;
    drag = null;

    if (finished.cropBox) {
      const box = normalise({
        x1: finished.cropBox.x,
        y1: finished.cropBox.y,
        x2: x,
        y2: y,
      });
      // clamp to the image so export offsets stay in range
      const cx = Math.max(0, box.x);
      const cy = Math.max(0, box.y);
      const clamped: Box = {
        x: cx,
        y: cy,
        w: Math.min(canvas.width - cx, box.w - (cx - box.x)),
        h: Math.min(canvas.height - cy, box.h - (cy - box.y)),
      };
      if (clamped.w >= 8 && clamped.h >= 8) setCrop(clamped);
      redraw();
      return;
    }

    const shape = finished.shape!;
    const meaningful = isStroke(shape)
      ? shape.points.length >= 4
      : Math.abs(shape.x2 - shape.x1) >= 3 ||
        Math.abs(shape.y2 - shape.y1) >= 3;

    if (meaningful) {
      setShapes([...shapes(), shape]);
      setRedoStack([]);
    }
    redraw();
  }

  function undo() {
    const list = shapes();
    if (!list.length) return;
    setRedoStack([...redoStack(), list[list.length - 1]]);
    setShapes(list.slice(0, -1));
    redraw();
  }

  function redo() {
    const list = redoStack();
    if (!list.length) return;
    setShapes([...shapes(), list[list.length - 1]]);
    setRedoStack(list.slice(0, -1));
    redraw();
  }

  /**
   * Flatten image + shapes (+ crop) to a new File and hand it back
   */
  async function apply() {
    const full = document.createElement("canvas");
    full.width = canvas.width;
    full.height = canvas.height;
    const fctx = full.getContext("2d")!;
    fctx.drawImage(image, 0, 0);
    for (const s of shapes()) drawShape(fctx, s);

    let out = full;
    const c = crop();
    if (c) {
      out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(c.w));
      out.height = Math.max(1, Math.round(c.h));
      out.getContext("2d")!.drawImage(full, -Math.round(c.x), -Math.round(c.y));
    }

    const jpeg = props.file.type === "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      out.toBlob(resolve, jpeg ? "image/jpeg" : "image/png", 0.92),
    );
    if (!blob) return;

    const keepName = jpeg || props.file.type === "image/png";
    const name = keepName
      ? props.file.name
      : props.file.name.replace(/\.[^.]+$/, "") + ".png";
    props.onApply(new File([blob], name, { type: blob.type }));
  }

  const tools: { id: ToolId; icon: string; label: () => string }[] = [
    { id: "crop", icon: "crop", label: () => t`Crop` },
    { id: "pen", icon: "stylus", label: () => t`Pen` },
    { id: "highlight", icon: "ink_highlighter", label: () => t`Highlighter` },
    { id: "rect", icon: "rectangle", label: () => t`Rectangle` },
    { id: "ellipse", icon: "circle", label: () => t`Ellipse` },
    { id: "arrow", icon: "arrow_outward", label: () => t`Arrow` },
    { id: "bar", icon: "stop", label: () => t`Black bar` },
    { id: "pixelate", icon: "blur_on", label: () => t`Pixelate` },
  ];

  const colorless = () => tool() === "bar" || tool() === "pixelate";

  return (
    <Layout onClick={(event) => event.stopPropagation()}>
      <Toolbar>
        <Group>
          <For each={tools}>
            {(entry) => (
              <ToolButton
                type="button"
                title={entry.label()}
                aria-label={entry.label()}
                active={tool() === entry.id}
                onClick={() => setTool(entry.id)}
              >
                <Symbol>{entry.icon}</Symbol>
              </ToolButton>
            )}
          </For>
          <Show when={crop()}>
            <ToolButton
              type="button"
              title={t`Reset crop`}
              aria-label={t`Reset crop`}
              onClick={() => {
                setCrop(null);
                redraw();
              }}
            >
              <Symbol>crop_free</Symbol>
            </ToolButton>
          </Show>
        </Group>
        <Group>
          <Show when={!colorless()}>
            <For each={COLORS}>
              {(entry) => (
                <Swatch
                  type="button"
                  active={color() === entry}
                  style={{ background: entry }}
                  onClick={() => setColor(entry)}
                />
              )}
            </For>
            <For each={WIDTHS}>
              {(entry) => (
                <ToolButton
                  type="button"
                  active={width() === entry}
                  onClick={() => setWidth(entry)}
                >
                  <Dot
                    style={{
                      width: `${entry + 4}px`,
                      height: `${entry + 4}px`,
                    }}
                  />
                </ToolButton>
              )}
            </For>
          </Show>
        </Group>
        <Group>
          <ToolButton
            type="button"
            title={t`Undo`}
            aria-label={t`Undo`}
            onClick={undo}
          >
            <Symbol>undo</Symbol>
          </ToolButton>
          <ToolButton
            type="button"
            title={t`Redo`}
            aria-label={t`Redo`}
            onClick={redo}
          >
            <Symbol>redo</Symbol>
          </ToolButton>
          <TextButton type="button" onClick={() => props.onCancel()}>
            {t`Cancel`}
          </TextButton>
          <TextButton type="button" accent onClick={() => apply()}>
            {t`Apply`}
          </TextButton>
        </Group>
      </Toolbar>
      <CanvasArea>
        <EditCanvas
          ref={canvas}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </CanvasArea>
    </Layout>
  );
}

const Layout = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minHeight: 0,
    gap: "var(--gap-md)",
    padding: "var(--gap-lg)",
  },
});

const Toolbar = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",

    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Group = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

const ToolButton = styled("button", {
  base: {
    display: "grid",
    placeItems: "center",
    minWidth: "36px",
    height: "36px",

    border: "none",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    color: "inherit",
    background: "transparent",
    transition: "var(--transitions-fast) background",

    "&:hover": {
      background: "var(--md-sys-color-surface-variant)",
    },
  },
  variants: {
    active: {
      true: {
        background: "var(--md-sys-color-primary-container)",
        color: "var(--md-sys-color-on-primary-container)",
      },
    },
  },
});

const Swatch = styled("button", {
  base: {
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    border: "2px solid var(--md-sys-color-outline)",
    cursor: "pointer",
    padding: 0,
  },
  variants: {
    active: {
      true: {
        border: "3px solid var(--md-sys-color-primary)",
      },
    },
  },
});

const Dot = styled("span", {
  base: {
    borderRadius: "50%",
    background: "currentColor",
  },
});

const TextButton = styled("button", {
  base: {
    padding: "0 var(--gap-lg)",
    height: "36px",

    border: "none",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    fontWeight: 600,
    color: "inherit",
    background: "transparent",

    "&:hover": {
      background: "var(--md-sys-color-surface-variant)",
    },
  },
  variants: {
    accent: {
      true: {
        background: "var(--md-sys-color-primary)",
        color: "var(--md-sys-color-on-primary)",

        "&:hover": {
          background: "var(--md-sys-color-primary)",
        },
      },
    },
  },
});

const CanvasArea = styled("div", {
  base: {
    display: "grid",
    placeItems: "center",
    flexGrow: 1,
    minHeight: 0,
  },
});

const EditCanvas = styled("canvas", {
  base: {
    maxWidth: "100%",
    maxHeight: "100%",
    touchAction: "none",
    cursor: "crosshair",
    borderRadius: "var(--gap-sm)",
    background: "rgba(0, 0, 0, 0.4)",
  },
});

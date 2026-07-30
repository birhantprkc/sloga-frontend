/**
 * Whether this engine can put an image on the clipboard at all.
 *
 * `ClipboardItem` is absent in insecure contexts and in older engines, so
 * callers gate their "Copy image" affordance on this rather than offering
 * an action that can only fail.
 */
export function canCopyImageToClipboard(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

/**
 * Re-encode an image as PNG.
 *
 * The bitmap comes from a Blob we fetched ourselves rather than from a
 * cross-origin <img>, so the canvas is never origin-tainted and toBlob is
 * safe to call.
 */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;

  const bitmap = await createImageBitmap(blob);

  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d canvas context available");
    context.drawImage(bitmap, 0, 0);

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) =>
          png
            ? resolve(png)
            : reject(new Error("PNG re-encode produced no blob")),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}

/**
 * Put the image at `url` on the system clipboard.
 *
 * `image/png` is the only image type every engine accepts on the async
 * clipboard, so anything else — JPEG, WebP, an animated GIF — is re-encoded
 * first. A GIF therefore lands as its first frame; that is the clipboard's
 * limit rather than something to work around here.
 *
 * The ClipboardItem is built from the *promise* instead of an awaited blob
 * on purpose: Safari rejects a write whose item was constructed after an
 * await had already consumed the user gesture. So call this synchronously
 * from the click handler and await the returned promise, don't await the
 * fetch yourself first.
 */
export async function copyImageToClipboard(url: string): Promise<void> {
  const png = fetch(url)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`image fetch failed with status ${response.status}`);
      }

      return response.blob();
    })
    .then(toPngBlob);

  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

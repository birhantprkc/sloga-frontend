/**
 * iOS Safari keyboard handling.
 *
 * `interactive-widget=resizes-content` in the viewport meta only works on
 * Chrome/Android. On iOS the keyboard OVERLAYS the page: the layout viewport
 * keeps its size, Safari scrolls it to reveal the focused input, and our
 * fixed #root gets dragged off-screen with a blank gap behind it.
 *
 * Fix: while the keyboard is up, mirror the visual viewport height into
 * `--ios-vvh` + stamp `data-ios-keyboard` on <html> (consumed by
 * components/ui/styles.css to shrink #root to the visible area), and pin the
 * layout viewport scroll back to 0 so fixed positioning stays anchored.
 *
 * iOS-gated: on Android the meta tag already resizes the layout viewport,
 * so this would fight it.
 */
export function mountIosViewportFix() {
  const vv = window.visualViewport;
  const isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ masquerades as macOS; touch support tells it apart
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
  if (!vv || !isIos) return;

  const doc = document.documentElement;

  function update() {
    // The layout viewport does not shrink on iOS, so a visual viewport
    // meaningfully shorter than the window can only be the keyboard.
    if (window.innerHeight - vv!.height > 80) {
      doc.style.setProperty("--ios-vvh", `${Math.round(vv!.height)}px`);
      doc.dataset.iosKeyboard = "1";
      // Undo Safari's chase-the-input scroll — with #root sized to the
      // visible area the input is on screen without it.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    } else if (doc.dataset.iosKeyboard) {
      delete doc.dataset.iosKeyboard;
      doc.style.removeProperty("--ios-vvh");
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    }
  }

  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
}

export default {
  /** Media query for phone layout breakpoint

   * The second clause catches phones held in LANDSCAPE: an iPhone at
   * 844×390 is wider than any width cutoff that still makes sense, but
   * three desktop panes in 390px of height are unusable — it needs the
   * drawer-based phone layout. `pointer: coarse` keeps short desktop
   * windows (which have height but a mouse) on the desktop layout. */
  phone: "(max-width: 600px), ((max-height: 500px) and (pointer: coarse))",

  /** Media query for tablet layout breakpoint */
  tablet: "(max-width: 840px), (max-height: 600px)",
};

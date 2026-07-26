/**
 * Print human-readable file size
 */
export function humanFileSize(size: number) {
  // Trim meaningless trailing zeros: "5.00 GB" -> "5 GB", "1.50 MB" -> "1.5 MB"
  const round = (value: number) =>
    value.toFixed(2).replace(/\.?0+$/, "");

  if (size >= 1e9) {
    return `${round(size / 1e9)} GB`;
  } else if (size >= 1e6) {
    return `${round(size / 1e6)} MB`;
  } else if (size >= 1e3) {
    return `${round(size / 1e3)} KB`;
  }

  return `${size} B`;
}

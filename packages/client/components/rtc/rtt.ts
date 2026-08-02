/**
 * Round-trip time to the SFU, in milliseconds, read off a PeerConnection
 * stats report.
 *
 * This exists because both call readouts — the in-app voice stats panel and
 * the in-game overlay — independently computed RTT from
 * `remote-inbound-rtp.roundTripTime`, and that is the wrong statistic.
 *
 * **`remote-inbound-rtp.roundTripTime` is derived from RTCP receiver
 * reports.** On an audio-only call those arrive rarely, so the figure is
 * stale between reports and can be wildly wrong while the call itself is
 * perfectly healthy — measured live on 2026-08-01 as *thousands* of
 * milliseconds on a call that sounded fine. It is not the number a user means
 * by "latency", and showing it next to a voice roster invites exactly the
 * conclusion that the call is broken when it is not.
 *
 * `candidate-pair.currentRoundTripTime` is the ICE-level RTT, measured by
 * STUN connectivity checks about once a second. It is what every other client
 * shows as ping, and it is the one that lands in the tens of milliseconds.
 *
 * Selection order is load-bearing rather than defensive: a report can carry
 * several candidate pairs and the losers' RTTs are meaningless, so the
 * transport's own `selectedCandidatePairId` is consulted first (it is
 * authoritative), a nominated succeeded pair second, and the old RTCP figure
 * only as a last resort — better a poor number than a blank readout on a
 * browser that reports no candidate-pair RTT at all.
 *
 * Returns undefined when nothing usable is present; callers render "—".
 */

type MaybeStats = {
  type?: string;
  id?: string;
  selectedCandidatePairId?: string;
  currentRoundTripTime?: number;
  roundTripTime?: number;
  nominated?: boolean;
  state?: string;
};

export function readRttMs(
  reports: RTCStatsReport | undefined,
): number | undefined {
  if (!reports) return undefined;

  let selectedPairId: string | undefined;
  const pairs = new Map<string, MaybeStats>();
  /** `remote-inbound-rtp.roundTripTime`, in seconds. Last resort only. */
  let rtcpSeconds: number | undefined;

  reports.forEach((report) => {
    const entry = report as MaybeStats;
    if (entry.type === "transport") {
      if (typeof entry.selectedCandidatePairId === "string") {
        selectedPairId = entry.selectedCandidatePairId;
      }
    } else if (entry.type === "candidate-pair") {
      if (typeof entry.id === "string") pairs.set(entry.id, entry);
    } else if (
      entry.type === "remote-inbound-rtp" &&
      typeof entry.roundTripTime === "number"
    ) {
      rtcpSeconds = entry.roundTripTime;
    }
  });

  const rttOf = (pair: MaybeStats | undefined) =>
    typeof pair?.currentRoundTripTime === "number"
      ? pair.currentRoundTripTime
      : undefined;

  const seconds =
    rttOf(selectedPairId ? pairs.get(selectedPairId) : undefined) ??
    rttOf(
      [...pairs.values()].find(
        (pair) => pair.state === "succeeded" && pair.nominated === true,
      ),
    ) ??
    rtcpSeconds;

  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}

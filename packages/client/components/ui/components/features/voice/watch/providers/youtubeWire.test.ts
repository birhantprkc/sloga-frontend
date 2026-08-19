// Unit spec for the YouTube postMessage wire helpers — Node's built-in runner:
//   node --test components/ui/components/features/voice/watch/providers/youtubeWire.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commandMessage,
  listeningMessage,
  parseYouTubeInput,
  parseYouTubeMessage,
  providerStateFromYt,
  youtubeEmbedUrl,
  youtubeErrorText,
} from "./youtubeWire.ts";

test("parseYouTubeInput: every paste shape a user produces", () => {
  const id = "YE7VzlLtp-4";
  for (const s of [
    id,
    `  ${id}  `,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?feature=share&v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc`,
    `youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://music.youtube.com/watch?v=${id}`,
  ]) {
    assert.equal(parseYouTubeInput(s), id, s);
  }
  for (const s of ["", "not a url", "https://vimeo.com/12345", "https://youtube.com/watch?v=short", "https://evil.com/watch?v=" + id, "youtube.com/channel/UC123"]) {
    assert.equal(parseYouTubeInput(s), null, s);
  }
});

test("embed url: nocookie host, jsapi, origin, viewer defaults", () => {
  const u = new URL(youtubeEmbedUrl({ videoId: "YE7VzlLtp-4", origin: "https://app.sloga.gg" }));
  assert.equal(u.origin, "https://www.youtube-nocookie.com");
  assert.equal(u.pathname, "/embed/YE7VzlLtp-4");
  assert.equal(u.searchParams.get("enablejsapi"), "1");
  assert.equal(u.searchParams.get("origin"), "https://app.sloga.gg");
  assert.equal(u.searchParams.get("autoplay"), "1");
  assert.equal(u.searchParams.get("controls"), "0");
  assert.equal(u.searchParams.get("playsinline"), "1");
  assert.equal(u.searchParams.get("mute"), null);
  const muted = new URL(youtubeEmbedUrl({ videoId: "YE7VzlLtp-4", origin: "o", mute: true, controls: true }));
  assert.equal(muted.searchParams.get("mute"), "1");
  assert.equal(muted.searchParams.get("controls"), "1");
});

test("outbound messages carry id + channel for cross-talk filtering", () => {
  assert.deepEqual(JSON.parse(listeningMessage("w1")), { event: "listening", id: "w1", channel: "widget" });
  assert.deepEqual(JSON.parse(commandMessage("w1", "seekTo", [120, true])), {
    event: "command",
    func: "seekTo",
    args: [120, true],
    id: "w1",
    channel: "widget",
  });
});

test("parseYouTubeMessage: partial infoDelivery merges only present fields, seconds→ms", () => {
  const r = parseYouTubeMessage(
    JSON.stringify({ event: "infoDelivery", id: "w1", info: { currentTime: 5.25, playbackRate: 1 } }),
    "w1",
  );
  assert.deepEqual(r, { kind: "info", info: { currentTimeMs: 5250, playbackRate: 1 } });
  const full = parseYouTubeMessage(
    { event: "infoDelivery", id: "w1", info: { playerState: 1, duration: 596.5, muted: false, volume: 100, videoData: { title: "Big Buck Bunny" } } },
    "w1",
  );
  assert.deepEqual(full, {
    kind: "info",
    info: { playerState: 1, durationMs: 596500, muted: false, volume: 100, title: "Big Buck Bunny" },
  });
});

test("parseYouTubeMessage: ready / error / other-embed / unknown / garbage", () => {
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "onReady", id: "w1" }), "w1"), { kind: "ready" });
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "onError", id: "w1", info: 150 }), "w1"), { kind: "error", code: 150 });
  // Another embed's id (the chat message embed) → ignored.
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "infoDelivery", id: "other", info: { currentTime: 1 } }), "w1"), { kind: "ignore" });
  // apiInfoDelivery / initialDelivery / future events → ignored, never thrown.
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "apiInfoDelivery", id: "w1", info: { captions: {} } }), "w1"), { kind: "ignore" });
  assert.deepEqual(parseYouTubeMessage(JSON.stringify({ event: "initialDelivery", id: "w1" }), "w1"), { kind: "ignore" });
  assert.deepEqual(parseYouTubeMessage("not json", "w1"), { kind: "ignore" });
  assert.deepEqual(parseYouTubeMessage(42, "w1"), { kind: "ignore" });
  assert.deepEqual(parseYouTubeMessage(null, "w1"), { kind: "ignore" });
});

test("state map + error text", () => {
  assert.equal(providerStateFromYt(1), "playing");
  assert.equal(providerStateFromYt(2), "paused");
  assert.equal(providerStateFromYt(3), "buffering");
  assert.equal(providerStateFromYt(5), "cued");
  assert.equal(providerStateFromYt(-1), "unstarted");
  assert.equal(providerStateFromYt(0), "ended");
  assert.equal(providerStateFromYt(undefined), null);
  assert.equal(providerStateFromYt(99), null);
  assert.match(youtubeErrorText(150), /disabled embedding/);
  assert.match(youtubeErrorText(101), /disabled embedding/);
  assert.match(youtubeErrorText(100), /not found/);
});

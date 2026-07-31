// Specs for the model asset route — run with Node's built-in runner:
//   node --conditions=browser --test models.plugin.test.ts
//
// This handler serves a directory that sits OUTSIDE the repository, from a
// route reachable by anything that can talk to the dev or preview server. The
// containment check is the whole security story, so it is tested against the
// encodings an attacker would actually reach for rather than just `../`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import modelsPlugin from "./models.plugin.ts";

const root = join(tmpdir(), `sloga-models-spec-${process.pid}`);
mkdirSync(join(root, "whisper-tiny", "onnx"), { recursive: true });
writeFileSync(join(root, "whisper-tiny", "config.json"), '{"ok":true}');
writeFileSync(join(root, "whisper-tiny", "onnx", "encoder.onnx"), "MODEL");
// The file the traversal attempts are reaching for, one level above the root.
writeFileSync(join(tmpdir(), `sloga-secret-${process.pid}.txt`), "SECRET");

process.env.SLOGA_MODELS_DIR = root;

/** Drive the plugin's middleware with a fake request. */
function request(url: string, method = "GET") {
  const plugin = modelsPlugin();
  let handler: (req: unknown, res: unknown, next: () => void) => void;
  (plugin as { configureServer: (s: unknown) => void }).configureServer({
    middlewares: { use: (fn: typeof handler) => (handler = fn) },
  });

  return new Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    passed: boolean;
  }>((resolve) => {
    const headers: Record<string, string> = {};
    let body = "";
    const res = {
      statusCode: 200,
      setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
      end: (chunk?: string) => {
        if (chunk) body += chunk;
        resolve({ status: res.statusCode, headers, body, passed: false });
      },
      // createReadStream(...).pipe(res) drives these.
      on: () => res,
      once: () => res,
      emit: () => true,
      write: (chunk: Buffer | string) => {
        body += chunk.toString();
        return true;
      },
      writeHead: (code: number) => {
        res.statusCode = code;
        return res;
      },
      destroy: () => undefined,
    };
    handler!({ url, method }, res, () =>
      resolve({ status: 0, headers, body: "", passed: true }),
    );
  });
}

test("serves a vendored model file with the right content type", async () => {
  const res = await request("/models/whisper-tiny/config.json");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/json/);
  assert.match(res.headers["cache-control"], /immutable/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});

test("serves wasm as wasm, or the browser refuses to stream-compile it", async () => {
  writeFileSync(join(root, "runtime.wasm"), "\0asm");
  const res = await request("/models/runtime.wasm");
  assert.equal(res.headers["content-type"], "application/wasm");
});

test("leaves every other route alone", async () => {
  for (const url of ["/", "/index.html", "/api/models", "/modelsfoo"]) {
    const res = await request(url);
    assert.equal(res.passed, true, `${url} should fall through`);
  }
});

test("refuses to escape the models directory", async () => {
  const escapes = [
    `/models/../sloga-secret-${process.pid}.txt`,
    `/models/whisper-tiny/../../sloga-secret-${process.pid}.txt`,
    // Percent-encoded, which a check running before decoding would miss.
    `/models/%2e%2e/sloga-secret-${process.pid}.txt`,
    `/models/..%2Fsloga-secret-${process.pid}.txt`,
  ];

  for (const url of escapes) {
    const res = await request(url);
    assert.notEqual(res.body, "SECRET", `${url} escaped the root`);
    assert.ok(
      res.status === 403 || res.status === 404,
      `${url} should be refused, got ${res.status}`,
    );
  }
});

test("a sibling directory with the same prefix is not reachable", async () => {
  // `/models-private` resolves next to the root; a naive startsWith check on
  // the path string would let it through.
  const res = await request(`/models/../sloga-models-spec-${process.pid}-x/f`);
  assert.notEqual(res.status, 200);
});

test("a missing file is a 404, not a crash", async () => {
  const res = await request("/models/whisper-tiny/nope.onnx");
  assert.equal(res.status, 404);
});

test("malformed percent-encoding is rejected rather than thrown", async () => {
  const res = await request("/models/%E0%A4%A");
  assert.equal(res.status, 400);
});

test("a query string does not defeat the lookup", async () => {
  const res = await request("/models/whisper-tiny/config.json?v=2");
  assert.equal(res.status, 200);
});

test("HEAD returns the headers without the body", async () => {
  const res = await request("/models/whisper-tiny/config.json", "HEAD");
  assert.equal(res.status, 200);
  assert.equal(res.body, "");
  assert.ok(Number(res.headers["content-length"]) > 0);
});

test("a directory is not served as a file", async () => {
  const res = await request("/models/whisper-tiny");
  assert.equal(res.status, 404);
});

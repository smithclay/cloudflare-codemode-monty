/**
 * Real Cloudflare Worker check: boots `wrangler dev` against
 * examples/cloudflare-worker and drives Python through the deployed bundle.
 *
 * Kept out of `npm test` (it needs wrangler and takes ~30s). Run it with
 * `npm run test:worker`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const cwd = fileURLToPath(new URL("../examples/cloudflare-worker", import.meta.url));
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;

let dev;
let devOutput = "";

async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`, { method: "POST", body: "1" });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev did not become ready:\n${devOutput}`);
}

async function run(code) {
  const res = await fetch(`${BASE}/`, { method: "POST", body: code });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  dev = spawn(process.execPath, [wrangler, "dev", "--port", String(PORT), "--local"], {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  dev.stdout.on("data", (chunk) => (devOutput += chunk));
  dev.stderr.on("data", (chunk) => (devOutput += chunk));
  await waitForReady();
});

test.after(() => {
  if (!dev?.pid || dev.exitCode !== null || dev.signalCode !== null) return;
  if (process.platform === "win32") dev.kill("SIGTERM");
  else process.kill(-dev.pid, "SIGTERM");
});

test("runs pure Python in a Worker", async () => {
  assert.deepEqual(await run("1 + 2"), { status: 200, body: { ok: true, result: 3 } });
});

test("calls an async host tool from Python in a Worker", async () => {
  const { body } = await run('await codemode.getWeather({"location": "London"})');
  assert.equal(body.ok, true);
  assert.deepEqual(body.result, { location: "London", temperature: 72, conditions: "sunny" });
});

test("runs the two-tool demo program with logs", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.weather.temperature, 72);
  assert.deepEqual(body.result.notified, { sent: true, message: "Nice weather in San Francisco" });
  assert.deepEqual(body.logs, ["temperature was 72"]);
});

test("surfaces a Python traceback in a Worker", async () => {
  const { status, body } = await run('raise ValueError("boom")');
  assert.equal(status, 400);
  assert.match(body.error, /ValueError: boom/);
});

test("reuses one pool across requests", async () => {
  const results = await Promise.all([run("1"), run("2"), run("3")]);
  assert.deepEqual(
    results.map((r) => r.body.result),
    [1, 2, 3],
  );
});

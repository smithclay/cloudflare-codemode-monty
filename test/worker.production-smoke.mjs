/**
 * Deploy the Worker example to a temporary Cloudflare account and exercise it
 * over the public edge. This is intentionally opt-in: it creates a temporary
 * Worker and requires network access.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const workerDir = fileURLToPath(new URL("../examples/cloudflare-worker", import.meta.url));
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const claimUrl = /https:\/\/dash\.cloudflare\.com\/claim-preview\?[^\s]+/g;
const workerUrl = /https:\/\/[^\s]+\.workers\.dev\b/i;

function redact(output) {
  return output.replace(claimUrl, "[redacted claim URL]");
}

function deploy(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, "deploy", "--temporary"], {
      cwd: workerDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`wrangler deploy failed:\n${redact(output)}`));
    });
  });
}

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON from ${url}, got HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function waitForReady(url) {
  const deadline = Date.now() + 60_000;
  let error;
  while (Date.now() < deadline) {
    try {
      return await request(url);
    } catch (cause) {
      error = cause;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`Worker did not become ready: ${error?.message ?? "unknown error"}`);
}

const configDir = await mkdtemp(`${tmpdir()}/codemode-monty-wrangler-`);
const env = { ...process.env, XDG_CONFIG_HOME: configDir };
for (const name of [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AUTH_USE_KEYRING",
]) {
  delete env[name];
}

try {
  const output = await deploy(env);
  const url = output.match(workerUrl)?.[0];
  assert.ok(url, `Wrangler did not print a workers.dev URL:\n${redact(output)}`);

  const demo = await waitForReady(url);
  assert.deepEqual(demo, {
    ok: true,
    result: {
      weather: { location: "San Francisco", temperature: 72, conditions: "sunny" },
      notified: { sent: true, message: "Nice weather in San Francisco" },
    },
    logs: ["temperature was 72"],
  });

  const custom = await request(url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: 'await codemode.getWeather({"location": "Lisbon"})',
  });
  assert.deepEqual(custom, {
    ok: true,
    result: { location: "Lisbon", temperature: 72, conditions: "sunny" },
  });

  console.log(`Production smoke test passed: ${url}`);
} finally {
  await rm(configDir, { recursive: true, force: true });
}

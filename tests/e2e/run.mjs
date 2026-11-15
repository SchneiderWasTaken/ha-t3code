// End-to-end test: T3 Code (from source, with our patches) behind the gateway
// behind a fake Home Assistant Ingress, driven by a real browser.
//
//   T3_SRC=<t3code checkout with server deps installed> \
//   WEB_ROOT=<output of build-web.sh> \
//   node tests/e2e/run.mjs
//
// This is the check that tells us an upstream T3 Code release broke the
// add-on, so keep it strict and don't relax it to make a bump pass.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const T3_SRC = required("T3_SRC");
const WEB_ROOT = required("WEB_ROOT");
const INGRESS_PORT = 18123;
const GATEWAY_PORT = 18099;
const PREFIX = "/api/hassio_ingress/E2ETOKEN";
const USER = { "x-remote-user-id": "e2eadmin", "x-remote-user-name": "e2e", "x-remote-user-display-name": "E2E Admin" };
const WORKSPACE_TITLE = "E2E Workspace";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return path.resolve(v);
}

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

// --- Fake Supervisor Ingress ------------------------------------------------
function startFakeIngress() {
  const strip = (u) => (u.startsWith(PREFIX) ? u.slice(PREFIX.length) || "/" : null);
  const headersFor = (req) => ({ ...req.headers, ...USER, "x-ingress-path": PREFIX });
  const srv = http.createServer((req, res) => {
    const p = strip(req.url);
    if (p === null) {
      res.writeHead(404);
      return res.end(`not ingress: ${req.url}`);
    }
    const up = http.request(
      { host: "127.0.0.1", port: GATEWAY_PORT, path: p, method: req.method, headers: headersFor(req) },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  srv.on("upgrade", (req, sock, head) => {
    const p = strip(req.url);
    if (p === null) return sock.destroy();
    const up = net.connect(GATEWAY_PORT, "127.0.0.1", () => {
      let raw = `${req.method} ${p} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headersFor(req))) raw += `${k}: ${v}\r\n`;
      up.write(raw + "\r\n");
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  return new Promise((r) => srv.listen(INGRESS_PORT, "127.0.0.1", () => r(srv)));
}

// --- Gateway ----------------------------------------------------------------
function startGateway(tmp) {
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "configuration.yaml"), "homeassistant:\n");
  const proc = spawn(process.execPath, [path.join(repo, "t3code/gateway/server.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: path.join(tmp, "home"),
      T3CODE_TELEMETRY_ENABLED: "false",
      GATEWAY_PORT: String(GATEWAY_PORT),
      GATEWAY_TRUSTED_PROXY: "",
      GATEWAY_DATA_DIR: path.join(tmp, "data"),
      GATEWAY_WEB_ROOT: WEB_ROOT,
      GATEWAY_T3_COMMAND: `${process.execPath} ${path.join(T3_SRC, "apps/server/src/bin.ts")}`,
      GATEWAY_WORKSPACE: workspace,
      GATEWAY_WORKSPACE_TITLE: WORKSPACE_TITLE,
      GATEWAY_DEV_ADMIN_IDS: USER["x-remote-user-id"],
      GATEWAY_FIRST_INSTANCE_PORT: "18801",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logFile = path.join(tmp, "gateway.log");
  const out = fs.createWriteStream(logFile);
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  return { proc, logFile };
}

async function waitFor(fn, what, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// --- Test -------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ha-t3code-e2e-"));
const ingress = await startFakeIngress();
const gateway = startGateway(tmp);
const base = `http://127.0.0.1:${INGRESS_PORT}${PREFIX}`;
let browser;

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, { headers: USER })).ok, "gateway");

  // First API call starts the user's T3 server and signs in.
  const session = await (await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(180_000) })).json();
  check(session.authenticated === true, "API call through Ingress is authenticated without pairing");

  const index = await (await fetch(`${base}/`)).text();
  check(index.includes("__HA_INGRESS_PATH__"), "index.html has the Ingress shim injected");
  check(/src="\.\/assets\//.test(index), "index.html uses relative asset paths");

  const direct = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/auth/session`);
  check(direct.status === 401, "request without Home Assistant user headers is refused");

  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const problems = [];
  const sockets = [];
  page.on("console", (m) => m.type() === "error" && problems.push(`console error: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message.slice(0, 300)}`));
  page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on("response", (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
  page.on("websocket", (ws) => sockets.push(ws.url()));

  await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(5000);
  const body = await page.locator("body").innerText();
  check(!/pairing token/i.test(body), "no pairing screen");
  check(/T3 Code/i.test(await page.title()), "app loaded (title)");
  check(sockets.some((u) => u.includes(`${PREFIX}/ws`)), "WebSocket goes through the Ingress path");
  check(!sockets.some((u) => new URL(u).pathname.startsWith("/ws")), "no WebSocket escapes the Ingress path");

  await page.goto(`${base}/#/settings/projects`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  check((await page.locator("body").innerText()).includes(WORKSPACE_TITLE), "workspace was added as a project");

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  check(page.url().includes("#/settings/projects"), "hash route survives a reload");
  check(!/pairing token/i.test(await page.locator("body").innerText()), "still signed in after reload");

  await page.screenshot({ path: path.join(tmp, "e2e.png") });
  check(problems.length === 0, `no console errors or failed requests${problems.length ? ":\n  " + problems.join("\n  ") : ""}`);
} catch (err) {
  check(false, `test crashed: ${err.stack ?? err.message}`);
} finally {
  await browser?.close();
  gateway.proc.kill("SIGTERM");
  ingress.close();
  if (failures.length) {
    console.log(`\n--- gateway log (${gateway.logFile}) ---`);
    console.log(fs.readFileSync(gateway.logFile, "utf8").split("\n").filter((l) => !/^\[t3:[^\]]*\]\s+'\d+_/.test(l)).slice(-80).join("\n"));
  }
  console.log(`\nArtifacts: ${tmp}`);
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll checks passed");
  process.exit(failures.length ? 1 : 0);
}

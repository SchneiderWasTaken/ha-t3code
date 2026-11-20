// ha-t3code gateway
//
// Sits between Home Assistant Ingress and T3 Code:
//   * Home Assistant has already authenticated the request; the Supervisor
//     tells us who the user is (X-Remote-User-*).
//   * Each Home Assistant user gets their own T3 Code server (own threads,
//     settings and history), started on demand.
//   * The gateway signs in to that server on the user's behalf and attaches
//     the session cookie itself, so the browser never sees a pairing screen
//     and never holds T3 credentials.
//   * It serves T3's web app (built for a sub-path) and rewrites T3's API and
//     WebSocket calls into the Ingress path with a small injected script.
//
// Node >= 22, no dependencies.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration (set by the s6 run script)
// ---------------------------------------------------------------------------
const env = process.env;
const CONFIG = {
  port: Number(env.GATEWAY_PORT ?? 8099),
  // Ingress traffic only ever comes from the Supervisor. Empty = no check (dev).
  trustedProxy: env.GATEWAY_TRUSTED_PROXY ?? "172.30.32.2",
  dataDir: env.GATEWAY_DATA_DIR ?? "/data",
  webRoot: env.GATEWAY_WEB_ROOT ?? "/opt/t3code-web",
  t3Command: (env.GATEWAY_T3_COMMAND ?? "t3").split(" ").filter(Boolean),
  workspace: env.GATEWAY_WORKSPACE ?? "/homeassistant",
  workspaceTitle: env.GATEWAY_WORKSPACE_TITLE ?? "Home Assistant",
  firstInstancePort: Number(env.GATEWAY_FIRST_INSTANCE_PORT ?? 3801),
  // Optional direct port (phone apps, Tailscale) forwarded to one user's server.
  directPort: Number(env.GATEWAY_DIRECT_PORT ?? 0),
  directUser: env.GATEWAY_DIRECT_USER ?? "",
  // Comma-separated user ids treated as admins without asking HA (dev only).
  devAdminIds: (env.GATEWAY_DEV_ADMIN_IDS ?? "").split(",").filter(Boolean),
  supervisorToken: env.SUPERVISOR_TOKEN ?? "",
  coreWsUrl: env.GATEWAY_CORE_WS_URL ?? "ws://supervisor/core/websocket",
};

const log = (...args) => console.log("[gateway]", ...args);
const warn = (...args) => console.warn("[gateway]", ...args);

// Paths T3's server owns. Everything else is the web app.
const T3_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws", "/mcp", "/attachments"];
const isT3Path = (p) => T3_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/") || p.startsWith(pre + "?"));

// ---------------------------------------------------------------------------
// Home Assistant users
// ---------------------------------------------------------------------------
let usersCache = { at: 0, byId: new Map() };

async function fetchHaUsers() {
  if (Date.now() - usersCache.at < 60_000) return usersCache.byId;
  const ws = new WebSocket(CONFIG.coreWsUrl);
  const byId = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out talking to Home Assistant"));
    }, 10_000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: CONFIG.supervisorToken }));
      } else if (msg.type === "auth_ok") {
        ws.send(JSON.stringify({ id: 1, type: "config/auth/list" }));
      } else if (msg.type === "auth_invalid") {
        clearTimeout(timer);
        reject(new Error("Home Assistant rejected the Supervisor token"));
      } else if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (!msg.success) return reject(new Error(msg.error?.message ?? "config/auth/list failed"));
        resolve(new Map(msg.result.map((u) => [u.id, u])));
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not reach Home Assistant"));
    });
  });
  usersCache = { at: Date.now(), byId };
  return byId;
}

async function isAdmin(userId) {
  if (CONFIG.devAdminIds.includes(userId)) return true;
  const user = (await fetchHaUsers()).get(userId);
  return Boolean(user?.group_ids?.includes("system-admin") || user?.is_owner);
}

function requestUser(req) {
  const id = req.headers["x-remote-user-id"];
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return {
    id,
    name: req.headers["x-remote-user-name"] || id,
    displayName: req.headers["x-remote-user-display-name"] || req.headers["x-remote-user-name"] || id,
  };
}

// ---------------------------------------------------------------------------
// Per-user T3 Code servers
// ---------------------------------------------------------------------------
const usersDir = path.join(CONFIG.dataDir, "users");
const portsFile = path.join(usersDir, "ports.json");
const instances = new Map(); // userId -> Instance

function loadPorts() {
  try {
    return JSON.parse(fs.readFileSync(portsFile, "utf8"));
  } catch {
    return {};
  }
}

function portFor(userId) {
  const ports = loadPorts();
  if (ports[userId]) return ports[userId];
  const used = new Set(Object.values(ports));
  let port = CONFIG.firstInstancePort;
  while (used.has(port)) port++;
  ports[userId] = port;
  fs.mkdirSync(usersDir, { recursive: true });
  fs.writeFileSync(portsFile, JSON.stringify(ports, null, 2));
  return port;
}

class Instance {
  constructor(user) {
    this.user = user;
    this.port = portFor(user.id);
    this.dir = path.join(usersDir, user.id);
    this.t3Home = path.join(this.dir, "t3");
    this.sessionFile = path.join(this.dir, "session.json");
    this.proc = null;
    this.ready = null;
    this.session = null;
    this.sessionPending = null;
    this.restarts = 0;
    fs.mkdirSync(this.t3Home, { recursive: true, mode: 0o700 });
    try {
      this.session = JSON.parse(fs.readFileSync(this.sessionFile, "utf8"));
    } catch {}
  }

  get env() {
    return { ...process.env, T3CODE_HOME: this.t3Home };
  }

  start() {
    if (this.ready) return this.ready;
    log(`starting T3 Code for ${this.user.name} on 127.0.0.1:${this.port}`);
    const [cmd, ...pre] = CONFIG.t3Command;
    this.proc = spawn(
      cmd,
      // `serve` never bootstraps a project (ensureWorkspaceProject does it),
      // and since T3 Code 0.1.10 it rejects --auto-bootstrap-project-from-cwd.
      [...pre, "serve", "--mode", "web", "--host", "127.0.0.1", "--port", String(this.port),
        "--no-browser"],
      { cwd: CONFIG.workspace, env: this.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const prefix = `[t3:${this.user.name}] `;
    for (const stream of [this.proc.stdout, this.proc.stderr]) {
      let buf = "";
      stream.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          // T3 prints a QR code on start; it's noise in the add-on log.
          // Drop the startup QR code and pairing secrets: the gateway signs in
          // for the user, so nobody needs them, and the log is readable by admins.
          if (line.trim() && !/[█▀▄]/.test(line) && !/^\s*(Token|Pairing URL|App link):/.test(line)) {
            process.stdout.write(prefix + line + "\n");
          }
        }
      });
    }
    this.proc.on("exit", (code, signal) => {
      warn(`T3 Code for ${this.user.name} exited (code ${code}, signal ${signal})`);
      this.proc = null;
      this.ready = null;
      if (shuttingDown) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.restarts++);
      setTimeout(() => this.start().catch((e) => warn(e.message)), delay);
    });
    this.ready = this.waitForHttp().then(async () => {
      this.restarts = 0;
      log(`T3 Code for ${this.user.name} is up`);
      await this.ensureWorkspaceProject();
    });
    return this.ready;
  }

  async waitForHttp() {
    for (let i = 0; i < 120; i++) {
      if (!this.proc) throw new Error(`T3 Code for ${this.user.name} exited during startup`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/.well-known/t3/environment`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`T3 Code for ${this.user.name} did not start within 60s`);
  }

  // `t3 serve` is headless, which skips creating a project for its working
  // directory, so add the workspace once ourselves.
  async ensureWorkspaceProject() {
    const marker = path.join(this.dir, "project-added");
    if (fs.existsSync(marker)) return;
    const [cmd, ...pre] = CONFIG.t3Command;
    try {
      await execFileAsync(cmd, [...pre, "project", "add", CONFIG.workspace, "--title", CONFIG.workspaceTitle],
        { env: this.env, timeout: 60_000 });
      log(`added ${CONFIG.workspace} as a project for ${this.user.name}`);
    } catch (err) {
      warn(`could not add ${CONFIG.workspace} as a project: ${(err.stderr || err.message).trim().split("\n").pop()}`);
    }
    fs.writeFileSync(marker, new Date().toISOString());
  }

  // Signs in to this user's T3 server: mint a one-time pairing token with the
  // CLI, exchange it for a browser session, and keep the cookie server-side.
  async ensureSession() {
    if (this.session && this.session.port === this.port && this.session.expiresAt > Date.now() + 3600_000) {
      return this.session;
    }
    this.sessionPending ??= this.createSession().finally(() => (this.sessionPending = null));
    return this.sessionPending;
  }

  async createSession() {
    const [cmd, ...pre] = CONFIG.t3Command;
    const { stdout } = await execFileAsync(
      cmd,
      [...pre, "pair", "--label", `Home Assistant: ${this.user.displayName}`],
      { env: this.env, timeout: 60_000 },
    );
    const token = /^Token:\s*(\S+)/m.exec(stdout)?.[1] ?? /#token=([^\s&]+)/.exec(stdout)?.[1];
    if (!token) throw new Error("t3 pair printed no token");

    const res = await fetch(`http://127.0.0.1:${this.port}/api/auth/browser-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: token }),
    });
    if (!res.ok) throw new Error(`browser-session returned HTTP ${res.status}`);
    const cookie = parseSessionCookie(res.headers.getSetCookie());
    if (!cookie) throw new Error("browser-session set no session cookie");
    this.saveSession({ ...cookie, port: this.port });
    log(`signed in to T3 Code for ${this.user.name}`);
    return this.session;
  }

  saveSession(session) {
    this.session = session;
    fs.writeFileSync(this.sessionFile, JSON.stringify(session), { mode: 0o600 });
  }

  // T3 may rotate the cookie in a response; keep ours current.
  absorbSetCookie(setCookies) {
    const cookie = parseSessionCookie(setCookies);
    if (cookie && cookie.value) this.saveSession({ ...cookie, port: this.port });
  }

  stop() {
    this.proc?.kill("SIGTERM");
  }
}

function parseSessionCookie(setCookies = []) {
  for (const header of setCookies) {
    const [pair, ...attrs] = header.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    if (!name.startsWith("t3_session")) continue;
    const value = pair.slice(eq + 1);
    const expires = attrs.find((a) => a.toLowerCase().startsWith("expires="));
    const expiresAt = expires ? Date.parse(expires.slice(8)) : Date.now() + 7 * 86400_000;
    return { name, value, expiresAt };
  }
  return null;
}

function instanceFor(user) {
  let inst = instances.get(user.id);
  if (!inst) {
    inst = new Instance(user);
    instances.set(user.id, inst);
  }
  inst.user = user; // display name may change
  return inst;
}

// ---------------------------------------------------------------------------
// Web app (served from our sub-path build) with the Ingress shim injected
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm",
  ".map": "application/json", ".txt": "text/plain; charset=utf-8",
};

const shimSource = fs.readFileSync(new URL("./ingress-shim.js", import.meta.url), "utf8");
let indexTemplate = null;

function renderIndex(ingressPath) {
  indexTemplate ??= fs.readFileSync(path.join(CONFIG.webRoot, "index.html"), "utf8");
  const shim = `<script>window.__HA_INGRESS_PATH__=${JSON.stringify(ingressPath)};\n${shimSource}</script>`;
  return indexTemplate.replace(/<head([^>]*)>/i, (m) => `${m}\n${shim}`);
}

async function serveStatic(req, res, pathname, ingressPath) {
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    return res.end(renderIndex(ingressPath));
  }
  const file = path.normalize(path.join(CONFIG.webRoot, decodeURIComponent(pathname)));
  if (!file.startsWith(CONFIG.webRoot + path.sep)) return sendText(res, 403, "Forbidden");
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "content-length": stat.size,
      // Vite's hashed assets never change.
      "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  } catch {
    // Routes live in the hash, so anything else is simply missing.
    sendText(res, 404, "Not found");
  }
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendPage(res, status, title, body) {
  res.writeHead(status, { "content-type": MIME[".html"], "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#222}
@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style><h1>${title}</h1>${body}`);
}

// ---------------------------------------------------------------------------
// Proxying to a user's T3 server
// ---------------------------------------------------------------------------
const HOP_HEADERS = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"];

function upstreamHeaders(req, inst, session) {
  const headers = { ...req.headers };
  for (const h of HOP_HEADERS) delete headers[h];
  for (const h of Object.keys(headers)) {
    if (h.startsWith("x-remote-user") || h.startsWith("x-ingress") || h.startsWith("x-forwarded") || h.startsWith("x-hass")) {
      delete headers[h];
    }
  }
  // Present as a same-origin local client: the gateway already authenticated
  // the user, and T3 shouldn't see (or trust) Home Assistant's origin.
  const origin = `http://127.0.0.1:${inst.port}`;
  headers.host = `127.0.0.1:${inst.port}`;
  if (headers.origin) headers.origin = origin;
  if (headers.referer) headers.referer = origin + "/";
  headers.cookie = `${session.name}=${session.value}`; // never forward HA's cookies
  return headers;
}

function proxyHttp(req, res, inst, session, upstreamPath) {
  const upstream = http.request(
    { host: "127.0.0.1", port: inst.port, method: req.method, path: upstreamPath, headers: upstreamHeaders(req, inst, session) },
    (up) => {
      const headers = { ...up.headers };
      if (headers["set-cookie"]) {
        inst.absorbSetCookie(headers["set-cookie"]);
        delete headers["set-cookie"];
      }
      if (up.statusCode === 401) inst.session = null; // re-sign-in on next request
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    warn(`proxy error for ${inst.user.name}: ${err.message}`);
    if (!res.headersSent) sendText(res, 502, "T3 Code is not responding");
    else res.destroy();
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, inst, session, upstreamPath) {
  const headers = upstreamHeaders(req, inst, session);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade;
  const upstream = net.connect(inst.port, "127.0.0.1", () => {
    let raw = `${req.method} ${upstreamPath} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const value of Array.isArray(v) ? v : [v]) raw += `${k}: ${value}\r\n`;
    }
    upstream.write(raw + "\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
function fromTrustedProxy(req) {
  if (!CONFIG.trustedProxy) return true;
  const addr = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return addr === CONFIG.trustedProxy;
}

async function resolve(req) {
  if (!fromTrustedProxy(req)) return { error: [403, "Forbidden", "<p>Open T3 Code from the Home Assistant sidebar.</p>"] };
  const user = requestUser(req);
  if (!user) return { error: [401, "Not signed in", "<p>Open T3 Code from the Home Assistant sidebar.</p>"] };
  if (!(await isAdmin(user.id))) {
    return {
      error: [403, "Not available yet",
        `<p>Hi ${escapeHtml(user.displayName)}. T3 Code is currently limited to Home Assistant administrators.
        Spaces for other household members are on the way.</p>`],
    };
  }
  const inst = instanceFor(user);
  await inst.start();
  return { user, inst };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://gateway");
    const ingressPath = String(req.headers["x-ingress-path"] ?? "").replace(/\/+$/, "");
    const ctx = await resolve(req);
    if (ctx.error) return sendPage(res, ...ctx.error);
    if (isT3Path(url.pathname)) {
      const session = await ctx.inst.ensureSession();
      return proxyHttp(req, res, ctx.inst, session, url.pathname + url.search);
    }
    return serveStatic(req, res, url.pathname, ingressPath);
  } catch (err) {
    warn(err.stack ?? err.message);
    if (!res.headersSent) sendPage(res, 502, "T3 Code couldn't start", `<p>${escapeHtml(err.message)}</p><p>Check the add-on log.</p>`);
  }
});

server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://gateway");
    const ctx = await resolve(req);
    if (ctx.error || !isT3Path(url.pathname)) return socket.destroy();
    const session = await ctx.inst.ensureSession();
    proxyUpgrade(req, socket, head, ctx.inst, session, url.pathname + url.search);
  } catch (err) {
    warn(err.message);
    socket.destroy();
  }
});

// Optional direct port: a plain TCP forward to one user's T3 server, which
// keeps T3's own pairing (for the phone apps or Tailscale).
async function startDirectPort() {
  if (!CONFIG.directPort || !CONFIG.directUser) return;
  const users = await fetchHaUsers().catch(() => new Map());
  const match = [...users.values()].find((u) => u.username === CONFIG.directUser || u.name === CONFIG.directUser || u.id === CONFIG.directUser);
  const user = match
    ? { id: match.id, name: match.username ?? match.name, displayName: match.name }
    : { id: CONFIG.directUser, name: CONFIG.directUser, displayName: CONFIG.directUser };
  const inst = instanceFor(user);
  await inst.start();
  net.createServer((client) => {
    const up = net.connect(inst.port, "127.0.0.1");
    client.pipe(up).pipe(client);
    const close = () => (client.destroy(), up.destroy());
    client.on("error", close);
    up.on("error", close);
  }).listen(CONFIG.directPort, "0.0.0.0", () => log(`direct port ${CONFIG.directPort} -> T3 Code for ${user.name}`));
  try {
    const [cmd, ...pre] = CONFIG.t3Command;
    const { stdout } = await execFileAsync(cmd, [...pre, "pair", "--label", "Direct access"], { env: inst.env, timeout: 60_000 });
    const token = /^Token:\s*(\S+)/m.exec(stdout)?.[1];
    if (token) log(`one-time pairing token for the direct port: ${token} (expires in a few minutes; restart the add-on for a new one)`);
  } catch (err) {
    warn(`could not mint a direct-port pairing token: ${err.message}`);
  }
}

let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    shuttingDown = true;
    log("shutting down");
    for (const inst of instances.values()) inst.stop();
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

server.listen(CONFIG.port, () => {
  log(`listening on :${CONFIG.port} (web app: ${CONFIG.webRoot})`);
  startDirectPort().catch((err) => warn(`direct port: ${err.message}`));
});

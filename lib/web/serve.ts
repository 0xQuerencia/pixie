const path = require("path");
const fs = require("fs");
const log = require("../log");
const auth = require("./auth");
const api = require("./api");

interface JsonObject {
  [key: string]: unknown;
}
type SseClient = { write: (data: string) => void };

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

function serveFile(filePath: string): Response {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);
  return new Response(data, {
    headers: { "Content-Type": mime, "Cache-Control": "no-cache" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

function htmlResponse(html: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

const MAX_INTERNAL_BODY_BYTES = 8_000_000;
const MAX_PROBE_BODY_BYTES = 20_000;

class BodyTooLargeError extends Error {}

function bodyLimitFor(pathname: string): number {
  return /\/test-question$/.test(pathname) ? MAX_PROBE_BODY_BYTES : MAX_INTERNAL_BODY_BYTES;
}

async function readJsonBody(req: Request, method: string, maxBytes = MAX_INTERNAL_BODY_BYTES): Promise<JsonObject> {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return {};
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  const text = await req.text().catch(() => "");
  if (text.length > maxBytes) throw new BodyTooLargeError();
  try {
    return JSON.parse(text) as JsonObject;
  } catch (_) {
    return {};
  }
}

function isHelperDenied(err: string | null | undefined): boolean {
  return !!err && err.includes("not a helper");
}
function isTenantDenied(err: string | null | undefined): boolean {
  return !!err && (err.includes("not a helper") || err.includes("mismatch"));
}
function ticketWriteStatus(err: string | null | undefined): number {
  return isTenantDenied(err) ? 403 : 400;
}
function helperWriteStatus(err: string | null | undefined): number {
  return isHelperDenied(err) ? 403 : 400;
}
function copilotStatus(err: string | null | undefined): number {
  if (isHelperDenied(err)) return 403;
  if (err && err.includes("rate limited")) return 429;
  return 400;
}
function notifyStatus(err: string | null | undefined): number {
  if (isHelperDenied(err)) return 403;
  if (err && err.includes("unavailable")) return 503;
  return 400;
}
function radarWriteStatus(err: string | null | undefined): number {
  if (isHelperDenied(err)) return 403;
  if (err && err.includes("not found")) return 404;
  return 400;
}

const sseClients = new Set<SseClient>();

function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (error) {
      log.debug("web/serve", `SSE client write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function sseStream(req: Request): Response {
  let closed = false;
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const client = {
        write(data: string): void {
          if (!closed) controller.enqueue(encoder.encode(data));
        },
      };
      sseClients.add(client);

      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));

      req.signal.addEventListener("abort", () => {
        closed = true;
        sseClients.delete(client);
        try {
          controller.close();
        } catch (e) {
          log.debug("web/serve", `SSE close failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function startLogFeed() {
  log.subscribe((kind: string, scope: string, args: unknown[]) => {
    broadcastSSE("log", {
      kind,
      scope,
      message: args.map((a: unknown) => (typeof a === "string" ? a : String(a))).join(" "),
      time: Date.now(),
    });
  });
}

let metricTimer: ReturnType<typeof setInterval> | null = null;

function startMetricTicks() {
  if (metricTimer) return;
  metricTimer = setInterval(() => {
    try {
      const pulse = api.buildPulse();
      broadcastSSE("pulse", pulse);
    } catch (e) {
      log.debug("web", `pulse broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      broadcastSSE("metric", { time: Date.now() });
    } catch (error) {
      log.debug("web/serve", `metric SSE broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 10000);
  if (metricTimer.unref) metricTimer.unref();
}

async function handleStatic(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;

  if (filePath.includes("..")) return null;

  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const session = auth.requireSession(req);
      if (!session) return redirect("/login");
    }
    return serveFile(fullPath);
  }

  return null;
}

async function handleScreenshots(req: Request): Promise<Response | null | undefined> {
  const url = new URL(req.url);

  if (url.pathname.startsWith("/screenshots/")) {
    const screenshotPath = url.pathname.slice("/screenshots/".length);

    if (screenshotPath.includes("..")) return;

    const fullPath = path.join(PUBLIC_DIR, "screenshots", screenshotPath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return serveFile(fullPath);
    }
  }

  return null;
}

function renderLoginPage({ error, slackUrl }: { error?: string; slackUrl?: string | null } = {}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pixie Dashboard Login</title>
  <link rel="stylesheet" href="/style.css">
  <style>
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0f1015;
      color: #f4f1e8;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .login-card {
      background: #171922;
      border: 1px solid rgba(244, 241, 232, 0.15);
      border-radius: 12px;
      padding: 32px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      text-align: center;
    }
    .login-logo {
      font-size: 2.2rem;
      font-weight: 700;
      color: #72f1b8;
      margin-bottom: 4px;
      letter-spacing: -0.5px;
    }
    .login-sub {
      font-size: 0.82rem;
      color: rgba(244, 241, 232, 0.6);
      margin-bottom: 24px;
    }
    .login-form {
      display: flex;
      flex-direction: column;
      gap: 14px;
      text-align: left;
    }
    .login-form label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(244, 241, 232, 0.7);
    }
    .login-form input {
      background: #0d0e14;
      border: 1px solid rgba(244, 241, 232, 0.2);
      border-radius: 6px;
      color: #fff;
      font-size: 0.95rem;
      padding: 10px 14px;
      outline: none;
    }
    .login-form input:focus {
      border-color: #72f1b8;
      box-shadow: 0 0 0 2px rgba(114, 241, 184, 0.2);
    }
    .btn-login {
      background: #72f1b8;
      color: #0d0e14;
      font-weight: 700;
      font-size: 0.95rem;
      border: none;
      border-radius: 6px;
      padding: 12px;
      cursor: pointer;
      margin-top: 6px;
      transition: background 0.15s ease;
    }
    .btn-login:hover {
      background: #8affcc;
    }
    .login-divider {
      display: flex;
      align-items: center;
      margin: 20px 0;
      color: rgba(244, 241, 232, 0.3);
      font-size: 0.75rem;
    }
    .login-divider::before, .login-divider::after {
      content: "";
      flex: 1;
      border-bottom: 1px solid rgba(244, 241, 232, 0.15);
    }
    .login-divider span {
      padding: 0 10px;
    }
    .btn-slack {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: #2b2d3a;
      color: #f4f1e8;
      border: 1px solid rgba(244, 241, 232, 0.2);
      border-radius: 6px;
      padding: 10px;
      font-size: 0.85rem;
      text-decoration: none;
      transition: background 0.15s ease;
    }
    .btn-slack:hover {
      background: #36394a;
    }
    .login-error {
      background: rgba(254, 83, 114, 0.15);
      border: 1px solid rgba(254, 83, 114, 0.3);
      color: #fe5372;
      border-radius: 6px;
      padding: 10px;
      font-size: 0.8rem;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="login-logo">🧚 PIXIE</div>
    <div class="login-sub">Control Center & Live Analytics</div>

    ${error ? `<div class="login-error">${error}</div>` : ""}

    <form class="login-form" method="POST" action="/login">
      <label for="passcode">Dashboard Passcode</label>
      <input type="password" id="passcode" name="passcode" placeholder="Enter passcode..." autofocus required>
      <button type="submit" class="btn-login">Enter Control Room →</button>
    </form>

    ${
      slackUrl
        ? `
      <div class="login-divider"><span>OR</span></div>
      <a href="${slackUrl}" class="btn-slack">
        <svg width="16" height="16" viewBox="0 0 122.8 122.8"><path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#e01e5a"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36c5f0"/><path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2eb67d"/><path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ecb22e"/></svg>
        Sign in with Slack
      </a>
    `
        : ""
    }
  </div>
</body>
</html>`;
}

async function handleAuth(req: Request): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/login") {
    if (process.env.SLACK_CLIENT_ID === "dev-testing") {
      const cookieValue = auth.signSession("dev-user", "Developer", "admin");
      const setCookie = `${auth.COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
      return new Response(null, { status: 302, headers: { "Set-Cookie": setCookie, Location: "/" } });
    }

    if (req.method === "POST") {
      try {
        const formData = await req.formData();
        const passcode = formData.get("passcode") as string | null;
        const expected = process.env.PIXIE_DASHBOARD_PASSCODE || "pixie";
        if (passcode && passcode.trim() === expected.trim()) {
          const cookieValue = auth.signSession("admin", "Admin", "admin");
          const setCookie = `${auth.COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
          return new Response(null, { status: 302, headers: { "Set-Cookie": setCookie, Location: "/" } });
        }
        const slackUrl = auth.loginUrl("/");
        return htmlResponse(renderLoginPage({ error: "Invalid passcode. Try again.", slackUrl }));
      } catch (err) {
        return htmlResponse(renderLoginPage({ error: "Login failed." }));
      }
    }

    const slackUrl = auth.loginUrl("/");
    return htmlResponse(renderLoginPage({ slackUrl }));
  }

  if (url.pathname === "/auth/callback") {
    const result = await auth.handleCallback(req);
    if (result.headers) {
      return new Response(null, { status: result.status, headers: result.headers });
    }
    return json(result.body, result.status);
  }

  if (url.pathname === "/auth/logout") {
    const result = auth.handleLogout();
    return new Response(null, { status: result.status, headers: result.headers });
  }

  return null;
}

async function handleApi(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  const adminResult = auth.requireAdmin(req);

  if (url.pathname === "/api/pulse" && method === "GET") {
    const session = auth.requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json(api.buildPulse());
  }

  if (url.pathname === "/api/stream" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return sseStream(req);
  }

  if (url.pathname === "/api/ask" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const result = await api.handleAsk(body.question || "");
    return json(result);
  }

  if (url.pathname === "/api/queue" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.queueList());
  }

  if (url.pathname.startsWith("/api/queue/") && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const parts = url.pathname.split("/");
    const id = Number(parts[3]);
    const action = parts[4];
    if (action === "approve") api.queueApprove(id);
    else if (action === "drop") api.queueDrop(id);
    return json({ ok: true });
  }

  if (url.pathname.startsWith("/api/queue/") && method === "PATCH") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const id = Number(url.pathname.split("/")[3]);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    api.queueEdit(id, body.question, body.answer);
    return json({ ok: true });
  }

  if (url.pathname === "/api/gaps" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.gapsList());
  }

  if (url.pathname.startsWith("/api/gaps/") && method === "PATCH") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const parts = url.pathname.split("/");
    const id = Number(parts[3]);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    api.gapsMove(id, body.kind);
    return json({ ok: true });
  }

  if (url.pathname.startsWith("/api/gaps/") && url.pathname.endsWith("/rejudge") && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const id = Number(url.pathname.split("/")[3]);
    const result = await api.gapsRejudge(id);
    return json(result);
  }

  if (url.pathname === "/api/silence" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.silenceList());
  }

  if (url.pathname === "/api/knowledge" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.knowledgeInfo());
  }

  if (url.pathname === "/api/knowledge/corpus" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.knowledgeCorpus());
  }

  if (url.pathname === "/api/knowledge/refresh" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    await api.knowledgeRefresh();
    return json({ ok: true });
  }

  if (url.pathname === "/api/cache" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.cacheList());
  }

  if (url.pathname.startsWith("/api/cache/") && method === "DELETE") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const hash = url.pathname.split("/")[3];
    api.cacheBust(hash);
    return json({ ok: true });
  }

  if (url.pathname === "/api/teach" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const taught = api.handleTeach(body.question, body.answer, adminResult.session.userId, body.programId);
    if (taught && taught.error) return json(taught, 400);
    return json({ ok: true });
  }

  if (url.pathname === "/api/report" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const week = Number(url.searchParams.get("week") || "0");
    return json(api.reportText(week));
  }

  if (url.pathname === "/api/report/post" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const ok = await api.reportPost();
    return json({ ok });
  }

  if (url.pathname === "/api/health" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.healthCheck());
  }

  if (url.pathname === "/api/programs" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.programsList());
  }

  if (url.pathname === "/api/programs" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    return json(api.programSave(body));
  }

  if (url.pathname.startsWith("/api/programs/") && method === "DELETE") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const id = url.pathname.split("/")[3];
    return json(api.programRemove(id));
  }

  if (url.pathname.startsWith("/api/programs/") && url.pathname.endsWith("/posture") && method === "PATCH") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const id = url.pathname.split("/")[3];
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    return json(api.programSetPosture(id, body.posture));
  }

  if (url.pathname === "/api/tickets" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const programId = url.searchParams.get("programId") || null;
    const status = url.searchParams.get("status") || null;
    return json(api.ticketsList(programId, status));
  }

  if (/^\/api\/tickets\/\d+$/.test(url.pathname) && method === "PATCH") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const id = Number(url.pathname.split("/")[3]);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    if (!body.status) return json({ error: "status required" }, 400);
    return json(api.ticketUpdate(id, body.status, body.assigneeId, adminResult.session?.userId || null));
  }

  if (url.pathname === "/api/channels" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.channelsList());
  }

  if (url.pathname === "/api/channels/toggle" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const body = await req.json().catch(() => ({}));
    return json(api.channelToggle(body));
  }

  if (url.pathname === "/api/channels" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const body = await req.json().catch(() => ({}));
    return json(api.channelAdd(body));
  }

  if (url.pathname.startsWith("/api/channels/") && method === "DELETE") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const parts = url.pathname.split("/");
    const programId = parts[3];
    const channelId = parts[4];
    return json(api.channelRemove(programId, channelId));
  }

  if (url.pathname === "/api/slack/channels" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(await api.slackChannels());
  }

  const historyImportRoute = url.pathname.match(/^\/internal(?:\/v1)?\/programs\/([^/]+)\/history-import$/);
  if (historyImportRoute && (method === "GET" || method === "POST")) {
    const gate = api.internalAuth(req);
    if (!gate.ok) return json(gate.body, gate.status);
    const programId = decodeURIComponent(historyImportRoute[1]);
    const result =
      method === "GET" ? api.internalHistoryImportProgress(programId) : api.internalHistoryImportStart(programId);
    const status =
      result.error === "unknown program"
        ? 404
        : result.error === "Slack client unavailable"
          ? 503
          : result.error
            ? 400
            : 200;
    return json(result, status);
  }

  if (url.pathname.startsWith("/internal/v1/")) {
    const gate = api.internalAuth(req);
    if (!gate.ok) return json(gate.body, gate.status);
    let body: JsonObject;
    try {
      body = await readJsonBody(req, method, bodyLimitFor(url.pathname));
    } catch (err) {
      if (err instanceof BodyTooLargeError) return json({ error: "request body too large" }, 413);
      throw err;
    }

    if (url.pathname === "/internal/v1/health" && method === "GET") {
      return json({ ok: true, time: Date.now() });
    }
    if (url.pathname === "/internal/v1/usage" && method === "GET") {
      return json(api.internalUsage({ days: url.searchParams.get("days") }));
    }
    const usageRoute = url.pathname.match(/^\/internal\/v1\/programs\/([^/]+)\/usage$/);
    if (usageRoute && method === "GET") {
      const res = api.internalProgramUsage(decodeURIComponent(usageRoute[1]), {
        from: url.searchParams.get("from"),
        until: url.searchParams.get("until") || url.searchParams.get("to"),
        bucket: url.searchParams.get("bucket") || "day",
        operation: url.searchParams.get("operation"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      });
      return json(res, res.error === "unknown program" ? 404 : res.error ? 400 : 200);
    }
    if (url.pathname === "/internal/v1/programs" && method === "GET") {
      return json(api.programsList());
    }
    const progSync = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)$/);
    if (progSync && method === "PUT") {
      const res = api.internalProgramSync(progSync[1], body);
      return json(res, res.error ? res.status || 400 : 200);
    }
    const programInspect = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/inspect$/);
    if (programInspect && method === "POST") {
      const res = await api.internalProgramInspect(decodeURIComponent(programInspect[1]), body);
      return json(res, res.error ? res.error === "unknown program" ? 404 : res.status || 400 : 200);
    }
    const programDocs = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/docs$/);
    if (programDocs && method === "GET") {
      const res = api.internalProgramDocs(decodeURIComponent(programDocs[1]), url.searchParams.get("section"));
      return json(res, res.error === "unknown program" ? 404 : res.error ? 400 : 200);
    }
    if (programDocs && method === "PUT") {
      const res = api.internalProgramDocUpsert(decodeURIComponent(programDocs[1]), null, body);
      return json(res, res.error ? res.error === "unknown program" ? 404 : res.status || 400 : 200);
    }
    const programDoc = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/docs\/(\d+)$/);
    if (programDoc && method === "GET") {
      const res = api.internalProgramDoc(decodeURIComponent(programDoc[1]), Number(programDoc[2]));
      return json(res, res.error ? res.error === "unknown program" ? 404 : 404 : 200);
    }
    if (programDoc && method === "PUT") {
      const res = api.internalProgramDocUpsert(decodeURIComponent(programDoc[1]), Number(programDoc[2]), body);
      return json(res, res.error ? res.error === "unknown program" ? 404 : res.error === "document not found" ? 404 : res.status || 400 : 200);
    }
    if (programDoc && method === "DELETE") {
      const res = api.internalProgramDocDelete(decodeURIComponent(programDoc[1]), Number(programDoc[2]));
      return json(res, res.error ? res.error === "unknown program" ? 404 : 404 : 200);
    }
    const supersedeDoc = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/docs\/(\d+)\/supersede$/);
    if (supersedeDoc && method === "POST") {
      const res = api.internalProgramDocSupersede(decodeURIComponent(supersedeDoc[1]), Number(supersedeDoc[2]), body);
      return json(res, res.error ? res.error === "unknown program" ? 404 : res.error === "document not found" ? 404 : res.status || 400 : 200);
    }
    const evalCases = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/eval\/cases$/);
    if (evalCases && method === "GET") {
      const res = api.internalProgramEvalCases(decodeURIComponent(evalCases[1]));
      return json(res, res.error === "unknown program" ? 404 : res.error ? 400 : 200);
    }
    if (evalCases && method === "POST") {
      const res = api.internalProgramEvalCaseCreate(decodeURIComponent(evalCases[1]), body);
      return json(res, res.error ? res.error === "unknown program" ? 404 : res.status || 400 : 200);
    }
    const evalCase = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/eval\/cases\/(\d+)$/);
    if (evalCase && method === "DELETE") {
      const res = api.internalProgramEvalCaseDelete(decodeURIComponent(evalCase[1]), Number(evalCase[2]));
      return json(res, res.error ? res.error === "unknown program" ? 404 : 404 : 200);
    }
    const evalRun = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/eval\/run$/);
    if (evalRun && method === "POST") {
      const res = await api.internalProgramEvalRun(decodeURIComponent(evalRun[1]), body);
      return json(res, res.error ? res.error === "unknown program" ? 404 : res.status || 400 : 200);
    }
    const evalRuns = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/eval\/runs$/);
    if (evalRuns && method === "GET") {
      const res = api.internalProgramEvalRuns(decodeURIComponent(evalRuns[1]), url.searchParams.get("limit"));
      return json(res, res.error === "unknown program" ? 404 : res.error ? 400 : 200);
    }
    const programLifecycle = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/lifecycle$/);
    if (programLifecycle && method === "POST") {
      const res = api.internalProgramLifecycle(decodeURIComponent(programLifecycle[1]), body);
      return json(res, res.error ? res.error === "unknown program" ? 404 : res.status || 400 : 200);
    }
    const programPurge = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/purge$/);
    if (programPurge && method === "POST") {
      const res = api.internalProgramPurge(decodeURIComponent(programPurge[1]), body);
      return json(res, res.error ? res.error === "unknown program" ? 404 : res.status || 400 : 200);
    }
    const testQuestion = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/test-question$/);
    if (testQuestion && method === "POST") {
      const res = await api.internalTestQuestion(decodeURIComponent(testQuestion[1]), body);
      if (!res.error) return json(res);
      return json(res, res.error === "unknown program" ? 404 : res.status || 400);
    }
    const helpersSync = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/helpers$/);
    if (helpersSync && method === "GET") {
      return json(require("../db").listHelpers(helpersSync[1]));
    }
    if (helpersSync && method === "PUT") {
      const res = api.internalHelpersSync(helpersSync[1], body);
      return json(res, res.error ? 403 : 200);
    }
    const auditRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/audit$/);
    if (auditRoute && method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      return json(require("../db").listAuditEvents({ programId: auditRoute[1], limit }));
    }
    if (url.pathname === "/internal/v1/slack/channels" && method === "GET") {
      return json(await api.slackChannels());
    }
    if (url.pathname === "/internal/v1/slack/membership" && method === "GET") {
      return json(await api.internalSlackMembership(url.searchParams.get("channel")));
    }
    if (url.pathname === "/internal/v1/slack/users/info" && method === "GET") {
      return json(await api.internalUserInfo(url.searchParams.get("user")));
    }
    if (url.pathname === "/internal/v1/slack/users/info" && method === "POST") {
      return json(await api.internalUserInfoBatch(Array.isArray(body?.userIds) ? body.userIds : []));
    }
    if (url.pathname === "/internal/v1/tickets" && method === "GET") {
      const res = api.internalTicketSearch({
        programId: url.searchParams.get("programId"),
        status: url.searchParams.get("status"),
        assigneeId: url.searchParams.get("assigneeId"),
        requesterId: url.searchParams.get("requesterId"),
        category: url.searchParams.get("category"),
        priority: url.searchParams.get("priority"),
        q: url.searchParams.get("q"),
        since: url.searchParams.get("since"),
        until: url.searchParams.get("until"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      });
      return json(res, res.error ? 400 : 200);
    }
    const ticketRoute = url.pathname.match(/^\/internal\/v1\/tickets\/(\d+)$/);
    if (ticketRoute && method === "GET") {
      const programId = url.searchParams.get("programId");
      if (!programId) return json({ error: "programId required" }, 400);
      const detail = api.ticketDetail(Number(ticketRoute[1]), programId);
      if (!detail) return json({ error: "ticket not found" }, 404);
      if (detail.error === "program mismatch") {
        return json({ error: "program mismatch" }, 403);
      }
      return json(detail);
    }
    const ticketAction = url.pathname.match(/^\/internal\/v1\/tickets\/(\d+)\/([a-z]+)$/);
    if (ticketAction && method === "PATCH") {
      const res = api.internalTicketAction(Number(ticketAction[1]), ticketAction[2], body);
      return json(res, res.error ? ticketWriteStatus(res.error) : 200);
    }
    if (ticketAction && ticketAction[2] === "reply" && method === "POST") {
      const res = await api.internalTicketReply(Number(ticketAction[1]), body);
      return json(res, res.error ? ticketWriteStatus(res.error) : 200);
    }
    if (ticketAction && ticketAction[2] === "notes" && method === "POST") {
      const res = api.internalTicketNote(Number(ticketAction[1]), body);
      return json(res, res.error ? ticketWriteStatus(res.error) : 200);
    }
    const copilotRoute = url.pathname.match(/^\/internal\/v1\/copilot\/([a-z]+)$/);
    if (copilotRoute && method === "POST") {
      const res = await api.internalCopilot(copilotRoute[1], body);
      return json(res, res.error ? copilotStatus(res.error) : 200);
    }
    const candList = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/knowledge\/candidates$/);
    if (candList && method === "GET") {
      const res = api.internalKnowledgeCandidates(candList[1], url.searchParams.get("status"));
      return json(res, res.error ? 400 : 200);
    }
    if (candList && method === "POST") {
      const res = await api.internalKnowledgePropose(candList[1], body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const candAction = url.pathname.match(/^\/internal\/v1\/knowledge\/candidates\/(\d+)$/);
    if (candAction && method === "PATCH") {
      const res = api.internalKnowledgeCandidateAction(Number(candAction[1]), body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const gapsRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/gaps\/clusters$/);
    if (gapsRoute && method === "GET") {
      const res = api.internalGapClusters(gapsRoute[1], {
        sinceMs: url.searchParams.get("sinceMs"),
        minAskers: url.searchParams.get("minAskers"),
      });
      return json(res, res.error ? 400 : 200);
    }
    if (gapsRoute && method === "POST") {
      const res = await api.internalFaqPropose(gapsRoute[1], body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const macroSuggestRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/macros\/suggest$/);
    if (macroSuggestRoute && method === "GET") {
      return json(
        api.internalMacroSuggest(macroSuggestRoute[1], {
          q: url.searchParams.get("q"),
          limit: url.searchParams.get("limit"),
        }),
      );
    }
    const macroTemplatesRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/macros\/templates$/);
    if (macroTemplatesRoute && method === "GET") {
      const res = api.internalMacroTemplates(macroTemplatesRoute[1], { actorId: url.searchParams.get("actorId") });
      return json(res, res.error ? (res.error.includes("not a helper") ? 403 : 400) : 200);
    }
    const macroWaitingRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/macros\/waiting$/);
    if (macroWaitingRoute && method === "GET") {
      const res = api.internalMacroWaiting(macroWaitingRoute[1], {
        actorId: url.searchParams.get("actorId"),
        category: url.searchParams.get("category"),
      });
      return json(res, res.error ? (res.error.includes("not a helper") ? 403 : 400) : 200);
    }
    const routingRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/routing\/recommend$/);
    if (routingRoute && method === "GET") {
      return json(
        api.internalRoutingRecommend(routingRoute[1], {
          category: url.searchParams.get("category"),
          limit: url.searchParams.get("limit"),
        }),
      );
    }
    const helperStatsRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/helpers\/stats$/);
    if (helperStatsRoute && method === "GET") {
      const res = api.internalHelperStats(helperStatsRoute[1], {
        recentLimit: url.searchParams.get("recentLimit"),
        since: url.searchParams.get("since"),
      });
      return json(res, res.error ? 400 : 200);
    }
    const leaderboardRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/leaderboard$/);
    if (leaderboardRoute && method === "GET") {
      const res = api.internalLeaderboard(leaderboardRoute[1], { days: url.searchParams.get("days") });
      return json(res, res.error ? 400 : 200);
    }
    const shadowRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/routing\/shadow$/);
    if (shadowRoute && method === "GET") {
      const res = api.internalShadowRouting(shadowRoute[1], { limit: url.searchParams.get("limit") });
      return json(res, res.error ? 400 : 200);
    }
    const draftRoute = url.pathname.match(/^\/internal\/v1\/drafts\/([A-Za-z0-9-]+)\/sync$/);
    if (draftRoute && method === "POST") {
      const res = await api.internalDraftSync(draftRoute[1], body);
      return json(res, res.error ? 400 : 200);
    }
    const expertiseRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/routing\/expertise$/);
    if (expertiseRoute && method === "PUT") {
      const res = api.internalRoutingExpertise(expertiseRoute[1], body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const dupRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/duplicates$/);
    if (dupRoute && method === "GET") {
      return json(
        api.internalDuplicates(dupRoute[1], {
          ticketId: url.searchParams.get("ticketId"),
          q: url.searchParams.get("q"),
          limit: url.searchParams.get("limit"),
        }),
      );
    }
    const incidentManualRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/incidents\/manual$/);
    if (incidentManualRoute && method === "POST") {
      const res = api.internalIncidentCreate(incidentManualRoute[1], body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const incidentList = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/incidents$/);
    if (incidentList && method === "GET") {
      return json(
        api.internalIncidents(incidentList[1], {
          status: url.searchParams.get("status"),
          limit: url.searchParams.get("limit"),
        }),
      );
    }
    if (incidentList && method === "POST") {
      const res =
        body.action === "create"
          ? api.internalIncidentCreate(incidentList[1], body)
          : api.internalIncidentDetect(incidentList[1], body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const incidentRoute = url.pathname.match(/^\/internal\/v1\/incidents\/(\d+)$/);
    if (incidentRoute && method === "GET") {
      const programId = url.searchParams.get("programId") || "";
      const res = api.internalIncidentDetail(programId, Number(incidentRoute[1]));
      const status = res.error === "programId required" ? 400 : res.error ? 404 : 200;
      return json(res, status);
    }
    if (incidentRoute && method === "PATCH") {
      const res = api.internalIncidentAction(Number(incidentRoute[1]), body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const incidentNotifyRoute = url.pathname.match(/^\/internal\/v1\/incidents\/(\d+)\/notify$/);
    if (incidentNotifyRoute && method === "POST") {
      const res = await api.internalIncidentNotify(Number(incidentNotifyRoute[1]), body);
      return json(res, res.error ? notifyStatus(res.error) : 200);
    }
    const incidentAffectedRoute = url.pathname.match(/^\/internal\/v1\/incidents\/(\d+)\/affected$/);
    if (incidentAffectedRoute && method === "GET") {
      const programId = url.searchParams.get("programId") || "";
      const res = api.internalIncidentAffected(programId, Number(incidentAffectedRoute[1]), {
        onlyUnnotified: url.searchParams.get("onlyUnnotified"),
      });
      const status = res.error === "programId required" ? 400 : res.error ? 404 : 200;
      return json(res, status);
    }
    const radarRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/radar$/);
    if (radarRoute && method === "GET") {
      const res = api.internalRadarList(radarRoute[1], {
        status: url.searchParams.get("status"),
        severity: url.searchParams.get("severity"),
        limit: url.searchParams.get("limit"),
      });
      return json(res, res.error ? 400 : 200);
    }
    if (radarRoute && method === "POST") {
      const res = api.internalRadarEvaluate(radarRoute[1], body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const radarActionRoute = url.pathname.match(/^\/internal\/v1\/radar\/(\d+)$/);
    if (radarActionRoute && method === "PATCH") {
      const res = api.internalRadarAction(Number(radarActionRoute[1]), body);
      return json(res, res.error ? radarWriteStatus(res.error) : 200);
    }
    const healthRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/health$/);
    if (healthRoute && method === "GET") {
      const res = api.internalHealthScore(healthRoute[1]);
      return json(res, res.error ? 400 : 200);
    }
    const waitRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/wait$/);
    if (waitRoute && method === "GET") {
      return json(
        api.internalWaitEstimate(waitRoute[1], {
          category: url.searchParams.get("category"),
          ticketId: url.searchParams.get("ticketId"),
        }),
      );
    }
    const analyticsRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/analytics$/);
    if (analyticsRoute && method === "GET") {
      return json(api.internalAnalytics(analyticsRoute[1], { days: url.searchParams.get("days") }));
    }
    const slaRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/sla$/);
    if (slaRoute && method === "GET") {
      return json(api.internalSlaCheck(slaRoute[1]));
    }
    const retentionRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/retention$/);
    if (retentionRoute && method === "GET") {
      return json(api.internalRetentionPreview(retentionRoute[1]));
    }
    if (retentionRoute && method === "POST") {
      const res = api.internalRetentionSweep(retentionRoute[1], body);
      return json(res, res.error ? 403 : 200);
    }
    if (retentionRoute && method === "PATCH") {
      const res = api.internalRetentionPolicy(retentionRoute[1], body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const macrosRoute = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/macros$/);
    if (macrosRoute && method === "GET") {
      const res = api.internalMacrosList(macrosRoute[1], {
        enabledOnly: url.searchParams.get("enabledOnly"),
        q: url.searchParams.get("q"),
      });
      return json(res, res.error ? 400 : 200);
    }
    if (macrosRoute && method === "POST") {
      const res = api.internalMacroCreate(macrosRoute[1], body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    const macroBulkRoute = url.pathname.match(/^\/internal\/v1\/macros\/(\d+)\/bulk$/);
    if (macroBulkRoute && method === "POST") {
      const res = await api.internalMacroBulkSend(Number(macroBulkRoute[1]), body);
      return json(res, res.error ? ticketWriteStatus(res.error) : 200);
    }
    const macroRoute = url.pathname.match(/^\/internal\/v1\/macros\/(\d+)$/);
    if (macroRoute && method === "PATCH") {
      const res = api.internalMacroUpdate(Number(macroRoute[1]), body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    if (macroRoute && method === "DELETE") {
      const res = api.internalMacroDelete(Number(macroRoute[1]), body);
      return json(res, res.error ? helperWriteStatus(res.error) : 200);
    }
    if (macroRoute && method === "POST") {
      const res = await api.internalMacroSend(Number(macroRoute[1]), body);
      return json(res, res.error ? ticketWriteStatus(res.error) : 200);
    }
    {
      const dashboardApi = require("./dashboardApi");
      const dashNotFound = (res: JsonObject) =>
        res && res.error === "unknown program"
          ? 404
          : res && res.error === "ticket not found"
            ? 404
            : res && res.error === "helper not found"
              ? 404
              : null;
      const dashTicketSearch = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/tickets\/search$/);
      if (dashTicketSearch && method === "GET") {
        const res = dashboardApi.ticketSearchScoped(decodeURIComponent(dashTicketSearch[1]), {
          status: url.searchParams.get("status"),
          statusGroup: url.searchParams.get("statusGroup"),
          assigneeId: url.searchParams.get("assigneeId"),
          requesterId: url.searchParams.get("requesterId"),
          category: url.searchParams.get("category"),
          priority: url.searchParams.get("priority"),
          q: url.searchParams.get("q"),
          since: url.searchParams.get("since"),
          until: url.searchParams.get("until"),
          sort: url.searchParams.get("sort"),
          dir: url.searchParams.get("dir"),
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
        });
        const notFound = dashNotFound(res);
        return json(res, notFound || (res.error ? 400 : 200));
      }
      const dashTicketDetail = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/tickets\/(\d+)$/);
      if (dashTicketDetail && method === "GET") {
        const res = dashboardApi.ticketDetailScoped(
          decodeURIComponent(dashTicketDetail[1]),
          Number(dashTicketDetail[2]),
        );
        const notFound = dashNotFound(res);
        return json(res, notFound || (res.error ? 400 : 200));
      }
      const dashMetrics = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/dashboard\/metrics$/);
      if (dashMetrics && method === "GET") {
        const res = dashboardApi.metricsOverview(decodeURIComponent(dashMetrics[1]), {
          days: url.searchParams.get("days"),
        });
        const notFound = dashNotFound(res);
        return json(res, notFound || (res.error ? 400 : 200));
      }
      const dashKnowledgeStatus = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/knowledge\/status$/);
      if (dashKnowledgeStatus && method === "GET") {
        const res = dashboardApi.knowledgeStatus(decodeURIComponent(dashKnowledgeStatus[1]));
        const notFound = dashNotFound(res);
        return json(res, notFound || (res.error ? 400 : 200));
      }
      const dashKnowledgeRefresh = url.pathname.match(
        /^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/knowledge\/refresh$/,
      );
      if (dashKnowledgeRefresh && method === "POST") {
        const res = dashboardApi.knowledgeRefresh(decodeURIComponent(dashKnowledgeRefresh[1]));
        const notFound = dashNotFound(res);
        return json(res, notFound || (res.error ? 400 : 200));
      }
      const dashRoster = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/helpers\/roster$/);
      if (dashRoster && method === "GET") {
        const res = dashboardApi.helperRoster(decodeURIComponent(dashRoster[1]));
        const notFound = dashNotFound(res);
        return json(res, notFound || (res.error ? 400 : 200));
      }
      const dashHelperActive = url.pathname.match(/^\/internal\/v1\/programs\/([A-Za-z0-9-]+)\/helpers\/active$/);
      if (dashHelperActive && (method === "PATCH" || method === "PUT")) {
        const res = dashboardApi.helperSetActive(decodeURIComponent(dashHelperActive[1]), body);
        const notFound = dashNotFound(res);
        if (notFound) return json(res, notFound);
        if (res.error) return json(res, res.error === "actor is not a helper of this program" ? 403 : 400);
        return json(res);
      }
    }
    return json({ error: "unknown internal route" }, 404);
  }

  return null;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  try {
    if (["/login", "/auth/callback", "/auth/logout"].includes(url.pathname) || url.pathname.startsWith("/auth/")) {
      const res = await handleAuth(req);
      if (res) return res;
    }

    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/internal/v1/") ||
      url.pathname.startsWith("/internal/programs/")
    ) {
      const res = await handleApi(req);
      if (res) return res;
    }

    if (url.pathname.startsWith("/screenshots/")) {
      const res = await handleScreenshots(req);
      if (res) return res;
    }

    const res = await handleStatic(req);
    if (res) return res;

    return new Response("not found", { status: 404 });
  } catch (e) {
    log.error("web", `request error: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "internal error" }, 500);
  }
}

function start() {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    log.info("web", "SLACK_CLIENT_ID not set — passcode auth & screenshot serving enabled");
  }

  const port = Number(process.env.PORT) || Number(process.env.PIXIE_WEB_PORT) || 4100;

  startLogFeed();
  startMetricTicks();

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: handleRequest,
  });

  log.info("web", `console running on http://0.0.0.0:${port}`);
  return server;
}

export = { start, broadcastSSE, handleRequest };

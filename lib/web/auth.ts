const crypto = require("crypto");
const { isAdmin } = require("../config");
const log = require("../log");

const COOKIE_NAME = "pixie_sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map();

type Session = { userId: string; userName: string; role: string };
type AuthRequest = Request;
type AuthResult = { status: number; body?: Record<string, unknown>; headers?: Record<string, string> };
interface SlackTokenResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
}
interface SlackUserInfoResponse {
  ok: boolean;
  error?: string;
  name?: string;
  "https://slack.com/user_id": string;
}

let ephemeralSecret: string | null = null;

function sessionSecret() {
  if (process.env.PIXIE_SESSION_SECRET) return process.env.PIXIE_SESSION_SECRET;
  if (!ephemeralSecret) ephemeralSecret = crypto.randomBytes(32).toString("hex");
  return ephemeralSecret;
}

function signSession(userId: string, userName: string, role = "user"): string | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const payload = JSON.stringify({ userId, userName, role, expiresAt: Date.now() + SESSION_TTL_MS });
  const encoded = Buffer.from(payload).toString("base64url");
  const hmac = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  return `${encoded}.${hmac}`;
}

function verifySession(token: string): Session | null {
  try {
    const secret = sessionSecret();
    if (!secret || !token) return null;
    const [encoded, hmac] = token.split(".");
    if (!encoded || !hmac) return null;
    const expected = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
    const received = Buffer.from(hmac, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) return null;
    const session = JSON.parse(Buffer.from(encoded, "base64url").toString()) as {
      userId: string;
      userName?: string;
      role?: string;
      expiresAt: number;
    };
    if (!session.userId || !Number.isFinite(session.expiresAt) || session.expiresAt < Date.now()) return null;
    return { userId: session.userId, userName: session.userName || session.userId, role: session.role || "user" };
  } catch {
    return null;
  }
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const map: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    map[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return map;
}

function getSession(req: AuthRequest): Session | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return verifySession(token);
}

function requireAdmin(req: AuthRequest): AuthResult | { session: Session } {
  const session = getSession(req);
  if (!session) return { status: 401, body: { error: "unauthorized" } };
  if (!isAdminSession(session)) return { status: 403, body: { error: "admin only" } };
  return { session };
}

function isAdminSession(session: Session | null): boolean {
  if (!session) return false;
  if (session.role === "admin" || session.userId === "admin") return true;
  try {
    return isAdmin(session.userId);
  } catch (_) {
    return false;
  }
}

function requireSession(req: AuthRequest): Session | null {
  const session = getSession(req);
  if (!session) return null;
  return session;
}

function loginUrl(redirect: string): string | null {
  const state = crypto.randomBytes(16).toString("hex");
  sessions.set(state, { redirect: redirect || "/", created: Date.now() });

  const webUrl = process.env.PIXIE_WEB_URL;
  if (!process.env.SLACK_CLIENT_ID || !webUrl) return null;
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: "openid,profile,email",
    state,
    redirect_uri: `${webUrl}/auth/callback`,
  });

  return `https://slack.com/openid/connect/authorize?${params}`;
}

async function handleCallback(req: AuthRequest): Promise<AuthResult> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const session = sessions.get(state || "");
  sessions.delete(state || "");
  if (!session || Date.now() - session.created > 10 * 60 * 1000) {
    return { status: 400, body: { error: "invalid or expired state" } };
  }

  if (!code) {
    return { status: 400, body: { error: "missing code" } };
  }

  try {
    const tokenRes = await fetch("https://slack.com/api/openid.connect.token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID || "",
        client_secret: process.env.SLACK_CLIENT_SECRET || "",
        code,
        redirect_uri: `${process.env.PIXIE_WEB_URL || ""}/auth/callback`,
      }),
    });

    const tokenData = (await tokenRes.json()) as SlackTokenResponse;
    if (!tokenData.ok) {
      log.error("auth", `token exchange failed: ${tokenData.error}`);
      return { status: 401, body: { error: "auth failed" } };
    }

    const userRes = await fetch("https://slack.com/api/openid.connect.userInfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = (await userRes.json()) as SlackUserInfoResponse;
    if (!userData.ok) {
      log.error("auth", `userinfo failed: ${userData.error}`);
      return { status: 401, body: { error: "auth failed" } };
    }

    const userId = userData["https://slack.com/user_id"];
    const userName = userData.name || userId;
    const cookieValue = signSession(userId, userName);

    const setCookie = `${COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${process.env.PIXIE_WEB_URL?.startsWith("https://") ? "; Secure" : ""}`;

    return {
      status: 302,
      headers: { "Set-Cookie": setCookie, Location: session.redirect },
    };
  } catch (e) {
    log.error("auth", `callback error: ${e instanceof Error ? e.message : String(e)}`);
    return { status: 500, body: { error: "auth error" } };
  }
}

function handleLogout() {
  const setCookie = `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  return {
    status: 302,
    headers: { "Set-Cookie": setCookie, Location: "/" },
  };
}

export = {
  signSession,
  verifySession,
  getSession,
  requireSession,
  requireAdmin,
  loginUrl,
  handleCallback,
  handleLogout,
  COOKIE_NAME,
};

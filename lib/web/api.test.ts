process.env.PIXIE_DB_PATH = ":memory:";

interface UserInfoRequest {
  user: string;
}
interface SourceRow {
  url: string;
  name: string;
  freshness: string;
}
interface TestQuestionArgs {
  program: unknown;
  role: string;
  settings: unknown;
  engagement: unknown;
  grounded: boolean;
  addressed?: boolean;
  hasAnswer?: boolean;
  [key: string]: unknown;
}

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const api = require("./api");
const incidents = require("../incidents");

before(() => {
  db.close();
  db.open(":memory:");
});

test("manual incident creation is helper-gated and tenant-scoped", () => {
  api.internalProgramSync("manual-a", {
    name: "Manual A",
    workspaceId: "TW-MA",
    claimedBy: "U-manual-a",
    programChannels: [],
  });
  api.internalProgramSync("manual-b", {
    name: "Manual B",
    workspaceId: "TW-MB",
    claimedBy: "U-manual-b",
    programChannels: [],
  });
  const created = api.internalIncidentCreate("manual-a", {
    actorId: "U-manual-a",
    title: "Website unavailable",
    description: "Users cannot open the site",
    publicMessage: "Heads up — the site is currently unavailable.",
  });
  assert.equal(created.ok, true);
  assert.equal(created.incident.program_id, "manual-a");
  assert.equal(created.incident.status, "confirmed");
  assert.equal(created.incident.declared_by, "U-manual-a");
  assert.match(
    api.internalIncidentCreate("manual-a", { actorId: "U-manual-b", title: "cross-tenant", publicMessage: "nope" })
      .error,
    /not a helper/,
  );
  assert.match(
    api.internalIncidentCreate("manual-b", { actorId: "U-manual-a", title: "cross-tenant", publicMessage: "nope" })
      .error,
    /not a helper/,
  );
  assert.equal(api.internalIncidents("manual-b", {}).length, 0);
  assert.match(
    api.internalIncidentCreate("missing-manual", { actorId: "U-manual-a", title: "x", publicMessage: "x" }).error,
    /unknown program/,
  );
});

test("incident detail and affected-report reads enforce the requested program", () => {
  api.internalProgramSync("read-api-a", {
    name: "Read API A",
    workspaceId: "TW-RA",
    claimedBy: "U-read-api-a",
    programChannels: [],
  });
  api.internalProgramSync("read-api-b", {
    name: "Read API B",
    workspaceId: "TW-RB",
    claimedBy: "U-read-api-b",
    programChannels: [],
  });
  const created = api.internalIncidentCreate("read-api-a", {
    actorId: "U-read-api-a",
    title: "Read API outage",
  });
  const incidentId = created.incident.id;
  incidents.recordAffectedReport({
    incidentId,
    programId: "read-api-a",
    requesterId: "U-requester",
    channel: "C-read-api",
    threadTs: "read-api-thread",
  });

  const detail = api.internalIncidentDetail("read-api-a", incidentId);
  assert.equal(detail.incident.program_id, "read-api-a");
  assert.equal(detail.tickets.length, 0);
  assert.match(api.internalIncidentDetail("read-api-b", incidentId).error, /not found/);
  assert.match(api.internalIncidentDetail("", incidentId).error, /programId required/);

  const affected = api.internalIncidentAffected("read-api-a", incidentId, {});
  assert.equal(affected.total, 1);
  assert.match(api.internalIncidentAffected("read-api-b", incidentId, {}).error, /not found/);
  assert.match(api.internalIncidentAffected("", incidentId, {}).error, /programId required/);
});

test("program usage is validated, bounded, tenant-isolated, and metadata-only", () => {
  const programs = require("../programs");
  programs.saveProgram({ id: "usage-a", name: "Usage A" });
  programs.saveProgram({ id: "usage-b", name: "Usage B" });
  db.recordLlmUsage({
    programId: "usage-a",
    operation: "answer",
    provider: "openai",
    channel: "C-A",
    requestId: "req-a",
    model: "known",
    status: "success",
    totalTokens: 10,
    createdAt: 1_700_000_000_000,
  });
  db.recordLlmUsage({
    programId: "usage-a",
    operation: "answer",
    provider: "openai",
    channel: "C-A",
    requestId: "req-a",
    model: "known",
    status: "error",
    httpStatus: 429,
    rateLimited: true,
    attempt: 2,
    retryCount: 1,
    createdAt: 1_700_000_000_100,
  });
  db.recordLlmUsage({
    programId: "usage-b",
    operation: "intent",
    requestId: "other",
    model: "other",
    status: "success",
    totalTokens: 99,
    createdAt: 1_700_000_000_000,
  });
  const report = api.internalProgramUsage("usage-a", {
    from: "2023-11-14T00:00:00Z",
    until: "2023-11-15T00:00:01Z",
    bucket: "day",
    limit: 1,
  });
  assert.equal(report.summary.requests, 1);
  assert.equal(report.summary.rate_limited, 1);
  assert.equal(report.summary.cost_usd, null);
  assert.equal(report.pagination.total, 2);
  assert.equal("prompt" in report.recentActivity[0], false);
  assert.equal(api.internalProgramUsage("missing-usage", {}).error, "unknown program");
  assert.match(api.internalProgramUsage("usage-a", { bucket: "week" }).error, /bucket/);
});

test("program usage returns an empty bounded report and rejects reversed ranges", () => {
  const programs = require("../programs");
  programs.saveProgram({ id: "usage-empty", name: "Usage Empty" });
  const empty = api.internalProgramUsage("usage-empty", {
    from: "2026-01-01T00:00:00Z",
    until: "2026-01-02T00:00:00Z",
    bucket: "day",
    limit: 0,
    offset: -10,
  });
  assert.equal(empty.summary.requests, 0);
  assert.equal(empty.pagination.limit, 50);
  assert.equal(empty.pagination.offset, 0);
  assert.deepEqual(empty.recent, []);
  assert.match(
    api.internalProgramUsage("usage-empty", {
      from: "2026-01-02T00:00:00Z",
      until: "2026-01-01T00:00:00Z",
    }).error,
    /date range/,
  );
});

test("program usage keeps recent channel metadata after a logical retry", () => {
  const programs = require("../programs");
  programs.saveProgram({ id: "usage-channel", name: "Usage Channel" });
  db.recordLlmUsage({
    programId: "usage-channel",
    operation: "answer",
    provider: "openai",
    channel: "C-CHANNEL",
    requestId: "usage-channel-request",
    model: "known",
    status: "success",
    latencyMs: 12,
    createdAt: 1_700_000_000_000,
  });
  const report = api.internalProgramUsage("usage-channel", {
    from: "2023-11-14T00:00:00Z",
    until: "2023-11-15T00:00:01Z",
  });
  assert.equal(report.recent[0].consumerId, "C-CHANNEL");
  assert.equal(report.recent[0].latencyMs, 12);
  assert.equal(report.recent[0].requestId, "usage-channel-request");
});

after(() => {
  api.setSlackClient(null);
});

test("internalUserInfo returns display name and avatar, never the raw profile", async () => {
  api.setSlackClient({
    users: {
      info: async ({ user }: UserInfoRequest) => {
        assert.equal(user, "U_TARGET");
        return {
          user: {
            id: "U_TARGET",
            name: "jdoe",
            profile: {
              display_name: "J. Doe",
              real_name: "Jane Doe",
              email: "jane@example.com",
              image_192: "https://avatars.example.com/jane.png",
            },
          },
        };
      },
    },
  });

  const res = await api.internalUserInfo("U_TARGET");
  assert.equal(res.ok, true);
  assert.equal(res.displayName, "J. Doe");
  assert.equal(res.avatarUrl, "https://avatars.example.com/jane.png");
  assert.equal("email" in res, false);
  assert.equal("id" in res, false);
  assert.equal(JSON.stringify(res).includes("jane@example.com"), false);
});

test("internalUserInfo falls back to real_name then bare name when no display_name is set", async () => {
  api.setSlackClient({ users: { info: async () => ({ user: { name: "bareuser", profile: {} } }) } });
  const res = await api.internalUserInfo("U_BARE");
  assert.equal(res.ok, true);
  assert.equal(res.displayName, "bareuser");
  assert.equal(res.avatarUrl, null);
});

test("internalUserInfo fails soft (ok:false) instead of throwing when Slack errors", async () => {
  api.setSlackClient({
    users: {
      info: async () => {
        throw new Error("user_not_found");
      },
    },
  });
  const res = await api.internalUserInfo("U_GONE");
  assert.equal(res.ok, false);
  assert.equal(typeof res.reason, "string");
});

test("internalUserInfo requires a user id", async () => {
  const res = await api.internalUserInfo(null);
  assert.equal(res.ok, false);
});

test("knowledge health exposes namespaced freshness without source-cache secrets", () => {
  const programs = require("../programs");
  programs.saveProgram({
    id: "health-source-a",
    name: "Health A",
    sources: [{ name: "Docs", type: "url", url: "https://a.example/docs?token=secret" }],
    sharedSources: false,
  });
  programs.saveProgram({
    id: "health-source-b",
    name: "Health B",
    sources: [{ name: "Docs", type: "url", url: "https://b.example/docs" }],
    sharedSources: false,
  });

  const health = api.internalKnowledgeHealth("health-source-a");
  const source = health.sources.find((item: SourceRow) => item.url === "https://a.example/docs");
  assert.ok(source);
  assert.equal(source.name, "Docs");
  assert.equal(source.freshness, "unavailable");
  assert.equal("key" in source, false);
  assert.equal("lastError" in source, false);
  assert.equal(JSON.stringify(health).includes("token=secret"), false);
  assert.equal(api.internalKnowledgeHealth("missing-health-program").error, "unknown program");
});

test("knowledge info includes source freshness and metric counters", () => {
  const info = api.knowledgeInfo();
  assert.ok(Array.isArray(info.sources));
  assert.equal(typeof info.metrics.sourceRefreshFailure, "number");
  assert.equal(typeof info.metrics.staleDynamicSourceUsed, "number");
  for (const source of info.sources) {
    assert.ok(["fresh", "stale", "unavailable"].includes(source.freshness));
    assert.equal("key" in source, false);
    assert.equal("lastError" in source, false);
  }
});

test("internalUserInfo caches a resolved identity — a second call doesn't hit Slack again", async () => {
  let calls = 0;
  api.setSlackClient({
    users: {
      info: async () => {
        calls += 1;
        return { user: { name: "cacheduser", profile: { display_name: "Cached User" } } };
      },
    },
  });
  const first = await api.internalUserInfo("U_CACHE_TEST");
  const second = await api.internalUserInfo("U_CACHE_TEST");
  assert.equal(first.displayName, "Cached User");
  assert.equal(second.displayName, "Cached User");
  assert.equal(calls, 1, "the second call should be served from cache, not a fresh Slack request");
});

function charReq(token: string) {
  return { headers: { get: (k: string) => (k === "authorization" ? `Bearer ${token}` : "") } };
}
function charAnon() {
  return { headers: { get: () => "" } };
}

test("internalAuth matrix — absent token→404, bad bearer→401, good→ok", () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  try {
    delete process.env.PIXIE_INTERNAL_TOKEN;
    const disabled = api.internalAuth(charAnon());
    assert.equal(disabled.status, 404);
    assert.match(disabled.body.error, /disabled/);

    process.env.PIXIE_INTERNAL_TOKEN = "char-secret-token";
    assert.equal(api.internalAuth(charAnon()).status, 401);
    assert.equal(api.internalAuth(charReq("wrong")).status, 401);
    assert.equal(api.internalAuth(charReq("char-secret-token")).ok, true);
    assert.equal(api.internalAuth({ headers: { get: () => "char-secret-token" } }).status, 401);
    assert.equal(api.internalAuth(charReq("short")).status, 401);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("ticket mutating paths re-check program + workspace tenant on every call", () => {
  const sync = api.internalProgramSync("char-tenant", {
    name: "Tenant",
    workspaceId: "TW-CHAR",
    claimedBy: "U-char-org",
    programChannels: [],
  });
  assert.equal(sync.ok, true);
  const id = db.createTicket({
    programId: "char-tenant",
    workspaceId: "TW-CHAR",
    channel: "C1",
    threadTs: "char-t1",
    requesterId: "U1",
    question: "help",
  });
  assert.match(
    api.internalTicketAction(id, "claim", { programId: "other-prog", actorId: "U-char-org" }).error,
    /mismatch/,
  );
  assert.match(
    api.internalTicketNote(id, { programId: "other-prog", actorId: "U-char-org", body: "x" }).error,
    /mismatch/,
  );
  assert.match(
    api.internalTicketAction(id, "claim", { programId: "char-tenant", workspaceId: "OTHER-WS", actorId: "U-char-org" })
      .error,
    /mismatch/,
  );
  assert.match(
    api.internalTicketAction(id, "claim", { programId: "char-tenant", actorId: "U-stranger-x" }).error,
    /not a helper/,
  );
  assert.match(
    api.internalTicketNote(id, { programId: "char-tenant", actorId: "U-stranger-x", body: "x" }).error,
    /not a helper/,
  );
});

test("copilot/knowledge/macro/routing/incident/radar mutations all require helper membership", async () => {
  api.internalProgramSync("char-gates", {
    name: "Gates",
    workspaceId: "TW-G",
    claimedBy: "U-gates-org",
    programChannels: [],
  });
  const stranger = "U-gates-stranger";
  const cop = await api.internalCopilot("ask", { programId: "char-gates", actorId: stranger, question: "hi" });
  assert.match(cop.error, /not a helper/);
  const tid = db.createTicket({
    programId: "char-gates",
    workspaceId: "TW-G",
    channel: "C1",
    threadTs: "char-g1",
    requesterId: "U1",
    question: "q",
  });
  const kp = await api.internalKnowledgePropose("char-gates", { actorId: stranger, ticketId: tid });
  assert.match(kp.error, /not a helper/);
  assert.match(
    api.internalMacroCreate("char-gates", { actorId: stranger, trigger: "?x", name: "x", content: "y" }).error,
    /not a helper/,
  );
  assert.match(api.internalRoutingExpertise("char-gates", { actorId: stranger, userId: "U1" }).error, /not a helper/);
  assert.match(api.internalIncidentDetect("char-gates", { actorId: stranger }).error, /not a helper/);
  assert.match(api.internalRadarEvaluate("char-gates", { actorId: stranger }).error, /not a helper/);
  assert.match(api.internalRetentionPolicy("char-gates", { actorId: stranger, policy: {} }).error, /not a helper/);
  assert.match(
    (await api.internalCopilot("ask", { programId: "nope-missing", actorId: "U-gates-org", question: "hi" })).error,
    /unknown program/,
  );
});

test("request validation at the boundary — slugs, names, kinds, ids", () => {
  assert.match(api.internalProgramSync("Bad_Slug!", { name: "x" }).error, /invalid program id/);
  assert.match(api.internalProgramSync("ab", { name: "x" }).error, /invalid program id/);
  assert.match(api.internalProgramSync("char-ok", { name: "x".repeat(81) }).error, /max 80/);
  assert.match(
    api.internalProgramSync("char-ok", { name: "x", programChannels: [{ id: "C1", kind: "evil" }] }).error,
    /invalid channel kind/,
  );
  assert.match(api.internalTicketSearch({}).error, /programId required/);
  api.internalProgramSync("char-valid", {
    name: "V",
    workspaceId: "TW-V",
    claimedBy: "U-valid-org",
    programChannels: [],
  });
  const id = db.createTicket({
    programId: "char-valid",
    workspaceId: "TW-V",
    channel: "C1",
    threadTs: "char-v1",
    requesterId: "U1",
    question: "q",
  });
  assert.match(
    api.internalTicketAction(id, "frobnicate", { programId: "char-valid", actorId: "U-valid-org" }).error,
    /unknown action/,
  );
  assert.match(
    api.internalTicketAction(id, "assign", { programId: "char-valid", actorId: "U-valid-org" }).error,
    /assigneeId required/,
  );
  assert.match(
    api.internalMacroCreate("char-valid", { actorId: "U-valid-org", trigger: "nope", name: "n", content: "c" }).error,
    /trigger/,
  );
});

test("serialization shapes carry no secrets — programs/health/detail/retention", () => {
  const progs = api.programsList();
  assert.ok(Array.isArray(progs));
  const blob = JSON.stringify(progs);
  assert.equal(/token/i.test(blob) && /PIXIE_INTERNAL_TOKEN/.test(blob), false);
  assert.equal(blob.includes("PIXIE_SESSION_SECRET"), false);
  const health = api.healthCheck();
  assert.ok(health.models && health.channels);
  const hblob = JSON.stringify(health);
  assert.equal(hblob.includes("xoxb-"), false);
  assert.equal(/"token"\s*:/i.test(hblob), false);
  assert.equal(/"secret"\s*:/i.test(hblob), false);
  api.internalProgramSync("char-shape", {
    name: "Shape",
    workspaceId: "TW-S",
    claimedBy: "U-shape-org",
    programChannels: [],
  });
  const tid = db.createTicket({
    programId: "char-shape",
    workspaceId: "TW-S",
    channel: "C1",
    threadTs: "char-s1",
    requesterId: "U1",
    question: "q",
  });
  const detail = api.ticketDetail(tid);
  assert.ok(detail.ticket && Array.isArray(detail.events) && Array.isArray(detail.notes));
  assert.ok(api.ticketDetail(tid, "char-shape").ticket);
  assert.equal(api.ticketDetail(tid, "other-shape").error, "program mismatch");
  assert.equal("token" in detail, false);
  const prev = api.internalRetentionPreview("char-shape");
  assert.ok(typeof prev.tickets === "number" && typeof prev.ticketEvents === "number");
  assert.ok(prev.policy && typeof prev.policy.ticketsDays === "number");
  assert.equal(JSON.stringify(prev).includes("xoxb-"), false);
});

test("retention sweep is organizer/owner + confirm gated (plain helpers denied)", () => {
  api.internalProgramSync("char-ret", {
    name: "Ret",
    workspaceId: "TW-R",
    claimedBy: "U-ret-org",
    programChannels: [],
  });
  db.syncHelper({ programId: "char-ret", userId: "U-ret-helper", source: "manual" });
  assert.match(api.internalRetentionSweep("char-ret", { actorId: "U-ret-org" }).error, /confirm required/);
  assert.match(api.internalRetentionSweep("char-ret", { actorId: "U-ret-helper", confirm: true }).error, /organizer/);
  assert.match(api.internalRetentionSweep("char-ret", { actorId: "U-nobody", confirm: true }).error, /organizer/);
  const ok = api.internalRetentionSweep("char-ret", { actorId: "U-ret-org", confirm: true });
  assert.equal(ok.deleted, true);
});

test("regression: internalHelpersSync fails closed on unknown programs (no orphan membership)", () => {
  const res = api.internalHelpersSync("nope-missing-prog", { actorId: "U-any", members: ["U-any"] });
  assert.match(res.error, /unknown program/);
});

test("internalProgramSync merges a sanitized behavior patch onto stored behavior", () => {
  const programs = require("../programs");
  const sync = api.internalProgramSync("dash-behavior", {
    name: "Behavior",
    workspaceId: "TW-DASH",
    claimedBy: "U-dash-org",
    programChannels: [],
    behavior: { main: { ambientProgramReplies: false }, help: { aiReplies: false } },
    status: "sandbox",
  });
  assert.equal(sync.ok, true);
  let stored = programs.get("dash-behavior");
  assert.equal(stored.behavior.main.ambientProgramReplies, false);
  assert.equal(stored.behavior.help.aiReplies, false);
  assert.equal(stored.status, "sandbox");

  const again = api.internalProgramSync("dash-behavior", {
    name: "Behavior",
    workspaceId: "TW-DASH",
    claimedBy: "U-dash-org",
    programChannels: [],
    behavior: { main: { mentionReplies: false, evilKey: true }, help: "not-an-object" },
  });
  assert.equal(again.ok, true);
  stored = programs.get("dash-behavior");
  assert.equal(stored.behavior.main.mentionReplies, false);
  assert.equal(stored.behavior.main.ambientProgramReplies, false);
  assert.equal("evilKey" in (stored.behavior.main || {}), false);
  assert.equal(stored.status, "sandbox");
});

test("internalProgramSync rejects an invalid status and saves nothing", () => {
  const programs = require("../programs");
  const res = api.internalProgramSync("dash-badstatus", {
    name: "Bad Status",
    workspaceId: "TW-DASH",
    claimedBy: "U-dash-org",
    programChannels: [],
    status: "launched",
  });
  assert.match(res.error, /invalid status/);
  assert.equal(programs.get("dash-badstatus"), null);
  for (const ok of ["sandbox", "live", "paused"]) {
    const r = api.internalProgramSync("dash-status-cycle", {
      name: "Cycle",
      workspaceId: "TW-DASH",
      claimedBy: "U-dash-org",
      programChannels: [],
      status: ok,
    });
    assert.equal(r.ok, true);
    assert.equal(programs.get("dash-status-cycle").status, ok);
  }
});

test("internalProgramSync 409s a conflicting help channel and saves nothing", () => {
  const programs = require("../programs");
  const first = api.internalProgramSync("dash-owner", {
    name: "Owner",
    workspaceId: "TW-DASH",
    claimedBy: "U-dash-org",
    helpChannel: "C-dash-help",
    programChannels: [{ id: "C-dash-help", kind: "help" }],
  });
  assert.equal(first.ok, true);

  const clash = api.internalProgramSync("dash-intruder", {
    name: "Intruder",
    workspaceId: "TW-DASH",
    claimedBy: "U-dash-org",
    programChannels: [{ id: "C-dash-help", kind: "help" }],
    status: "sandbox",
  });
  assert.equal(clash.status, 409);
  assert.match(clash.error, /C-dash-help/);
  assert.equal(programs.get("dash-intruder"), null, "conflicting sync must save nothing");
  assert.equal(programs.get("dash-owner").helpChannel, "C-dash-help");

  const same = api.internalProgramSync("dash-owner", {
    name: "Owner",
    workspaceId: "TW-DASH",
    claimedBy: "U-dash-org",
    programChannels: [{ id: "C-dash-help", kind: "help" }],
  });
  assert.equal(same.ok, true);
});

test("testQuestionExpectedAction reuses the pipeline policy", () => {
  const f = (args: TestQuestionArgs) => api.testQuestionExpectedAction(args).expectedAction;
  const program = { id: "p", helpChannel: "CH", channels: ["CH"] };
  const help = {
    enabled: true,
    aiReplies: true,
    ticketsEnabled: true,
    autoCreateTickets: true,
    escalateUnknown: true,
    helperPings: true,
  };
  const main = {
    enabled: true,
    ambientProgramReplies: true,
    mentionReplies: true,
    generalMentionChat: true,
    ticketsEnabled: false,
    helperEscalationEnabled: false,
  };
  const engaged = { engage: true, intent: "support_question", error: null };
  const chatter = { engage: false, intent: "unrelated_chatter", error: null };
  assert.equal(f({ program, role: "help", settings: help, engagement: engaged, grounded: true }), "reply");
  assert.equal(
    f({ program, role: "help", settings: { ...help, aiReplies: false }, engagement: engaged, grounded: true }),
    "ticket+helper",
  );
  assert.equal(f({ program, role: "help", settings: help, engagement: engaged, grounded: false }), "ticket+helper");
  assert.equal(
    f({
      program: { ...program, ticketsEnabled: false },
      role: "help",
      settings: { ...help, ticketsEnabled: false },
      engagement: engaged,
      grounded: false,
    }),
    "silence",
  );
  assert.equal(f({ program, role: "help", settings: help, engagement: chatter, grounded: false }), "silence");
  assert.equal(
    f({
      program,
      role: "main",
      settings: main,
      engagement: { ...engaged, intent: "direct_program_question" },
      grounded: true,
    }),
    "reply",
  );
  assert.equal(
    f({
      program,
      role: "main",
      settings: { ...main, ambientProgramReplies: false },
      engagement: engaged,
      grounded: true,
    }),
    "silence",
  );
  assert.equal(f({ program, role: "main", settings: main, engagement: engaged, grounded: false }), "silence");
  assert.equal(
    f({ program, role: "main", settings: main, addressed: true, engagement: engaged, grounded: false }),
    "uncertain",
  );
  assert.equal(
    f({
      program,
      role: "organizer",
      settings: { ...main, ambientProgramReplies: false },
      engagement: engaged,
      grounded: true,
    }),
    "silence",
  );
});

test("internalTestQuestion probes retrieval+grounding with no Slack or ticket side effects", async () => {
  const programs = require("../programs");
  const knowledge = require("../knowledge");
  const lookup = require("../lookup");
  api.internalProgramSync("dash-probe", {
    name: "Probe",
    workspaceId: "TW-DASH",
    claimedBy: "U-dash-org",
    programChannels: [],
  });
  const ticketsBefore = db.handle().query("SELECT COUNT(*) as count FROM tickets").get().count;
  const cacheBefore = db.handle().query("SELECT COUNT(*) as count FROM answer_cache").get().count;

  const engagementMod = require("../pipeline/engagement");
  const origClassify = engagementMod.classify;
  engagementMod.classify = async () => ({ engage: true, intent: "support_question", error: null, source: "jev" });
  const origContext = knowledge.getContext;
  const origLookup = lookup.lookupAnswer;
  knowledge.getContext = () => "### Probe Docs\nTest widgets cost five credits.";
  lookup.lookupAnswer = async () => ({ source: "Probe Docs", answer: "Test widgets cost five credits." });
  try {
    const res = await api.internalTestQuestion("dash-probe", { question: "how much is a test widget?", role: "help" });
    assert.equal(res.ok, true);
    assert.equal(res.role, "help");
    assert.deepEqual(res.sources, ["Probe Docs"]);
    assert.equal(res.grounded, true);
    assert.equal(res.expectedAction, "reply");
    assert.match(res.answerPreview, /five credits/);

    const miss = await api.internalTestQuestion("dash-probe", { question: "how much is a test widget?", role: "main" });
    assert.equal(miss.expectedAction, "reply");

    lookup.lookupAnswer = async () => null;
    const ungrounded = await api.internalTestQuestion("dash-probe", { question: "something obscure", role: "help" });
    assert.equal(ungrounded.grounded, false);
    assert.equal(ungrounded.expectedAction, "ticket+helper");
    assert.equal(ungrounded.answerPreview, null);
  } finally {
    engagementMod.classify = origClassify;
    knowledge.getContext = origContext;
    lookup.lookupAnswer = origLookup;
  }
  const ticketsAfter = db.handle().query("SELECT COUNT(*) as count FROM tickets").get().count;
  assert.equal(ticketsAfter, ticketsBefore, "the probe must never create tickets");
  const cacheAfter = db.handle().query("SELECT COUNT(*) as count FROM answer_cache").get().count;
  assert.equal(cacheAfter, cacheBefore, "the probe must never write answer_cache");
  assert.equal((await api.internalTestQuestion("nope-missing-prog", { question: "hi" })).error, "unknown program");
  assert.match((await api.internalTestQuestion("dash-probe", { question: "  " })).error, /question required/);
});

test("a program may move its own help channel to main without a false conflict", () => {
  const first = api.internalProgramSync("move-prog", {
    name: "Move",
    workspaceId: "TW-MOVE",
    claimedBy: "U-o",
    helpChannel: "C-move-a",
    programChannels: [{ id: "C-move-a", kind: "help" }],
  });
  assert.equal(first.ok, true);
  const moved = api.internalProgramSync("move-prog", {
    name: "Move",
    workspaceId: "TW-MOVE",
    claimedBy: "U-o",
    helpChannel: "C-move-b",
    programChannels: [
      { id: "C-move-b", kind: "help" },
      { id: "C-move-a", kind: "discussion" },
    ],
  });
  assert.equal(moved.error, undefined, moved.error);
  assert.equal(moved.ok, true);
});

test("another program's channel is still a 409", () => {
  const taken = api.internalProgramSync("thief-prog", {
    name: "Thief",
    workspaceId: "TW-MOVE",
    claimedBy: "U-t",
    helpChannel: "C-move-b",
    programChannels: [{ id: "C-move-b", kind: "help" }],
  });
  assert.equal(taken.status, 409);
});

test("editing a queued fact keeps its program; dashboard teach requires a program", () => {
  api.internalProgramSync("edit-prog", { name: "Edit", workspaceId: "TW-EDIT", claimedBy: "U-e", programChannels: [] });
  const id = db.addLearnedFact({
    question: "old q",
    answer: "old a",
    authorId: "U-e",
    status: "pending",
    channel: "C-edit",
    programId: "edit-prog",
  });
  api.queueEdit(id, "new q", "new a");
  const row = db.handle().query("SELECT * FROM learned_facts WHERE question = 'new q'").get();
  assert.equal(row.program_id, "edit-prog");
  assert.equal(row.channel, "C-edit");
  assert.match(api.handleTeach("q", "a", "U-e").error, /programId required/);
  assert.ok(api.handleTeach("q2", "a2", "U-e", "edit-prog"));
});
export {};

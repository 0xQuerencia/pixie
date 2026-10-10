process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");

before(() => {
  db.close();
  db.open(":memory:");
});

test("handleRequest dispatches /internal/v1/* to the API handler, not the static 404 fallback", async () => {
  const savedToken = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "test-serve-token";
  try {
    const serve = require("./serve");
    const req = new Request("http://localhost/internal/v1/health", {
      headers: { Authorization: "Bearer test-serve-token" },
    });
    const res = await serve.handleRequest(req);
    assert.equal(res.status, 200, "a correctly authed internal route must not fall through to the generic 404");
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    if (savedToken === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = savedToken;
  }
});

test("handleRequest still gates /internal/v1/* with the wrong token — dispatch isn't the same as bypassing auth", async () => {
  const savedToken = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "test-serve-token";
  try {
    const serve = require("./serve");
    const req = new Request("http://localhost/internal/v1/health", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const res = await serve.handleRequest(req);
    assert.equal(res.status, 401);
  } finally {
    if (savedToken === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = savedToken;
  }
});

test("an actually unmatched route still falls through to the plain 404", async () => {
  const serve = require("./serve");
  const req = new Request("http://localhost/definitely-not-a-real-route");
  const res = await serve.handleRequest(req);
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.equal(text, "not found");
});

function withToken(tok: string) {
  return { Authorization: `Bearer ${tok}` };
}

test("absent PIXIE_INTERNAL_TOKEN → 404 (not 401/403); bad bearer → 401", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  const serve = require("./serve");
  try {
    delete process.env.PIXIE_INTERNAL_TOKEN;
    const disabled = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("anything") }),
    );
    assert.equal(disabled.status, 404);
    const body = await disabled.json();
    assert.match(body.error, /disabled/);

    process.env.PIXIE_INTERNAL_TOKEN = "char-serve-token";
    const bad = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("wrong") }),
    );
    assert.equal(bad.status, 401);
    const noHeader = await serve.handleRequest(new Request("http://localhost/internal/v1/health"));
    assert.equal(noHeader.status, 401);
    const good = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("char-serve-token") }),
    );
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ok, true);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("dashboard gates — pulse/stream/ask/health need session; writes need admin", async () => {
  const serve = require("./serve");
  const auth = require("./auth");
  const anon = new Request("http://localhost/api/pulse");
  assert.equal((await serve.handleRequest(anon)).status, 401);
  assert.equal((await serve.handleRequest(new Request("http://localhost/api/health"))).status, 401);
  assert.equal(
    (await serve.handleRequest(new Request("http://localhost/api/queue"))).status,
    401,
    "writes without any session are 401, not 403",
  );
  const userTok = auth.signSession("U-serve-plain", "Plain", "user");
  const userHeaders = { Cookie: `${auth.COOKIE_NAME}=${userTok}` };
  assert.equal(
    (await serve.handleRequest(new Request("http://localhost/api/pulse", { headers: userHeaders }))).status,
    200,
  );
  const forbidden = await serve.handleRequest(new Request("http://localhost/api/queue", { headers: userHeaders }));
  assert.ok(
    [403, 200].includes(forbidden.status),
    "non-admin queue read is 403 unless the deployer allowlisted the user",
  );
  const adminTok = auth.signSession("admin", "Admin", "admin");
  const adminHeaders = { Cookie: `${auth.COOKIE_NAME}=${adminTok}` };
  assert.equal(
    (await serve.handleRequest(new Request("http://localhost/api/queue", { headers: adminHeaders }))).status,
    200,
  );
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "char-serve-token-2";
  try {
    const sessOnly = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: adminHeaders }),
    );
    assert.equal(sessOnly.status, 401);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("internal error→status mapping per route family (pinned current values)", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "char-map-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("char-map-token");
  try {
    assert.equal(
      (await serve.handleRequest(new Request("http://localhost/internal/v1/nope", { headers: H }))).status,
      404,
    );
    assert.equal(
      (await serve.handleRequest(new Request("http://localhost/internal/v1/tickets", { headers: H }))).status,
      400,
    );
    api.internalProgramSync("char-map", {
      name: "Map",
      workspaceId: "TW-M",
      claimedBy: "U-map-org",
      programChannels: [],
    });
    const miss = await serve.handleRequest(
      new Request("http://localhost/internal/v1/tickets/999999/claim", {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-map-org" }),
      }),
    );
    assert.equal(miss.status, 400);
    assert.match((await miss.json()).error, /not found/);
    const tid = require("../db").createTicket({
      programId: "char-map",
      workspaceId: "TW-M",
      channel: "C1",
      threadTs: "char-map-1",
      requesterId: "U1",
      question: "q",
    });
    const mm = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/claim`, {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "wrong-prog", actorId: "U-map-org" }),
      }),
    );
    assert.equal(mm.status, 403);
    const denied = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/claim`, {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-stranger-map" }),
      }),
    );
    assert.equal(denied.status, 403);
    const unk = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/frobnicate`, {
        method: "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-map-org" }),
      }),
    );
    assert.equal(unk.status, 400);
    const sweep = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/char-map/retention", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-stranger-map", confirm: true }),
      }),
    );
    assert.equal(sweep.status, 403);
    const malformed = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/Bad_Slug!/x", {
        method: "PUT",
        headers: { ...H, "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );
    assert.ok([400, 404].includes(malformed.status), "malformed bodies must not become 500s");
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("internal responses never leak token/secret fields", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "char-leak-token";
  const serve = require("./serve");
  try {
    const H = withToken("char-leak-token");
    for (const path of ["/internal/v1/health", "/internal/v1/programs"]) {
      const res = await serve.handleRequest(new Request(`http://localhost${path}`, { headers: H }));
      const text = await res.text();
      assert.equal(text.includes("char-leak-token"), false, `${path} must not echo the bearer`);
      assert.equal(/"secret"\s*:/i.test(text), false, `${path} must not carry secret fields`);
      assert.equal(/PIXIE_INTERNAL_TOKEN/.test(text), false);
    }
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("PUT /internal/v1/programs/:id maps a channel conflict to 409 naming the channel", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "dash-serve-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("dash-serve-token");
  try {
    const first = api.internalProgramSync("dash-serve-owner", {
      name: "Owner",
      workspaceId: "TW-DS",
      claimedBy: "U-ds-org",
      helpChannel: "C-ds-help",
      programChannels: [{ id: "C-ds-help", kind: "help" }],
    });
    assert.equal(first.ok, true);
    const res = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/dash-serve-intruder", {
        method: "PUT",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Intruder",
          workspaceId: "TW-DS",
          claimedBy: "U-ds-org",
          programChannels: [{ id: "C-ds-help", kind: "help" }],
        }),
      }),
    );
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /C-ds-help/);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("POST /internal/v1/programs/:id/test-question proxies the probe; unknown program is 404", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "dash-serve-token-2";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("dash-serve-token-2");
  try {
    api.internalProgramSync("dash-serve-probe", {
      name: "Probe",
      workspaceId: "TW-DS",
      claimedBy: "U-ds-org",
      programChannels: [],
    });
    const knowledge = require("../knowledge");
    const lookup = require("../lookup");
    const origContext = knowledge.getContext;
    const origLookup = lookup.lookupAnswer;
    knowledge.getContext = () => "### Probe Docs\nProbe answer text.";
    lookup.lookupAnswer = async () => ({ source: "Probe Docs", answer: "Probe answer text." });
    try {
      const res = await serve.handleRequest(
        new Request("http://localhost/internal/v1/programs/dash-serve-probe/test-question", {
          method: "POST",
          headers: { ...H, "Content-Type": "application/json" },
          body: JSON.stringify({ question: "what is this?", role: "help" }),
        }),
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.sources, ["Probe Docs"]);
      assert.equal(body.grounded, true);
      assert.equal(body.expectedAction, "reply");
    } finally {
      knowledge.getContext = origContext;
      lookup.lookupAnswer = origLookup;
    }
    const missing = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/nope-missing-serve/test-question", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ question: "hi" }),
      }),
    );
    assert.equal(missing.status, 404);
    const empty = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/dash-serve-probe/test-question", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ question: "  " }),
      }),
    );
    assert.equal(empty.status, 400);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("regression: DELETE /internal/v1/macros/:id reads its JSON body (actorId survives)", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "char-del-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("char-del-token");
  try {
    api.internalProgramSync("char-del", {
      name: "Del",
      workspaceId: "TW-D",
      claimedBy: "U-del-org",
      programChannels: [],
    });
    const created = api.internalMacroCreate("char-del", {
      actorId: "U-del-org",
      trigger: "?delpin",
      name: "Del",
      content: "bye {helper}",
    });
    assert.equal(created.ok, true);
    const mid = created.macro.id;
    const denied = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/macros/${mid}`, {
        method: "DELETE",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-del-stranger" }),
      }),
    );
    assert.equal(denied.status, 403);
    const ok = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/macros/${mid}`, {
        method: "DELETE",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-del-org" }),
      }),
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("POST /internal/v1/programs/:id/incidents/manual creates only for a program helper", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "manual-incident-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("manual-incident-token");
  try {
    api.internalProgramSync("manual-route-a", {
      name: "Manual Route A",
      workspaceId: "TW-MRA",
      claimedBy: "U-mra",
      programChannels: [],
    });
    api.internalProgramSync("manual-route-b", {
      name: "Manual Route B",
      workspaceId: "TW-MRB",
      claimedBy: "U-mrb",
      programChannels: [],
    });
    const created = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/manual-route-a/incidents/manual", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "U-mra",
          title: "Manual outage",
          description: "The site is unavailable",
          publicMessage: "We are investigating the outage.",
        }),
      }),
    );
    assert.equal(created.status, 200);
    assert.equal((await created.json()).incident.status, "confirmed");

    const denied = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/manual-route-a/incidents/manual", {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-mrb", title: "Cross-tenant", publicMessage: "nope" }),
      }),
    );
    assert.equal(denied.status, 403);
    assert.equal(api.internalIncidents("manual-route-b", {}).length, 0);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("GET incident detail and affected routes require and enforce programId", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "scoped-incident-token";
  const serve = require("./serve");
  const api = require("./api");
  const incidents = require("../incidents");
  const H = withToken("scoped-incident-token");
  try {
    api.internalProgramSync("read-route-a", {
      name: "Read route A",
      workspaceId: "TW-RRA",
      claimedBy: "U-rra",
      programChannels: [],
    });
    api.internalProgramSync("read-route-b", {
      name: "Read route B",
      workspaceId: "TW-RRB",
      claimedBy: "U-rrb",
      programChannels: [],
    });
    const created = api.internalIncidentCreate("read-route-a", { actorId: "U-rra", title: "Route outage" });
    const incidentId = created.incident.id;
    incidents.recordAffectedReport({
      incidentId,
      programId: "read-route-a",
      requesterId: "U-route-requester",
      channel: "C-route",
      threadTs: "route-thread",
    });

    const missing = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/incidents/${incidentId}`, { headers: H }),
    );
    assert.equal(missing.status, 400);

    const detail = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/incidents/${incidentId}?programId=read-route-a`, { headers: H }),
    );
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).incident.program_id, "read-route-a");

    const foreign = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/incidents/${incidentId}?programId=read-route-b`, { headers: H }),
    );
    assert.equal(foreign.status, 404);

    const affected = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/incidents/${incidentId}/affected?programId=read-route-a`, {
        headers: H,
      }),
    );
    assert.equal(affected.status, 200);
    assert.equal((await affected.json()).total, 1);

    const foreignAffected = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/incidents/${incidentId}/affected?programId=read-route-b`, {
        headers: H,
      }),
    );
    assert.equal(foreignAffected.status, 404);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("legacy ticket detail requires a program scope even with the shared bearer", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "legacy-detail-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("legacy-detail-token");
  try {
    api.internalProgramSync("legacy-detail", {
      name: "Legacy detail",
      workspaceId: "TW-LD",
      claimedBy: "U-legacy-owner",
      programChannels: [],
    });
    const tid = db.createTicket({
      programId: "legacy-detail",
      workspaceId: "TW-LD",
      channel: "C-LD",
      threadTs: "legacy-detail-thread",
      requesterId: "U-legacy-requester",
      question: "legacy question",
    });

    const missing = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}`, { headers: H }),
    );
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /programId required/);

    const wrong = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}?programId=other-program`, { headers: H }),
    );
    assert.equal(wrong.status, 403);

    const valid = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}?programId=legacy-detail`, { headers: H }),
    );
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).ticket.program_id, "legacy-detail");
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});
export {};

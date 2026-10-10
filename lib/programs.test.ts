process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");

db.open(":memory:");

function withEnvPrograms(value: string | undefined, fn: () => void) {
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  if (value === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = value;
  programs.invalidate();
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
}

test("an absent configuration does not invent a program", () => {
  withEnvPrograms(undefined, () => {
    assert.equal(programs.get("missing-program"), null);
    assert.equal(programs.forChannel("C_UNKNOWN").id, "shared");
    assert.equal(programs.shared().sources.length, 0);
  });
});

test("scope defaults to any and survives a database round trip", () => {
  programs.saveProgram({ id: "acme", name: "Acme", scope: "program" });
  programs.invalidate();
  assert.equal(programs.scope("acme"), "program");
  assert.equal(programs.isProgramScoped(programs.get("acme")), true);

  programs.saveProgram({ ...programs.get("acme"), scope: "any" });
  assert.equal(programs.scope("acme"), "any");
});

test("PIXIE_PROGRAMS_JSON supplies neutral programs and takes precedence", () => {
  withEnvPrograms(
    JSON.stringify([
      {
        id: "demo",
        name: "Demo",
        helpChannel: "C_DEMO",
        channels: ["C_DEMO", "C_MAIN"],
        scope: "program",
        posture: "passive",
        sources: [{ name: "Demo docs", type: "url", url: "https://example.invalid/docs" }],
      },
    ]),
    () => {
      const demo = programs.get("demo");
      assert.equal(demo.name, "Demo");
      assert.equal(demo.helpChannel, "C_DEMO");
      assert.equal(programs.forChannel("C_MAIN").id, "demo");
      assert.equal(programs.isHelpChannel("C_DEMO"), true);
      assert.ok(programs.all().some((p: { id: string }) => p.id === "demo"));
    },
  );
});

test("wrapped and malformed environment configuration are handled safely", () => {
  withEnvPrograms(JSON.stringify({ programs: [{ id: "beta", name: "Beta" }] }), () => {
    assert.equal(programs.get("beta").name, "Beta");
  });
  withEnvPrograms('[{"id":"demo"', () => {
    assert.equal(programs.get("demo"), null);
  });
});

test("source sharing is opt in and normalization keeps service flags", () => {
  withEnvPrograms(
    JSON.stringify([
      { id: "cfg-acme", name: "Acme", sharedSources: true },
      { id: "cfg-demo", name: "Demo", sharedSources: false, incidentMode: "TRACK_ONLY", publicTicketsEnabled: false },
    ]),
    () => {
      assert.equal(programs.get("cfg-acme").sharedSources, true);
      assert.equal(programs.get("cfg-demo").sharedSources, false);
      assert.equal(programs.get("cfg-demo").incidentMode, "TRACK_ONLY");
      assert.equal(programs.get("cfg-demo").publicTicketsEnabled, false);
    },
  );
});

test("legacy learning keys remain readable without changing review-safe runtime behavior", () => {
  withEnvPrograms(
    JSON.stringify([
      { id: "legacy-auto-config", name: "Legacy Auto", learning: "auto" },
      { id: "legacy-mode-config", name: "Legacy Mode", learning_mode: "auto" },
      { id: "review-config", name: "Review", learning: "review" },
    ]),
    () => {
      assert.equal(programs.get("legacy-auto-config").learning, "auto");
      assert.equal(programs.get("legacy-mode-config").learning, "auto");
      assert.equal(programs.get("review-config").learning, "review");
    },
  );

  db.saveProgram({ id: "legacy-auto-db", name: "Legacy DB", learning: "auto" });
  programs.invalidate();
  assert.equal(programs.get("legacy-auto-db").learning, "auto");
});

test("workspace channel claims override matching channel configuration", () => {
  withEnvPrograms(
    JSON.stringify([
      { id: "acme", name: "Acme", helpChannel: "C_SHARED", channels: ["C_SHARED"] },
      { id: "demo", name: "Demo", helpChannel: "C_OTHER", channels: ["C_OTHER"] },
    ]),
    () => {
      db.claimProgramChannel({ workspaceId: "T_DEMO", channelId: "C_SHARED", programId: "demo", kind: "help" });
      try {
        assert.equal(programs.forChannel("C_SHARED", "T_DEMO").id, "demo");
        assert.equal(programs.forChannel("C_SHARED", "T_OTHER").id, "acme");
      } finally {
        db.releaseProgramChannel({ workspaceId: "T_DEMO", channelId: "C_SHARED" });
      }
    },
  );
});

export {};

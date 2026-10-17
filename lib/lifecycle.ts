import db = require("./db");
import docs = require("./programDocs");
import programs = require("./programs");
import audit = require("./audit");
import type { ProgramLifecycle } from "./types";

const LIFECYCLES = ["draft", "testing", "approved", "active", "paused", "archived"] as const;

type Lifecycle = (typeof LIFECYCLES)[number];

interface TransitionResult {
  ok: boolean;
  lifecycle: Lifecycle;
  blockers: string[];
}

function valid(value: unknown): value is Lifecycle {
  return typeof value === "string" && LIFECYCLES.includes(value as Lifecycle);
}

function current(programId: string): Lifecycle | null {
  const row = db
    .handle()
    .query<{ lifecycle: string | null; status: string | null }, [string]>(
      "SELECT lifecycle, status FROM programs WHERE id = ?",
    )
    .get(programId);
  const value = row?.lifecycle;
  if (valid(value)) return value;
  if (row?.status === "live") return "active";
  if (row?.status === "paused") return "paused";
  return programs.get(programId) ? "active" : null;
}

function set(programId: string, lifecycle: Lifecycle): boolean {
  const result = db
    .handle()
    .query("UPDATE programs SET lifecycle = ?, updated_at = ? WHERE id = ?")
    .run(lifecycle, Date.now(), programId);
  programs.invalidate?.();
  return result.changes > 0;
}

function ownerOrAdmin(programId: string, actor: string | null): boolean {
  if (!actor) return false;
  try {
    if (require("./config").isAdmin(actor)) return true;
  } catch (_) {}
  const helper = (db.listHelpers(programId, true) || []).find(
    (item: Record<string, unknown>) => item.user_id === actor,
  );
  return Boolean(helper && ["owner", "admin", "organizer"].includes(String(helper.role)));
}

function blockersFor(programId: string, from: Lifecycle, to: Lifecycle, actor: string | null): string[] {
  const blockers: string[] = [];
  if (from === to) return blockers;
  if (from !== "draft" && !ownerOrAdmin(programId, actor)) {
    blockers.push(`${from}->${to} requires a program owner or admin`);
    return blockers;
  }
  if (to === "archived") return blockers;
  const allowed =
    (from === "draft" && to === "testing") ||
    (from === "testing" && to === "approved") ||
    (from === "approved" && to === "active") ||
    (from === "active" && to === "paused") ||
    (from === "paused" && to === "active");
  if (!allowed) {
    blockers.push(`transition ${from}->${to} is not allowed`);
    return blockers;
  }

  if (from === "draft" && to === "testing") {
    const program = programs.get(programId);
    const hasSource = Boolean(program?.sources?.length) || docs.sourceStates(programId).some((state) => state.ok === 1);
    if (docs.docSections(programId).length === 0 && !hasSource)
      blockers.push("at least one active official doc or source is required");
  }
  if (from === "testing" && to === "approved") {
    if (!ownerOrAdmin(programId, actor)) blockers.push("testing->approved requires a program owner or admin");
    const run = db
      .handle()
      .query<{ status: string; content_hash: string }, [string]>(
        "SELECT status, content_hash FROM program_eval_runs WHERE program_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get(programId);
    if (!run || run.status !== "passed") blockers.push("latest eval run must be passed");
    if (!run || run.content_hash !== docs.contentHash(programId)) blockers.push("latest eval run is stale");
  }
  if (from === "approved" && to === "active") {
    const claims = db.listProgramChannels(programId);
    if (!claims.some((claim: Record<string, unknown>) => claim.kind === "help"))
      blockers.push("a mapped help channel is required");
    const ticketing = programs.get(programId)?.ticketsEnabled !== false;
    if (ticketing && !claims.some((claim: Record<string, unknown>) => claim.kind === "organizer")) {
      blockers.push("a mapped organizer channel is required while tickets are enabled");
    }
    if (db.listHelpers(programId, true).length < 1) blockers.push("at least one active helper is required");
  }
  return blockers;
}

function transition(programId: string, to: string, actor: string | null = null): TransitionResult {
  const from = current(programId);
  if (!from) return { ok: false, lifecycle: "draft", blockers: ["unknown program"] };
  if (!valid(to)) return { ok: false, lifecycle: from, blockers: [`invalid lifecycle ${to}`] };
  const blockers = blockersFor(programId, from, to, actor);
  if (blockers.length) return { ok: false, lifecycle: from, blockers };
  if (from === to) return { ok: true, lifecycle: from, blockers: [] };

  if (to === "archived") {
    for (const claim of db.listProgramChannels(programId)) {
      db.releaseProgramChannel({ workspaceId: claim.workspace_id, channelId: claim.channel_id, programId });
    }
  }
  if (!set(programId, to)) return { ok: false, lifecycle: from, blockers: ["program is not persisted"] };
  if (to === "archived") {
    db.handle()
      .query(
        "UPDATE programs SET posture = 'muted', support_active = 0, help_channel = NULL, channels = '[]', updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), programId);
  }
  audit.record({
    programId,
    actorId: actor,
    action: "program.lifecycle.transition",
    entityType: "program",
    entityId: programId,
    metadata: { from, to },
  });
  return { ok: true, lifecycle: to, blockers: [] };
}

function contentChanged(programId: string, actor: string | null = null) {
  const lifecycle = current(programId);
  db.handle().query("UPDATE programs SET live_test = 'pending', live_test_note = NULL WHERE id = ?").run(programId);
  if (lifecycle === "approved") {
    set(programId, "testing");
    audit.record({
      programId,
      actorId: actor,
      action: "program.lifecycle.content_changed",
      entityType: "program",
      entityId: programId,
      metadata: { from: "approved", to: "testing" },
    });
    return "testing" as ProgramLifecycle;
  }
  return lifecycle;
}

const LIVE_TEST_STATES = ["pending", "passed", "failed"] as const;

function setLiveTest(programId: string, status: string, actor: string | null, note: string | null = null) {
  if (!current(programId)) return { ok: false, error: "unknown program" };
  if (!LIVE_TEST_STATES.includes(status as (typeof LIVE_TEST_STATES)[number]))
    return { ok: false, error: "status must be pending, passed or failed" };
  if (!ownerOrAdmin(programId, actor))
    return { ok: false, error: "live test status requires a program owner or admin" };
  db.handle()
    .query("UPDATE programs SET live_test = ?, live_test_note = ?, updated_at = ? WHERE id = ?")
    .run(status, note ? String(note).slice(0, 500) : null, Date.now(), programId);
  programs.invalidate?.();
  return { ok: true, status };
}

export = { LIFECYCLES, LIVE_TEST_STATES, transition, setLiveTest, contentChanged, current };

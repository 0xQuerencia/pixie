import { describe, expect, test } from "bun:test";
// @ts-expect-error plain module shared with the adoption script
import { buildAdoptionPlan, channelClaims } from "./programAdoptionPlan.mjs";

const OWNER_HCA = "ident!example1";
const core = {
  id: "demo",
  name: "Demo",
  workspaceId: "T0WORKSPACE",
  helpChannel: "C0HELP12345",
  organizerChannel: "C0ORG123456",
  channels: ["C0HELP12345", "C0ORG123456", "C0MAIN12345"],
  lifecycle: "active",
  ticketsEnabled: true,
  sources: [
    { name: "Site", type: "url", url: "https://example.com" },
    { name: "Doc", type: "text", content: "x", docId: 4 },
  ],
};
const helpers = [
  { user_id: "U0OWNER1234", role: "owner", helper_source: "creator", active: 1 },
  { user_id: "U0HELPER123", role: "helper", helper_source: "manual", active: 1, ping_eligible: 0 },
  { user_id: "U0GONE12345", role: "helper", helper_source: "manual", active: 0 },
  { user_id: "not-a-slack-id", role: "helper", active: 1 },
];

describe("buildAdoptionPlan", () => {
  test("maps Core channels, helpers and settings onto Wizard rows", () => {
    const plan = buildAdoptionPlan(core, helpers, { ownerHcaId: OWNER_HCA });
    expect(plan.blockers).toEqual([]);
    expect(plan.channels).toEqual([
      { channel_id: "C0HELP12345", kind: "help" },
      { channel_id: "C0ORG123456", kind: "organizer" },
      { channel_id: "C0MAIN12345", kind: "discussion" },
    ]);
    expect(plan.helpers.map((h: { slack_user_id: string }) => h.slack_user_id)).toEqual(["U0OWNER1234", "U0HELPER123"]);
    expect(plan.helpers[1].eligible_for_pings).toBe(false);
    expect(plan.program.owner_slack_id).toBe("U0OWNER1234");
    expect(plan.program.lifecycle).toBe("active");
    expect(plan.program.sources).toEqual([{ name: "Site", type: "url", url: "https://example.com" }]);
  });

  test("never invents an owner: a missing owner or workspace blocks the plan", () => {
    const noOwner = buildAdoptionPlan(core, helpers, {});
    expect(noOwner.blockers.join(" ")).toMatch(/no owner/);
    const noWorkspace = buildAdoptionPlan({ ...core, workspaceId: undefined }, helpers, { ownerHcaId: OWNER_HCA });
    expect(noWorkspace.blockers.join(" ")).toMatch(/no workspace/);
    expect(buildAdoptionPlan({ ...core, workspaceId: undefined }, helpers, { ownerHcaId: OWNER_HCA, workspaceId: "T0OTHER" }).blockers).toEqual([]);
  });

  test("a program without a Slack channel is adoptable but flagged as not activatable", () => {
    const plan = buildAdoptionPlan({ id: "twisted", name: "Twisted", workspaceId: "T0W", ticketsEnabled: false, channels: [], lifecycle: "draft" }, [], { ownerHcaId: OWNER_HCA });
    expect(plan.blockers).toEqual([]);
    expect(plan.channels).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/cannot be activated until one is/);
  });

  test("the organizer channel is only expected while tickets are enabled", () => {
    const base = { id: "p", name: "P", workspaceId: "T0W", helpChannel: "C0HELP12345", channels: ["C0HELP12345"] };
    const off = buildAdoptionPlan({ ...base, ticketsEnabled: false }, helpers, { ownerHcaId: OWNER_HCA });
    expect(off.warnings.join(" ")).not.toMatch(/organizer channel/);
    const on = buildAdoptionPlan({ ...base, ticketsEnabled: true }, helpers, { ownerHcaId: OWNER_HCA });
    expect(on.warnings.join(" ")).toMatch(/organizer channel/);
  });

  test("an explicit owner Slack id is used and must look like one", () => {
    const plan = buildAdoptionPlan(core, [], { ownerHcaId: OWNER_HCA, ownerSlackId: "U0EXPLICIT1" });
    expect(plan.helpers).toEqual([{ slack_user_id: "U0EXPLICIT1", role: "owner", helper_source: "creator", eligible_for_pings: true }]);
    expect(buildAdoptionPlan(core, [], { ownerHcaId: OWNER_HCA, ownerSlackId: "nope" }).blockers.join(" ")).toMatch(/not a Slack user id/);
  });

  test("channel claims ignore malformed ids and duplicates", () => {
    expect(channelClaims({ helpChannel: "C0HELP12345", organizerChannel: "bad", channels: ["C0HELP12345", "C0HELP12345", "C0OTHER1234"] })).toEqual([
      { channel_id: "C0HELP12345", kind: "help" },
      { channel_id: "C0OTHER1234", kind: "discussion" },
    ]);
  });
});

describe("applyAdoptionPlan", () => {
  async function setup() {
    const { createTestDb } = await import("./pgTestDb");
    // @ts-expect-error plain module shared with the adoption script
    const { applyAdoptionPlan } = await import("./programAdoptionPlan.mjs");
    return { db: createTestDb(), applyAdoptionPlan };
  }

  test("writes the program, channel claims and helpers, and is idempotent", async () => {
    const { db, applyAdoptionPlan } = await setup();
    const plan = buildAdoptionPlan(core, helpers, { ownerHcaId: OWNER_HCA });
    await db.withTransaction((client) => applyAdoptionPlan(client, plan));
    await db.withTransaction((client) => applyAdoptionPlan(client, plan));
    expect((await db.query("select id, owner_hca_id, lifecycle, core_sync_state from hosted_programs")).rows).toEqual([
      { id: "demo", owner_hca_id: OWNER_HCA, lifecycle: "active", core_sync_state: "synced" },
    ]);
    expect((await db.query("select count(*)::int as n from hosted_program_channels")).rows[0].n).toBe(3);
    expect((await db.query("select count(*)::int as n from hosted_program_helpers where active")).rows[0].n).toBe(2);
    expect((await db.query("select count(*)::int as n from hosted_audit_events where action = 'program.adopted'")).rows[0].n).toBe(2);
  });

  test("re-adopting never changes the recorded owner", async () => {
    const { db, applyAdoptionPlan } = await setup();
    await db.withTransaction((client) => applyAdoptionPlan(client, buildAdoptionPlan(core, helpers, { ownerHcaId: OWNER_HCA })));
    await db.withTransaction((client) => applyAdoptionPlan(client, buildAdoptionPlan(core, helpers, { ownerHcaId: "ident!someone-else" })));
    expect((await db.query("select owner_hca_id from hosted_programs where id = 'demo'")).rows[0].owner_hca_id).toBe(OWNER_HCA);
  });

  test("a channel already claimed by another program aborts everything", async () => {
    const { db, applyAdoptionPlan } = await setup();
    const other = { ...core, id: "other", name: "Other", channels: ["C0HELP12345"], helpChannel: "C0HELP12345", organizerChannel: null };
    await db.withTransaction((client) => applyAdoptionPlan(client, buildAdoptionPlan(other, [], { ownerHcaId: OWNER_HCA })));
    await expect(db.withTransaction((client) => applyAdoptionPlan(client, buildAdoptionPlan(core, helpers, { ownerHcaId: OWNER_HCA })))).rejects.toThrow(/already claimed by another program/);
    expect((await db.query("select count(*)::int as n from hosted_programs")).rows[0].n).toBe(1);
  });
});

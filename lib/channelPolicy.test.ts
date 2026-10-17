process.env.PIXIE_DB_PATH = ":memory:";
export {};

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const policy = require("./channelPolicy");

before(() => {
  db.close();
  db.open(":memory:");
});

test("production roles require program claims and active lifecycle", () => {
  programs.saveProgram({
    id: "policy-a",
    name: "Policy A",
    lifecycle: "active",
    helpChannel: "C-POLICY-HELP",
    channels: ["C-POLICY-MAIN"],
  });
  db.claimProgramChannel({ workspaceId: "T-POLICY", channelId: "C-POLICY-HELP", programId: "policy-a", kind: "help" });
  db.claimProgramChannel({
    workspaceId: "T-POLICY",
    channelId: "C-POLICY-MAIN",
    programId: "policy-a",
    kind: "discussion",
  });

  assert.equal(policy.resolve("C-POLICY-HELP", "T-POLICY").role, "help");
  assert.equal(policy.resolve("C-POLICY-MAIN", "T-POLICY").role, "main");
  assert.equal(policy.resolve("C-POLICY-UNCLAIMED", "T-POLICY").role, "none");

  db.handle().query("UPDATE programs SET lifecycle = 'draft' WHERE id = ?").run("policy-a");
  programs.invalidate();
  assert.equal(policy.resolve("C-POLICY-HELP", "T-POLICY").settings.enabled, false);
});

test("global FAQ and help settings do not create a production role", () => {
  const config = require("./config").config;
  const savedFaq = config.slack.faqChannels;
  const savedHelp = config.slack.helpChannel;
  config.slack.faqChannels = ["C-LEGACY-FAQ"];
  config.slack.helpChannel = "C-LEGACY-HELP";
  programs.invalidate();
  try {
    assert.equal(policy.resolve("C-LEGACY-FAQ", "T-LEGACY").role, "none");
    assert.equal(policy.resolve("C-LEGACY-HELP", "T-LEGACY").role, "none");
  } finally {
    config.slack.faqChannels = savedFaq;
    config.slack.helpChannel = savedHelp;
    programs.invalidate();
  }
});

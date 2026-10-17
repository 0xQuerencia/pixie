const { App } = require("@slack/bolt");
const { config, validate, resolveBotUserId } = require("./lib/config");
const knowledge = require("./lib/knowledge");
const handlers = require("./lib/handlers");
const commands = require("./lib/commands");
const respond = require("./lib/respond");
const warm = require("./lib/warm");
const report = require("./lib/report");
const web = require("./lib/web/serve");
const db = require("./lib/db");
const log = require("./lib/log");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KEEPALIVE_INTERVAL_MS = 60 * 1000;

function startKeepAlive() {
  return setInterval(() => {
    const key =
      config.zenApiKeys?.[0] ||
      (typeof config.answer.apiKey === "function" ? config.answer.apiKey() : config.answer.apiKey);
    fetch(`${config.answer.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    }).catch((e) => log.debug("keepalive", `ping failed: ${errorText(e)}`));
  }, KEEPALIVE_INTERVAL_MS);
}

async function startBot() {
  validate({ needsSlack: true });
  db.open();
  require("./lib/draftSandbox").loadPersisted();
  try {
    require("./lib/knowledge").loadDraftPersisted();
  } catch (e) {
    log.debug("draft", `draft index rebuild failed: ${errorText(e)}`);
  }
  db.startSweeper();

  const roles = require("./lib/channelPolicy").validate();
  if (!roles.ok) {
    for (const e of roles.errors) log.error("config", `channel role conflict: ${errorText(e)}`);
    throw new Error(`channel role configuration invalid (${roles.errors.length} conflict(s))`);
  }

  try {
    const channelPolicy = require("./lib/channelPolicy");
    const facts = db.assignUnownedLearnedFacts((channel: string | null) => {
      if (!channel) return null;
      const r = channelPolicy.resolve(channel);
      return r.role === "none" ? null : r.program?.id || null;
    });
    if (facts.unowned)
      log.info(
        "knowledge",
        `legacy learned facts: ${facts.assigned} assigned to their channel's program, ${facts.remaining} left unowned (served to no program)`,
      );
  } catch (e) {
    log.warn("knowledge", `legacy learned-fact ownership pass failed: ${errorText(e)}`);
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  app.event("message", handlers.onMessage);
  app.event("app_mention", handlers.onAppMention);
  app.event("reaction_added", handlers.onReactionAdded);
  app.event("reaction_removed", handlers.onReactionRemoved);
  commands.register(app);

  app.error(async (error: Error) => {
    log.error("bolt", error.message);
  });

  knowledge
    .refreshCorpus()
    .then(() => warm.start())
    .catch((e: unknown) => log.error("knowledge", "initial corpus build failed:", errorText(e)));
  knowledge.startAutoRefresh(config.refreshIntervalMin);
  startKeepAlive();
  report.start(app.client);
  try {
    require("./lib/sla").startSlaLoop(app.client);
  } catch (e) {
    log.error("sla", "loop failed to start:", errorText(e));
  }
  try {
    require("./lib/radar").startRadarLoop();
  } catch (e) {
    log.error("radar", "loop failed to start:", errorText(e));
  }

  const webServer = web.start();
  if (webServer) {
    const api = require("./lib/web/api");
    api.setSlackClient(app.client);
  }

  await app.start();
  const botUserId = await resolveBotUserId(app.client);
  log.info("bot", `connected via Socket Mode as ${botUserId}`);

  try {
    const programs = require("./lib/programs");
    const channelList = programs.getChannelsList();
    for (const item of channelList) {
      if (item.channelId && item.channelId.startsWith("C")) {
        await app.client.conversations.join({ channel: item.channelId }).catch((e: unknown) => {
          log.debug("bot", `could not auto-join channel ${item.channelId}: ${errorText(e)}`);
        });
      }
    }
  } catch (e) {
    log.debug("bot", `auto-join error: ${errorText(e)}`);
  }
  try {
    require("./lib/resolutionWatcher").start(app.client);
  } catch (e) {
    log.error("resolution", "watcher failed to start:", errorText(e));
  }
  try {
    require("./lib/ticketBackfill").start(app.client);
  } catch (e) {
    log.error("ticketBackfill", "history import failed to start:", errorText(e));
  }
}

async function runAskCli(question: string): Promise<void> {
  validate({ needsSlack: false });
  db.open();
  await knowledge.refreshCorpus();

  const result = await respond.answerOrChat(question, "");
  if (result?.answer) {
    console.log(`[pixie] source: ${result.source || "(conversational — not in docs)"}`);
    console.log(`[pixie] answer: ${result.answer}`);
    return;
  }

  console.log(`[pixie] would show the fallback: "${respond.MENTION_FALLBACK}"`);
}

function main() {
  process.on("unhandledRejection", (reason) => {
    log.error("process", "unhandled rejection:", reason instanceof Error ? reason.message : reason);
  });

  if (require("./lib/maintenance").enabled()) {
    require("./lib/maintenance").run();
    return;
  }

  const askIdx = process.argv.indexOf("--ask");
  if (askIdx !== -1) {
    const question = process.argv[askIdx + 1];
    if (!question) {
      console.error('Usage: bun index.ts --ask "<question>"');
      process.exit(1);
    }
    runAskCli(question)
      .then(() => process.exit(0))
      .catch((e) => {
        console.error("[pixie] --ask failed:", errorText(e));
        process.exit(1);
      });
    return;
  }

  startBot().catch((e) => {
    console.error(`[pixie] failed to start: ${errorText(e)}`);
    process.exit(1);
  });
}

main();

export {};

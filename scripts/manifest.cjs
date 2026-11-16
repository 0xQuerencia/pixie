// Prints the Slack app manifest for THIS deployment, so the app you create in
// Slack advertises exactly the commands the bot listens for.
//
//   bun run scripts/manifest.js
//   PIXIE_BOT_NAME="Sol" PIXIE_BOT_SLUG=sol bun run scripts/manifest.js
//
// Paste the output into api.slack.com/apps → Create New App → From a manifest.
//
// Why generate it rather than write it out once: command names come from
// PIXIE_BOT_SLUG (see lib/brand.js). Hand-editing a manifest is how you end up
// with an app advertising /sol-teach while the process listens for /pixie-teach —
// a failure with no error anywhere, the command just silently does nothing.
const brand = require("../lib/brand");

// Everything the bot actually calls. Missing one of these produces a runtime
// Slack error on whichever feature needed it, usually much later.
const BOT_SCOPES = [
  "chat:write",
  // Lets the shared hosted app send as a program's support identity
  // (username/icon_url via lib/slackMessages.js). Without it, branding is
  // rejected and messages still send as plain Pixie — the fallback path.
  "chat:write.customize",
  "channels:history",
  "groups:history",
  "channels:join",
  "app_mentions:read",
  "reactions:read",
  "reactions:write",
  "commands",
  "im:history",
  "im:write",
  "channels:read",
  "groups:read",
  "files:read",
];

const BOT_EVENTS = [
  "message.channels",
  "message.groups",
  "message.im",
  "app_mention",
  "reaction_added",
  "reaction_removed",
  "app_home_opened",
  "member_joined_channel",
];

// Suffixes, not full names — must stay in step with lib/commands.js register().
// null is the bare ask command.
const COMMANDS = [
  [null, "Private answer — help without cluttering the channel", "[question]"],
  ["check", "Check GitHub repository readiness for program submission", "<github_repo_url>"],
  ["sources", "What's loaded and when it last refreshed"],
  ["stats", "Answer rate, cache hits, feedback, latency"],
  ["gaps", "Top questions the docs didn't cover"],
  ["report", "The weekly report now", "[last]"],
  ["teach", "Teach an answer directly", "<question> :: <answer>"],
  ["pending", "Captured answers awaiting review"],
  ["approve", "Start using a captured answer", "<n>"],
  ["forget", "Drop answer(s) by id, range, pending, or all", "<target>"],
  ["reload", "Re-fetch the docs and clear the cache, no restart"],
  ["program", "Manage program channels and posture", "[list|add|set|remove]"],
];

function manifest() {
  const name = brand.name();

  return {
    display_information: {
      name,
      description: "Answers questions from your docs, right in Slack.",
      background_color: process.env.PIXIE_BRAND_COLOR || "#23352b",
    },
    features: {
      bot_user: { display_name: name, always_online: true },
      slash_commands: COMMANDS.map(([suffix, description, usage_hint]) => ({
        command: brand.cmd(suffix || ""),
        description,
        ...(usage_hint ? { usage_hint } : {}),
        should_escape: false,
      })),
      shortcuts: [
        {
          name: `Teach ${name}`.slice(0, 24),
          type: "message",
          callback_id: brand.id("teach_thread"),
          description: "Capture this thread as a taught answer for review",
        },
      ],
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: BOT_EVENTS },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      // The bot listens on no port — it dials out to Slack. This must stay true.
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(manifest(), null, 2)}\n`);
}

module.exports = { manifest, BOT_SCOPES, BOT_EVENTS, COMMANDS };

import path = require("node:path");
import db = require("../lib/db");
import helperRestore = require("../lib/helperRestore");

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const archive = value("archive");
if (!archive) {
  console.error("usage: bun scripts/program-restore-helpers.ts --archive <archive.db> [--program id] [--execute]");
  process.exit(2);
}
const live = path.resolve(process.env.PIXIE_DB_PATH || path.join(__dirname, "..", "pixie.db"));
if (path.resolve(archive) === live) {
  console.error("refusing: the archive and the live database are the same file");
  process.exit(2);
}

db.open();
const execute = args.includes("--execute");
const results = helperRestore.restore(path.resolve(archive), { program: value("program") || null, execute });
for (const row of results) {
  const state = row.skipped ? `skipped (${row.skipped})` : execute ? "restored" : "would restore";
  console.log(`${row.programId}: ${state} helpers=${row.helpers} expertise_rows=${row.expertise}`);
}
if (!execute)
  console.log(
    "dry run: add --execute to apply. Restored helpers are only matched by program id; no program is activated.",
  );

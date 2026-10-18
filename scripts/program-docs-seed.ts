// Syncs a private docs tree (<root>/<id>/docs/*.md) into program_docs only. No program rows, channels, lifecycle or eval cases are touched.
//   bun scripts/program-docs-seed.ts --db PATH --docs-root DIR --program pixl --program twisted [--apply]
import path = require("node:path");
import db = require("../lib/db");
import programs = require("../lib/programs");
import programSeed = require("../lib/programSeed");
import knowledge = require("../lib/knowledge");

const ALLOWED = new Set(["pixl", "twisted", "back-to-basics"]);

function parseArgs(argv: string[]) {
  const options = { dbPath: process.env.PIXIE_DB_PATH || "", root: "", ids: [] as string[], apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") options.dbPath = argv[++index] || "";
    else if (arg === "--docs-root") options.root = argv[++index] || "";
    else if (arg === "--program") options.ids.push(argv[++index] || "");
    else if (arg === "--apply") options.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.dbPath) throw new Error("--db or PIXIE_DB_PATH required");
  if (!options.root) throw new Error("--docs-root required");
  if (!options.ids.length) throw new Error("at least one --program required");
  for (const id of options.ids) if (!ALLOWED.has(id)) throw new Error(`program not in this rollout: ${id}`);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  db.open(options.dbPath);
  for (const id of options.ids) {
    if (!programs.get(id)) throw new Error(`${id}: not in Core; sync it from the Wizard first`);
    const errors: string[] = [];
    const docs = programSeed.loadDocs(path.join(options.root, id), errors);
    for (const doc of docs) {
      const reason = programSeed.unsafeDocReason(doc);
      if (reason) errors.push(reason);
    }
    if (errors.length || !docs.length) throw new Error(`${id}: ${errors.join("; ") || "no docs found"}`);
    const counts = programSeed.syncDocs({ id, docs }, !options.apply);
    const chunks = options.apply ? knowledge.getIndex(id).docs.length : null;
    console.log(
      `${options.apply ? "applied" : "dry run"} ${id}: files=${docs.length} docs=${JSON.stringify(counts)} chunks=${chunks}`,
    );
  }
  if (!options.apply) console.log("dry run only: re-run with --apply");
}

main();

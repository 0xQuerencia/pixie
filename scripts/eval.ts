import db = require("../lib/db");
import programs = require("../lib/programs");
import evalRunner = require("../lib/evalRunner");

const args = process.argv.slice(2);
const programId = args[0] || args[args.indexOf("--program") + 1];

if (!programId || programId.startsWith("--")) {
  console.error("usage: bun scripts/eval.ts <program-id> [triggered-by]");
  process.exitCode = 2;
} else if (!programs.get(programId)) {
  console.error(`unknown program: ${programId}`);
  process.exitCode = 2;
} else {
  db.open();
  const triggeredBy = args[1] && !args[1].startsWith("--") ? args[1] : "cli";
  const result = await evalRunner.run(programId, triggeredBy);
  console.log(`program=${programId} status=${result.status} passed=${result.passed}/${result.total} failed=${result.failed}`);
  console.log(`run=${result.id} content_hash=${result.contentHash}`);
  process.exitCode = result.status === "passed" ? 0 : 1;
}

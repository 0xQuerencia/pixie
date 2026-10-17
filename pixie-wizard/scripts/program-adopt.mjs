// Adopts programs that already exist in Core into the Wizard's Postgres, so
// they can be managed from the Wizard. Reads Core, writes Wizard rows only.
// Idempotent. Dry run unless --apply. Owner ids come from flags, never from files.
//
//   node scripts/program-adopt.mjs --program <id> --owner-hca <hca id> [--owner-slack <U...>] [--workspace <T...>] [--apply]
//   node scripts/program-adopt.mjs --all --owner-hca <hca id> [--apply]
//
// env: DATABASE_URL, PIXIE_CORE_BASE_URL, PIXIE_INTERNAL_TOKEN
import { Pool } from "pg";
import { applyAdoptionPlan, buildAdoptionPlan } from "../lib/programAdoptionPlan.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const need = (name) => {
  const found = process.env[name];
  if (!found) throw new Error(`${name} is not set`);
  return found;
};

const apply = flag("apply");
const coreUrl = need("PIXIE_CORE_BASE_URL").replace(/\/+$/, "");
const coreToken = need("PIXIE_INTERNAL_TOKEN");
const dbUrl = need("DATABASE_URL");

async function core(path) {
  const res = await fetch(`${coreUrl}${path}`, { headers: { Authorization: `Bearer ${coreToken}` } });
  if (!res.ok) throw new Error(`Core ${path} failed with ${res.status}`);
  return res.json();
}

async function main() {
  const ownerHcaId = value("owner-hca");
  const ids = flag("all") ? (await core("/internal/v1/programs")).map((program) => program.id) : [value("program")].filter(Boolean);
  if (ids.length === 0) throw new Error("pass --program <id> or --all");
  const plans = [];
  for (const id of ids) {
    const list = await core("/internal/v1/programs");
    const program = list.find((item) => item.id === id);
    if (!program) throw new Error(`Core has no program ${id}`);
    const helpers = await core(`/internal/v1/programs/${encodeURIComponent(id)}/helpers`);
    plans.push(buildAdoptionPlan(program, helpers, { ownerHcaId, ownerSlackId: value("owner-slack"), workspaceId: value("workspace") }));
  }
  let failed = false;
  for (const plan of plans) {
    const p = plan.program;
    console.log(`${apply ? "[apply]" : "[dry run]"} ${p.id}: workspace=${p.workspace_id} lifecycle=${p.lifecycle} channels=${plan.channels.length} helpers=${plan.helpers.length}`);
    for (const line of plan.warnings) console.log(`  warning: ${line}`);
    for (const line of plan.blockers) {
      console.log(`  BLOCKED: ${line}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  if (!apply) return console.log("dry run only: re-run with --apply to write Wizard rows");
  const pool = new Pool({ connectionString: dbUrl, ssl: /sslmode=require/.test(dbUrl) ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const plan of plans) await applyAdoptionPlan(client, plan);
    await client.query("commit");
    console.log("adopted");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`adoption refused: ${error.message}`);
  process.exit(1);
});

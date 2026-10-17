import fs = require("node:fs");
import path = require("node:path");
import db = require("./db");
import programs = require("./programs");
import programDocs = require("./programDocs");
import evalRunner = require("./evalRunner");
import programInstructions = require("./programInstructions");
import type { ProgramSource } from "./types";

const SOURCE_TYPES = new Set(["url", "github-dir", "json-faq", "text", "markdown", "reference"]);
const SOURCE_ALIASES: Record<string, string> = { web: "url", repo: "reference", "github-repo": "reference" };
const SLACK_ID = /^[CG][A-Z0-9]{8,14}$/;
const SETTING_TYPES: Record<string, "boolean" | "string"> = {
  ticketsEnabled: "boolean",
  helperPing: "boolean",
  autoEscalate: "boolean",
  aiAnswers: "boolean",
  publicTicketsEnabled: "boolean",
  supportActive: "boolean",
  autoAssign: "boolean",
  ticketVisibility: "string",
  incidentMode: "string",
};
const PROGRAM_ID = /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/;

interface SeedDoc {
  section: string;
  title: string;
  body: string;
  sourceRef: string | null;
  file: string;
}

interface SeedCase {
  kind: string;
  question: string;
  expect: unknown;
}

interface SeedProgram {
  dir: string;
  settings: Record<string, unknown>;
  id: string;
  name: string;
  supportName: string | null;
  posture: string;
  channels: { help: string | null; organizer: string | null; main: string[] };
  sources: ProgramSource[];
  instructions: unknown;
  docs: SeedDoc[];
  cases: SeedCase[];
}

interface SeedResult {
  programId: string;
  created: boolean;
  docs: { created: number; updated: number; unchanged: number; deactivated: number };
  cases: number;
  channels: number;
}

function frontMatter(text: string): { meta: Record<string, string>; body: string } | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: match[2].trim() };
}

function readJson(file: string, errors: string[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: unknown) {
    errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function loadDocs(dir: string, errors: string[]): SeedDoc[] {
  const docsDir = path.join(dir, "docs");
  if (!fs.existsSync(docsDir)) return [];
  const docs: SeedDoc[] = [];
  for (const name of fs.readdirSync(docsDir).filter((entry) => entry.endsWith(".md")).sort()) {
    const file = path.join(docsDir, name);
    const parsed = frontMatter(fs.readFileSync(file, "utf8"));
    if (!parsed) {
      errors.push(`${file}: missing front matter`);
      continue;
    }
    const { meta, body } = parsed;
    if (!(programDocs.DOC_SECTIONS as readonly string[]).includes(meta.section)) errors.push(`${file}: section: unknown "${meta.section}"`);
    if (meta.trust !== "official") errors.push(`${file}: trust: seed docs must be official`);
    if (!meta.title) errors.push(`${file}: title: required`);
    if (!body) errors.push(`${file}: body: empty`);
    docs.push({ section: meta.section, title: meta.title, body, sourceRef: meta.source_ref || null, file });
  }
  return docs;
}

function loadCases(dir: string, errors: string[]): SeedCase[] {
  const file = path.join(dir, "eval.json");
  if (!fs.existsSync(file)) return [];
  const data = readJson(file, errors);
  if (!Array.isArray(data)) return [];
  const cases: SeedCase[] = [];
  data.forEach((item, index) => {
    const kind = (item as SeedCase)?.kind;
    if (!evalRunner.EVAL_KINDS.includes(kind as never)) errors.push(`${file}: [${index}].kind: unknown "${kind}"`);
    try {
      evalRunner.parseExpect((item as SeedCase)?.expect || {});
    } catch (error: unknown) {
      errors.push(`${file}: [${index}].expect: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!(item as SeedCase)?.question) errors.push(`${file}: [${index}].question: required`);
    cases.push(item as SeedCase);
  });
  return cases;
}

function normalizeSources(raw: unknown, file: string, errors: string[]): ProgramSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const source = { ...(entry as ProgramSource) };
    source.type = SOURCE_ALIASES[String(source.type)] || source.type;
    if (!source.name || !source.url) errors.push(`${file}: sources[${index}]: name and url required`);
    if (!SOURCE_TYPES.has(String(source.type))) errors.push(`${file}: sources[${index}].type: unknown "${source.type}"`);
    return source;
  });
}

function loadProgramDir(dir: string): { seed: SeedProgram | null; errors: string[] } {
  const errors: string[] = [];
  const file = path.join(dir, "program.json");
  const raw = readJson(file, errors) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { seed: null, errors };
  const id = String(raw.id || "");
  if (!PROGRAM_ID.test(id)) errors.push(`${file}: id: invalid slug "${id}"`);
  if (id !== path.basename(dir)) errors.push(`${file}: id: must match directory name`);
  if (!raw.name) errors.push(`${file}: name: required`);
  const channels = (raw.channels || {}) as Record<string, unknown>;
  const main = Array.isArray(channels.main) ? (channels.main as string[]) : [];
  for (const channel of [channels.help, channels.organizer, ...main]) {
    if (channel && !SLACK_ID.test(String(channel))) errors.push(`${file}: channels: invalid Slack id "${channel}"`);
  }
  const settings = (raw.settings || {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (!SETTING_TYPES[key]) errors.push(`${file}: settings.${key}: unknown setting`);
    else if (typeof value !== SETTING_TYPES[key]) errors.push(`${file}: settings.${key}: expected ${SETTING_TYPES[key]}`);
  }
  const problem = programInstructions.validate(raw.instructions ?? null);
  if (problem) errors.push(`${file}: ${problem}`);
  const seed: SeedProgram = {
    dir,
    settings,
    id,
    name: String(raw.name || ""),
    supportName: raw.supportName ? String(raw.supportName) : null,
    posture: String(raw.posture || "active"),
    channels: { help: (channels.help as string) || null, organizer: (channels.organizer as string) || null, main },
    sources: normalizeSources(raw.sources, file, errors),
    instructions: raw.instructions ?? null,
    docs: loadDocs(dir, errors),
    cases: loadCases(dir, errors),
  };
  return { seed, errors };
}

function channelClaims(seed: SeedProgram): Array<{ channelId: string; kind: string }> {
  const claims: Array<{ channelId: string; kind: string }> = [];
  if (seed.channels.help) claims.push({ channelId: seed.channels.help, kind: "help" });
  if (seed.channels.organizer) claims.push({ channelId: seed.channels.organizer, kind: "organizer" });
  for (const channelId of seed.channels.main) {
    if (!claims.some((claim) => claim.channelId === channelId)) claims.push({ channelId, kind: "discussion" });
  }
  return claims;
}

function syncDocs(seed: SeedProgram, dryRun: boolean): SeedResult["docs"] {
  const counts = { created: 0, updated: 0, unchanged: 0, deactivated: 0 };
  const existing = programDocs.listDocs(seed.id).filter((doc) => doc.updated_by === "seed");
  const wanted = new Set<string>();
  for (const doc of seed.docs) {
    const key = `${doc.section}\u0000${doc.title}`;
    wanted.add(key);
    const current = existing.find((item) => item.section === doc.section && item.title === doc.title);
    const input = { section: doc.section, title: doc.title, body: doc.body, trust: "official", origin: "manual", sourceRef: doc.sourceRef, updatedBy: "seed", active: true };
    if (!current) {
      counts.created += 1;
      if (!dryRun) programDocs.createDoc(seed.id, input);
    } else if (current.body !== doc.body || current.active !== 1 || current.source_ref !== doc.sourceRef) {
      counts.updated += 1;
      if (!dryRun) programDocs.updateDoc(seed.id, current.id, input);
    } else counts.unchanged += 1;
  }
  for (const doc of existing) {
    if (wanted.has(`${doc.section}\u0000${doc.title}`) || doc.active !== 1) continue;
    counts.deactivated += 1;
    if (!dryRun) programDocs.updateDoc(seed.id, doc.id, { active: false, updatedBy: "seed" });
  }
  return counts;
}

function apply(seed: SeedProgram, options: { workspaceId: string; dryRun?: boolean }): SeedResult {
  const dryRun = options.dryRun === true;
  const existing = programs.get(seed.id);
  const claims = channelClaims(seed);
  if (!dryRun) {
    const ownSources = (existing?.sources || []).filter((source) => !("docId" in source));
    db.saveProgram({
      ...(existing || {}),
      sources: ownSources.length ? ownSources : seed.sources,
      id: seed.id,
      name: seed.name,
      supportName: seed.supportName,
      posture: seed.posture as never,
      scope: "program",
      workspaceId: options.workspaceId,
      helpChannel: seed.channels.help,
      organizerChannel: seed.channels.organizer,
      channels: claims.map((claim) => claim.channelId),
      ...seed.settings,
      instructions: seed.instructions as never,
      lifecycle: existing?.lifecycle || "draft",
    });
    for (const claim of claims) {
      const result = db.claimProgramChannel({ workspaceId: options.workspaceId, programId: seed.id, ...claim });
      if (!result.ok) throw new Error(`channel ${claim.channelId} is already claimed by ${result.ownerProgramId}`);
    }
    programs.invalidate();
  }
  const docs = syncDocs(seed, dryRun);
  if (!dryRun) {
    for (const item of evalRunner.listCases(seed.id, false).filter((row) => row.origin === "manual")) {
      evalRunner.deleteCase(seed.id, item.id);
    }
    for (const item of seed.cases) evalRunner.createCase(seed.id, { ...item, origin: "manual" });
  }
  return { programId: seed.id, created: !existing, docs, cases: seed.cases.length, channels: claims.length };
}

function listProgramDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "program.json")))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

export = { loadProgramDir, apply, listProgramDirs, channelClaims };

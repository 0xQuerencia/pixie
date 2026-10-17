import crypto = require("node:crypto");
import db = require("./db");

const DOC_SECTIONS = [
  "overview",
  "eligibility",
  "how_it_works",
  "participation",
  "submission",
  "grants",
  "review",
  "rewards",
  "deadlines",
  "common_problems",
  "faq",
  "support",
] as const;
const DOC_TRUST = ["official", "supporting"] as const;
const DOC_ORIGINS = ["manual", "url", "github", "slack"] as const;

type DocSection = (typeof DOC_SECTIONS)[number];
type DocTrust = (typeof DOC_TRUST)[number];
type DocOrigin = (typeof DOC_ORIGINS)[number];

interface ProgramDoc {
  id: number;
  program_id: string;
  section: DocSection;
  title: string;
  body: string;
  trust: DocTrust;
  origin: DocOrigin;
  source_ref: string | null;
  active: number;
  version: number;
  supersedes_id: number | null;
  updated_by: string;
  created_at: number;
  updated_at: number;
  reviewed_by: string | null;
  reviewed_at: number | null;
}

interface DocInput {
  section?: string;
  title?: string;
  body?: string;
  trust?: string;
  origin?: string;
  sourceRef?: string | null;
  source_ref?: string | null;
  active?: boolean;
  updatedBy?: string | null;
  updated_by?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: number | null;
}

interface RetrievalSection {
  name: string;
  text: string;
  trust: "official";
  updatedAt: number;
  docId: number;
}

interface SourceStateRow {
  program_id: string;
  source_key: string;
  text: string;
  content_hash: string;
  fetched_at: number;
  ok: number;
  error: string | null;
}

function handle() {
  return db.handle();
}

function contentChanged(programId: string, actor: string | null = null) {
  try {
    require("./lifecycle").contentChanged(programId, actor);
  } catch (_) {}
  try {
    require("./knowledge").invalidate();
    require("./cache").clearCache();
  } catch (_) {}
}

function row(id: number | string): ProgramDoc | null {
  return handle().query<ProgramDoc, [number | string]>("SELECT * FROM program_docs WHERE id = ?").get(id) || null;
}

function required(value: unknown, name: string, max: number): string {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} required`);
  if (text.length > max) throw new Error(`${name} too long (max ${max} chars)`);
  return text;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`invalid ${name}`);
  return value as T;
}

function sourceRef(input: DocInput): string | null {
  const value = input.sourceRef ?? input.source_ref;
  if (value === null || value === undefined || value === "") return null;
  return required(value, "sourceRef", 2000);
}

function updatedBy(input: DocInput): string {
  return required(input.updatedBy ?? input.updated_by ?? "system", "updatedBy", 200);
}

function docValues(programId: string, input: DocInput, existing: ProgramDoc | null = null) {
  const section = enumValue(input.section ?? existing?.section, DOC_SECTIONS, "section");
  const title = required(input.title ?? existing?.title, "title", 300);
  const body = required(input.body ?? existing?.body, "body", 300_000);
  const trust = enumValue(input.trust ?? existing?.trust, DOC_TRUST, "trust");
  const origin = enumValue(input.origin ?? existing?.origin, DOC_ORIGINS, "origin");
  const active = input.active === undefined ? existing?.active !== 0 : input.active ? 1 : 0;
  return { programId, section, title, body, trust, origin, sourceRef: sourceRef(input), active };
}

function createDoc(programId: string, input: DocInput): ProgramDoc {
  const values = docValues(programId, input);
  const actor = updatedBy(input);
  const now = Date.now();
  const result = handle()
    .query(
      `INSERT INTO program_docs
       (program_id, section, title, body, trust, origin, source_ref, active, version, supersedes_id, updated_by, created_at, updated_at, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      programId,
      values.section,
      values.title,
      values.body,
      values.trust,
      values.origin,
      values.sourceRef,
      values.active,
      actor,
      now,
      now,
      input.reviewedBy ?? null,
      input.reviewedAt ?? null,
    );
  const created = row(Number(result.lastInsertRowid)) as ProgramDoc;
  contentChanged(programId, actor);
  return created;
}

function getDoc(programId: string, docId: number): ProgramDoc | null {
  return (
    handle()
      .query<ProgramDoc, [string, number]>("SELECT * FROM program_docs WHERE program_id = ? AND id = ?")
      .get(programId, docId) || null
  );
}

function listDocs(programId: string, options: { activeOnly?: boolean; section?: string } = {}): ProgramDoc[] {
  const clauses = ["program_id = ?"];
  const params: Array<string | number> = [programId];
  if (options.activeOnly) clauses.push("active = 1");
  if (options.section) {
    clauses.push("section = ?");
    params.push(options.section);
  }
  return handle()
    .query<ProgramDoc, Array<string | number>>(
      `SELECT * FROM program_docs WHERE ${clauses.join(" AND ")} ORDER BY section, id`,
    )
    .all(...params);
}

function listBySection(programId: string, section: string, activeOnly = true): ProgramDoc[] {
  enumValue(section, DOC_SECTIONS, "section");
  return listDocs(programId, { section, activeOnly });
}

function updateDoc(programId: string, docId: number, input: DocInput): ProgramDoc | null {
  const existing = getDoc(programId, docId);
  if (!existing) return null;
  const values = docValues(programId, input, existing);
  const actor = updatedBy(input);
  const now = Date.now();
  const version = existing.version + 1;
  handle()
    .query(
      `UPDATE program_docs SET section = ?, title = ?, body = ?, trust = ?, origin = ?, source_ref = ?, active = ?, version = ?, updated_by = ?, updated_at = ?, reviewed_by = ?, reviewed_at = ? WHERE program_id = ? AND id = ?`,
    )
    .run(
      values.section,
      values.title,
      values.body,
      values.trust,
      values.origin,
      values.sourceRef,
      values.active,
      version,
      actor,
      now,
      input.reviewedBy ?? existing.reviewed_by,
      input.reviewedAt ?? existing.reviewed_at,
      programId,
      docId,
    );
  const updated = getDoc(programId, docId);
  contentChanged(programId, actor);
  return updated;
}

function deleteDoc(programId: string, docId: number): boolean {
  const deleted =
    handle().query("DELETE FROM program_docs WHERE program_id = ? AND id = ?").run(programId, docId).changes > 0;
  if (deleted) contentChanged(programId);
  return deleted;
}

function supersedeDoc(programId: string, docId: number, input: DocInput): ProgramDoc | null {
  const existing = getDoc(programId, docId);
  if (!existing) return null;
  const replacement = createDoc(programId, { ...input, supersedes_id: docId } as DocInput & { supersedes_id: number });
  handle()
    .query("UPDATE program_docs SET active = 0, updated_at = ? WHERE program_id = ? AND id = ?")
    .run(Date.now(), programId, docId);
  handle()
    .query("UPDATE program_docs SET supersedes_id = ? WHERE program_id = ? AND id = ?")
    .run(docId, programId, replacement.id);
  const superseded = getDoc(programId, replacement.id);
  contentChanged(programId, updatedBy(input));
  return superseded;
}

function docSections(programId: string): RetrievalSection[] {
  return handle()
    .query<ProgramDoc, [string]>(
      "SELECT * FROM program_docs WHERE program_id = ? AND active = 1 AND trust = 'official' ORDER BY section, id",
    )
    .all(programId)
    .map((doc) => ({
      name: doc.title,
      text: doc.body,
      trust: "official" as const,
      updatedAt: doc.updated_at,
      docId: doc.id,
    }));
}

function upsertSourceState(
  programId: string,
  sourceKey: string,
  text: string,
  options: { contentHash?: string; fetchedAt?: number; ok?: boolean; error?: string | null } = {},
) {
  const cleanKey = required(sourceKey, "sourceKey", 1000);
  const cleanText = String(text || "");
  const contentHash = options.contentHash || crypto.createHash("sha256").update(cleanText).digest("hex");
  handle()
    .query(
      `INSERT INTO program_source_state (program_id, source_key, text, content_hash, fetched_at, ok, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(program_id, source_key) DO UPDATE SET text = excluded.text, content_hash = excluded.content_hash, fetched_at = excluded.fetched_at, ok = excluded.ok, error = excluded.error`,
    )
    .run(
      programId,
      cleanKey,
      cleanText,
      contentHash,
      options.fetchedAt || Date.now(),
      options.ok === false ? 0 : 1,
      options.error || null,
    );
  const state = sourceState(programId, cleanKey);
  contentChanged(programId);
  return state;
}

function sourceState(programId: string, sourceKey: string): SourceStateRow | null {
  return (
    handle()
      .query<SourceStateRow, [string, string]>(
        "SELECT * FROM program_source_state WHERE program_id = ? AND source_key = ?",
      )
      .get(programId, sourceKey) || null
  );
}

function sourceStates(programId: string): SourceStateRow[] {
  return handle()
    .query<SourceStateRow, [string]>("SELECT * FROM program_source_state WHERE program_id = ? ORDER BY source_key")
    .all(programId);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(programId: string): string {
  const program = require("./programs").get(programId);
  const docs = listDocs(programId, { activeOnly: true })
    .filter((doc) => doc.trust === "official")
    .sort((a, b) => a.id - b.id)
    .map((doc) => ({ id: doc.id, version: doc.version, body: doc.body }));
  const states = sourceStates(programId).map((state) => ({
    sourceKey: state.source_key,
    contentHash: state.content_hash,
  }));
  const instructions = {
    behavior: program?.behavior || null,
    pinnedRules: program?.pinnedRules || [],
    answerPolicy: {
      aiAnswers: program?.aiAnswers !== false,
      autoEscalate: program?.autoEscalate !== false,
      requireGroundedAnswer: program?.requireGroundedAnswer || false,
    },
  };
  return crypto.createHash("sha256").update(stable({ docs, states, instructions })).digest("hex");
}

export = {
  DOC_SECTIONS,
  DOC_TRUST,
  DOC_ORIGINS,
  createDoc,
  getDoc,
  listDocs,
  listBySection,
  updateDoc,
  deleteDoc,
  supersedeDoc,
  docSections,
  upsertSourceState,
  sourceState,
  sourceStates,
  contentHash,
};

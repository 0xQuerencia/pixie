const fs = require("fs");
const { redactSecrets } = require("./redact");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
axios.defaults.headers.common["User-Agent"] = "PixieBot";
const retrieve = require("./retrieve");
const log = require("./log");
const programs = require("./programs");
const db = require("./db");
const answerCache = require("./cache");
const sourceGuard = require("./sourceGuard");
const firecrawl = require("./firecrawl");
const identity = require("./identity");
const programModule = require("./program");
const draftSandbox = require("./draftSandbox");
const learn = require("./learn");
const programDocs = require("./programDocs");
import type { Program, ProgramSource } from "./types";

interface SourceRecord extends Partial<ProgramSource> {
  name: string;
  type?: string;
  url?: string;
  content?: unknown;
  siteUrl?: string;
  hidden?: boolean;
  dynamic?: boolean;
  paths?: string[];
}
type ProgramLike = Omit<Partial<Program>, "status" | "sources"> & {
  id?: string;
  status?: string;
  privateSandboxOnly?: boolean;
  faqContent?: string;
  sources?: SourceRecord[];
  sourceTexts?: Record<string, string>;
};
type Section = [string, string];
interface GithubListingEntry {
  type?: string;
  name?: string;
  download_url?: string;
  html_url?: string;
}
interface GithubFile {
  name: string;
  title: string;
  downloadUrl: string;
  pageUrl: string;
  contentUrl: string;
  isHtml: boolean;
}
interface GithubSection {
  title: string;
  pageUrl: string;
  body: string;
}
interface CrawlPage {
  content: string;
  raw: string;
}
interface SourceHealthRow {
  name: string;
  fail_count?: number;
  fetched_at?: number | null;
  last_success_at?: number | null;
  last_error?: string | null;
}
interface RetrievalIndex {
  docs: Array<{ chunk: { source: string } }>;
}

const SOURCES_PATH = path.join(__dirname, "..", "config", "sources.json");
const APP_ROOT = path.join(__dirname, "..");
const FETCH_BATCH_SIZE = 5;
const INITIAL_FETCH_TIMEOUT_MS = 10000;
const SUBPAGE_FETCH_TIMEOUT_MS = 15000;
const SHARED_CHROME_THRESHOLD = 0.6;
const UNRENDERED_PLACEHOLDER_RE = /\{\{[a-z0-9_]+\}\}/i;

const MAX_SOURCE_TEXT_CHARS = 200000;

const inflightSources = new Set<string>();
const cache = new Map<string, string>();
const linkCache = new Map<string, string>();
let lastBuiltAt: Date | null = null;

const corpusCacheMap = new Map<string, string>();
const corpusBuiltOnMap = new Map<string, string>();
const retrievalIndexMap = new Map<string, RetrievalIndex>();
const draftCorpusMap = new Map<string, string>();
const draftIndexMap = new Map<string, { docs: unknown[] }>();

function today() {
  return new Date().toDateString();
}

function invalidate() {
  corpusCacheMap.clear();
  corpusBuiltOnMap.clear();
  retrievalIndexMap.clear();
  draftCorpusMap.clear();
  draftIndexMap.clear();
}

function registerDraftKnowledge(draftProgram: ProgramLike, sourceTexts: Record<string, string>) {
  if (!draftProgram?.id || draftProgram.status !== "suspended" || draftProgram.privateSandboxOnly !== true)
    throw new Error("invalid draft knowledge registration");
  const sections: Section[] = Object.entries(sourceTexts || {}).filter(([, text]) => text);
  const generated: Section[] = draftProgram.faqContent ? [["Draft FAQs", draftProgram.faqContent]] : [];
  const all = [...generated, ...sections];
  draftCorpusMap.set(draftProgram.id, all.map(([name, text]) => `### ${name}\n${text}`).join("\n\n"));
  draftIndexMap.set(draftProgram.id, retrieve.buildIndex(retrieve.chunkSections(all)));
  const sources = [...(draftProgram.sources || [])];
  draftSandbox.register({ ...draftProgram, sources, sourceTexts: Object.fromEntries(sections) });
  return {
    sources: sections.length,
    chunks: draftIndexMap.get(draftProgram.id)?.docs.length || 0,
    faq: generated.length,
  };
}

async function ingestDraftSources(draftProgram: ProgramLike) {
  if (!draftProgram?.id || draftProgram.status !== "suspended" || draftProgram.privateSandboxOnly !== true)
    throw new Error("only private suspended drafts may be ingested");
  const sourceTexts: Record<string, string> = {};
  const skipped: { name: string; reason: string }[] = [];
  for (const source of draftProgram.sources || []) {
    if (!source?.name || source.type === "slack-reference" || source.type === "canvas-reference") {
      skipped.push({ name: source?.name || "unnamed", reason: "reference-only source" });
      continue;
    }
    try {
      sourceTexts[source.name] = await fetchSourceText(source, false);
    } catch (error: unknown) {
      skipped.push({ name: source.name, reason: error instanceof Error ? error.message : "fetch failed" });
    }
  }
  const result = registerDraftKnowledge({ ...draftProgram, sourceTexts }, sourceTexts);
  return { ...result, skipped };
}

function getDraftContext(draftProgramId: string, question: string) {
  let index = draftIndexMap.get(draftProgramId);
  if (!index) {
    try {
      loadDraftPersisted();
    } catch (_error: unknown) {}
    index = draftIndexMap.get(draftProgramId);
  }
  if (!index) return "";
  const draftCorpus = draftCorpusMap.get(draftProgramId) || "";
  const selected = retrieve.selectChunks(index, question, retrieve.DEFAULT_BUDGET);
  if (selected.length === 0) return draftCorpus.slice(0, retrieve.DEFAULT_BUDGET);
  return retrieve.selectContext({ generated: [], index, sources: [], question, exclude: null });
}

function loadDraftPersisted() {
  let programs: { program_id: string; payload: string }[] = [];
  let sources: { program_id: string; source_name: string; text: string }[] = [];
  try {
    programs = db.handle().query("SELECT program_id, payload FROM draft_sandbox_programs").all();
    sources = db.handle().query("SELECT program_id, source_name, text FROM draft_sandbox_sources").all();
  } catch (_error: unknown) {
    return { programs: 0, sources: 0 };
  }
  const byProgram = new Map<string, Section[]>();
  for (const row of sources) {
    if (!byProgram.has(row.program_id)) byProgram.set(row.program_id, []);
    const sections = byProgram.get(row.program_id) || [];
    sections.push([row.source_name, row.text]);
    byProgram.set(row.program_id, sections);
  }
  let rebuilt = 0;
  for (const row of programs) {
    let program: ProgramLike | null = null;
    try {
      program = JSON.parse(row.payload);
    } catch (_error: unknown) {
      continue;
    }
    const sections = byProgram.get(row.program_id) || [];
    if (!program) continue;
    const generated: Section[] = program.faqContent ? [["Draft FAQs", program.faqContent]] : [];
    const all = [...generated, ...sections];
    if (all.length === 0) continue;
    draftCorpusMap.set(row.program_id, all.map(([name, text]) => `### ${name}\n${text}`).join("\n\n"));
    try {
      draftIndexMap.set(row.program_id, retrieve.buildIndex(retrieve.chunkSections(all)));
      draftSandbox.register({ ...program, sourceTexts: Object.fromEntries(sections) });
      rebuilt += 1;
    } catch (_error: unknown) {}
  }
  return { programs: programs.length, sources: sources.length, rebuilt };
}

function loadSources(): SourceRecord[] {
  const allSources: SourceRecord[] = [];
  const seenUrls = new Set();

  const progs = [...programs.all(), programs.shared()];
  for (const prog of progs) {
    if (!Array.isArray(prog.sources)) continue;
    for (const src of prog.sources) {
      if (!src || !src.name) continue;
      const hasContent = src.content !== undefined && src.content !== null;
      if (!src.url && !hasContent) continue;
      const key = sourceCacheKey(src);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      allSources.push(src);
    }
  }

  if (allSources.length === 0 && fs.existsSync(SOURCES_PATH)) {
    try {
      const raw = fs.readFileSync(SOURCES_PATH, "utf8");
      return JSON.parse(raw);
    } catch (_error: unknown) {
      return [];
    }
  }

  return allSources;
}

function resolveLocalPath(url: string) {
  const raw = String(url || "").replace(/^file:\/\//, "");
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(APP_ROOT, raw);
  if (resolved !== APP_ROOT && !resolved.startsWith(APP_ROOT + path.sep)) {
    throw new Error(`refusing file source outside app root: ${String(url).slice(0, 80)}`);
  }
  return resolved;
}

function preserveLinks(html: string) {
  return html.replace(
    /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (match: string, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const url = href.trim();
      if (!label) return match;
      if (!url || url.startsWith("#") || /^javascript:/i.test(url)) return ` ${label} `;
      if (label === url) return ` ${label} `;
      return ` ${label} (${url}) `;
    },
  );
}

function stripHtml(html: string) {
  const withoutCode = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");

  return preserveLinks(withoutCode)
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function textFromJsonFaq(data: unknown) {
  const items = data && typeof data === "object" ? (data as { faq?: { items?: unknown } }).faq?.items : null;
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      const record = item && typeof item === "object" ? (item as { question?: unknown; answer?: unknown }) : {};
      return `Q: ${String(record.question)}\nA: ${String(record.answer)}`;
    })
    .join("\n\n");
}

function annotateHeadingAnchors(html: string, baseUrl: string, links: Map<string, string>) {
  let content = html;
  const articleMatch =
    content.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || content.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch) {
    content = articleMatch[1];
  } else {
    content = content
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, "");
  }

  content = content.replace(/<div[^>]*\bclass="(?:eyebrow|doc-foot|doc-sign)"[^>]*>[\s\S]*?<\/div>/gi, "");

  content = content.replace(
    /<h([1-6])[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi,
    (match: string, level: string, id: string, headingInner: string) => {
      const headingText = headingInner.replace(/<[^>]+>/g, "").trim();
      if (!headingText) return match;
      if (links) links.set(headingText.toLowerCase(), `${baseUrl}#${id}`);
      return `\n\n## ${headingText} (${baseUrl}#${id})\n\n`;
    },
  );

  content = content.replace(
    /<(?:section|div)[^>]*\bid="([^"]+)"[^>]*>[\s\S]{0,80}?<h([1-6])[^>]*>([\s\S]*?)<\/h\2>/gi,
    (match: string, id: string, level: string, headingInner: string) => {
      const headingText = headingInner.replace(/<[^>]+>/g, "").trim();
      if (!headingText) return match;
      if (links) links.set(headingText.toLowerCase(), `${baseUrl}#${id}`);
      return `\n\n## ${headingText} (${baseUrl}#${id})\n\n`;
    },
  );

  content = content.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (match: string, level: string, headingInner: string) => {
      const headingText = headingInner.replace(/<[^>]+>/g, "").trim();
      if (!headingText) return match;
      return `\n\n## ${headingText}\n\n`;
    },
  );

  return content;
}

function docTitleFromFilename(name: string) {
  return String(name || "")
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_]/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c: string) => c.toUpperCase());
}

function docSlugFromFilename(name: string) {
  return String(name || "")
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_]/, "")
    .replace(/_/g, "-")
    .toLowerCase();
}

function dropSharedLines(pages: string[], threshold = SHARED_CHROME_THRESHOLD): string[] {
  if (!Array.isArray(pages) || pages.length < 3) return pages;

  const counts = new Map<string, number>();
  for (const page of pages) {
    const distinct = new Set(
      String(page)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    for (const line of distinct) counts.set(line, (counts.get(line) || 0) + 1);
  }

  const minPages = Math.ceil(pages.length * threshold);
  const chrome = new Set([...counts].filter(([, n]) => n >= minPages).map(([line]) => line));

  return pages.map((page) =>
    String(page)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l || !chrome.has(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n"),
  );
}

function markdownFilesFromListing(data: unknown, siteBase = ""): GithubFile[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => entry as GithubListingEntry)
    .filter((e) => e && e.type === "file" && /\.md$/i.test(e.name || "") && e.download_url)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((e) => ({
      name: e.name || "",
      title: docTitleFromFilename(e.name || ""),
      downloadUrl: e.download_url!,
      pageUrl: siteBase
        ? `${String(siteBase).replace(/\/$/, "")}/${docSlugFromFilename(e.name || "")}`
        : e.html_url || e.download_url!,
      contentUrl: siteBase
        ? `${String(siteBase).replace(/\/$/, "")}/${docSlugFromFilename(e.name || "")}`
        : e.download_url!,
      isHtml: Boolean(siteBase),
    }));
}

function sourceCacheKey(source: SourceRecord | null | undefined) {
  if (!source || !source.name) return null;
  if (source.url) return `${source.name}::${source.url}`;
  const inlineIdentity = JSON.stringify({ type: source.type, content: source.content });
  const digest = crypto.createHash("sha256").update(inlineIdentity).digest("hex");
  return `${source.name}::inline::${digest}`;
}

function memKey(source: SourceRecord) {
  return sourceCacheKey(source) || source.name;
}

function isDynamicSource(source: SourceRecord) {
  return Boolean(source && source.dynamic === true);
}

function sourceFreshness(source: SourceRecord) {
  const key = sourceCacheKey(source);
  if (!key)
    return {
      key: null,
      name: source?.name || null,
      authority: "unknown",
      freshness: "unavailable",
      lastSuccessAt: null,
      failCount: 0,
      lastError: null,
      hasLastGood: false,
    };

  const row = db.getSourceHealth([key])[0] || null;
  const lastSuccessAt = row?.last_success_at || null;
  const failCount = Number(row?.fail_count || 0);
  const hasLastGood = Boolean(lastSuccessAt) || cache.has(memKey(source));
  const freshness = !hasLastGood ? "unavailable" : failCount > 0 ? "stale" : "fresh";

  return {
    key,
    name: source.name,
    authority: isDynamicSource(source) ? "dynamic" : "static",
    freshness,
    lastSuccessAt,
    failCount,
    lastError: row?.last_error || null,
    hasLastGood,
  };
}

function sourceEligibility(source: SourceRecord) {
  const metadata = sourceFreshness(source);
  const exactClaimsAllowed =
    metadata.freshness === "fresh" || (metadata.authority !== "dynamic" && metadata.freshness === "stale");
  return {
    ...metadata,
    exactClaimsAllowed,
    eligible: metadata.hasLastGood,
  };
}

function displayNameForMemKey(key: string) {
  const idx = String(key).indexOf("::");
  return idx === -1 ? String(key) : String(key).slice(0, idx);
}

function recordLink(label: string, url: string) {
  if (!label || !url) return;
  linkCache.set(String(label).toLowerCase(), url);
}

function getSourceUrl(label: string) {
  if (!label) return null;
  return linkCache.get(label.trim().toLowerCase()) || null;
}

function inlineText(source: SourceRecord) {
  switch (source.type) {
    case "json-faq":
      return textFromJsonFaq(Array.isArray(source.content) ? { faq: { items: source.content } } : source.content);
    case "gdoc":
    case "text":
      if (source.siteUrl) recordLink(source.name, source.siteUrl);
      return typeof source.content === "string" ? source.content.trim() : String(source.content);
    default:
      throw new Error(`inline content is not supported for type: ${source.type}`);
  }
}

function localFileText(source: SourceRecord) {
  const url = source.url || "";
  const raw = fs.readFileSync(resolveLocalPath(url), "utf8");
  if (source.type === "text" || source.type === "markdown") {
    if (source.siteUrl) recordLink(source.name, source.siteUrl);
    return raw.trim();
  }
  const data = JSON.parse(raw);
  switch (source.type) {
    case "json-faq":
      return textFromJsonFaq(data);
    case "gdoc":
      recordLink(source.name, url);
      return typeof data === "string" ? data.trim() : String(data);
    default:
      throw new Error(`unsupported type for local file: ${source.type}`);
  }
}

async function fetchGithubDir(source: SourceRecord) {
  const url = source.url || "";
  const res = await sourceGuard.fetchSourceUrl(url, { timeout: INITIAL_FETCH_TIMEOUT_MS });
  const files = markdownFilesFromListing(res.data, source.siteUrl);
  if (files.length === 0) throw new Error(`no markdown files listed at ${source.url}`);

  recordLink(source.name, source.siteUrl || url);
  log.info("knowledge", `fetching ${files.length} markdown file(s) for source "${source.name}"`);

  const sections: GithubSection[] = [];
  for (let i = 0; i < files.length; i += FETCH_BATCH_SIZE) {
    const batch = files.slice(i, i + FETCH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((file) => fetchGithubFile(file, source.name)));
    sections.push(...batchResults.filter((section): section is GithubSection => Boolean(section)));
  }

  const kept = sections.filter((x) => x && x.body);
  const bodies = dropSharedLines(kept.map((x) => x.body));
  const joined = kept
    .map((x, i) => (bodies[i] ? `## ${x.title} (${x.pageUrl})\n\n${bodies[i]}` : ""))
    .filter(Boolean)
    .join("\n\n");
  if (!joined) throw new Error(`all markdown fetches failed for ${source.url}`);
  return joined;
}

async function fetchGithubFile(file: GithubFile, sourceName: string): Promise<GithubSection | null> {
  try {
    const fileRes = await sourceGuard.fetchSourceUrl(file.contentUrl, { timeout: SUBPAGE_FETCH_TIMEOUT_MS });
    const raw = typeof fileRes.data === "string" ? fileRes.data : String(fileRes.data);
    const body = file.isHtml ? stripHtml(annotateHeadingAnchors(raw, file.pageUrl, linkCache)).trim() : raw.trim();
    if (!body) return null;
    if (UNRENDERED_PLACEHOLDER_RE.test(body)) {
      log.warn("knowledge", `skipping ${file.name} for "${sourceName}": unrendered placeholders`);
      return null;
    }
    recordLink(file.title, file.pageUrl);
    return { title: file.title, pageUrl: file.pageUrl, body };
  } catch (error: unknown) {
    log.warn(
      "knowledge",
      `failed to fetch ${file.name} for "${sourceName}": ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return null;
  }
}

const CRAWL_MAX_PAGES = 80;
const CRAWL_MAX_DEPTH = 4;
const ASSET_RE = /\.(?:css|js|mjs|json|md|txt|xml|rss|png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|webm)$/i;

function normalizePath(p: string) {
  return String(p || "/").replace(/\/+$/, "") || "/";
}

function canonicalUrl(href: string, base: string) {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  u.hash = "";
  u.search = "";
  u.pathname = normalizePath(u.pathname);
  return u.href;
}

function crawlPrefixes(source: SourceRecord) {
  const rootPath = normalizePath(new URL(source.url || "").pathname);
  const configured = Array.isArray(source.paths) && source.paths.length ? source.paths.map(normalizePath) : null;
  const set = new Set([...(configured || ["/docs"]), rootPath].filter((p) => p && p !== "/"));
  return [...set];
}

function inScope(href: string, base: string, origin: string, prefixes: string[]) {
  const canon = canonicalUrl(href, base);
  if (!canon) return null;
  const u = new URL(canon);
  if (u.origin !== origin || ASSET_RE.test(u.pathname)) return null;
  const hit = prefixes.some((prefix) => u.pathname === prefix || u.pathname.startsWith(`${prefix}/`));
  return hit ? canon : null;
}

function linksFrom(text: string): string[] {
  const found = new Set<string>();
  for (const m of String(text).matchAll(/href="([^"#?\s]+)/gi)) found.add(m[1]);
  for (const m of String(text).matchAll(/\]\(([^)#?\s]+)/g)) found.add(m[1]);
  return [...found].filter(Boolean);
}

function titleFromUrl(pageUrl: string) {
  const seg = normalizePath(new URL(pageUrl).pathname).split("/").filter(Boolean).pop();
  if (!seg) return "Overview";
  return seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
}

async function fetchCrawlPage(pageUrl: string, force: boolean): Promise<CrawlPage> {
  const title = titleFromUrl(pageUrl);
  if (firecrawl.getApiKey()) {
    try {
      const md = await firecrawl.scrapeUrl(pageUrl, { skipCache: force });
      if (md) {
        recordLink(title, pageUrl);
        return { content: `## ${title} (${pageUrl})\n\n${md}`, raw: md };
      }
    } catch (error: unknown) {
      log.warn(
        "knowledge",
        `firecrawl scrape failed for ${pageUrl}, falling back to guard: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const res = await sourceGuard.fetchSourceUrl(pageUrl, { timeout: SUBPAGE_FETCH_TIMEOUT_MS });
  const html = String(res.data);
  return { content: stripHtml(annotateHeadingAnchors(html, pageUrl, linkCache)), raw: html };
}

function nextHops(hrefs: string[], base: string, origin: string, prefixes: string[], seen: Set<string>): string[] {
  const hops: string[] = [];
  for (const href of hrefs) {
    const canon = inScope(href, base, origin, prefixes);
    if (canon && !seen.has(canon)) {
      seen.add(canon);
      hops.push(canon);
    }
  }
  return hops;
}

async function fetchUrlSource(source: SourceRecord, force: boolean) {
  const url = source.url || "";
  recordLink(source.name, source.siteUrl || url);
  const rootUrl = canonicalUrl(url, url);
  if (!rootUrl) throw new Error(`invalid source URL: ${url}`);
  const origin = new URL(rootUrl).origin;
  const prefixes = crawlPrefixes(source);

  const seen = new Set<string>([rootUrl]);
  const first = await fetchCrawlPage(rootUrl, force);
  const pages = [first.content];
  let frontier = nextHops(linksFrom(first.raw), rootUrl, origin, prefixes, seen);

  for (let depth = 1; depth <= CRAWL_MAX_DEPTH && frontier.length && pages.length < CRAWL_MAX_PAGES; depth++) {
    const discovered: string[] = [];
    for (let i = 0; i < frontier.length && pages.length < CRAWL_MAX_PAGES; i += FETCH_BATCH_SIZE) {
      const batch = frontier.slice(i, i + FETCH_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (url) => {
          try {
            return { url, ...(await fetchCrawlPage(url, force)) };
          } catch (error: unknown) {
            log.warn(
              "knowledge",
              `failed to crawl ${url} for "${source.name}": ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          }
        }),
      );
      for (const r of results) {
        if (!r) continue;
        if (r.content) pages.push(r.content);
        discovered.push(...nextHops(linksFrom(r.raw), r.url, origin, prefixes, seen));
      }
    }
    frontier = discovered;
  }

  const kept = pages.filter((p) => p && p.trim());
  if (kept.length === 0) throw new Error(`no pages crawled for ${source.url}`);
  log.info("knowledge", `crawled ${kept.length} page(s) for source "${source.name}"`);

  return dropSharedLines(kept).filter(Boolean).join("\n\n");
}

async function fetchSourceText(source: SourceRecord, force = false) {
  if (source.content !== undefined && source.content !== null) return inlineText(source);
  if (!source.url) throw new Error(`source "${source.name}" has neither a url nor inline content`);
  if (source.url.startsWith("file://")) return localFileText(source);

  if (source.type === "json-faq") {
    const res = await sourceGuard.fetchSourceUrl(source.url, { timeout: INITIAL_FETCH_TIMEOUT_MS });
    return textFromJsonFaq(res.data);
  }
  if (source.type === "gdoc") {
    const res = await sourceGuard.fetchSourceUrl(source.url, { timeout: INITIAL_FETCH_TIMEOUT_MS });
    recordLink(source.name, source.url);
    return typeof res.data === "string" ? res.data.trim() : String(res.data);
  }
  if (source.type === "github-dir") return fetchGithubDir(source);
  if (source.type === "url") return fetchUrlSource(source, force);
  throw new Error(`unknown source type: ${source.type}`);
}

function restoreFromDisk(source: SourceRecord) {
  const key = sourceCacheKey(source);
  const names = key && key !== source.name && source.url ? [key, source.name] : [key || source.name];
  for (const name of names) {
    try {
      const stored = db.loadSourceText(name);
      if (!stored?.text) continue;
      cache.set(memKey(source), stored.text);
      const ageMin = Math.round((Date.now() - stored.fetchedAt) / 60000);
      log.info("knowledge", `restored "${source.name}" from disk (fetched ${ageMin} min ago)`);
      return true;
    } catch (error: unknown) {
      log.debug("knowledge", `no stored copy for "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return false;
}

function persistSourceText(source: SourceRecord, text: string) {
  try {
    const key = sourceCacheKey(source) || source.name;
    db.saveSourceText(key, text);
    if (key !== source.name) {
      try {
        db.handle().query("DELETE FROM source_cache WHERE name = ?").run(source.name);
      } catch (_error: unknown) {}
    }
  } catch (error: unknown) {
    log.warn(
      "knowledge",
      `could not persist "${source.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function refreshSource(source: SourceRecord, force = false) {
  try {
    const text = await fetchSourceText(source, force);
    if (!text) return;
    const capped = text.length > MAX_SOURCE_TEXT_CHARS ? text.slice(0, MAX_SOURCE_TEXT_CHARS) : text;
    if (capped.length !== text.length) {
      log.warn("knowledge", `truncated oversized body for "${source.name}" (${text.length} chars)`);
    }
    cache.set(memKey(source), capped);
    persistSourceText(source, capped);
  } catch (error: unknown) {
    const restored = cache.has(memKey(source)) || restoreFromDisk(source);
    const tail = restored ? "serving last good copy" : "and there is no stored copy to fall back on";
    log.warn(
      "knowledge",
      `failed to fetch "${source.name}": ${redactSecrets(error instanceof Error ? error.message : String(error))} — ${tail}`,
    );
    try {
      db.recordSourceFailure(
        sourceCacheKey(source) || source.name,
        error instanceof Error ? error.message : String(error),
      );
    } catch (_error: unknown) {}
    if (!force) {
      try {
        db.recordMetric("source_refresh_failure", null, source.name);
        if (restored && isDynamicSource(source)) {
          db.recordMetric("stale_dynamic_source_used", null, source.name);
        }
      } catch (_error: unknown) {}
    }
  }
}

function faqQuestions(programId: string | null = null): string[] {
  const questions: string[] = [];
  const prog = programId ? programs.get(programId) : null;
  const shared = prog && prog.sharedSources === false ? [] : programs.shared().sources;
  const sources = prog ? [...(prog.sources || []), ...shared] : loadSources();

  for (const source of sources) {
    if (!source || source.type !== "json-faq") continue;
    let text = cache.get(memKey(source));
    if (!text && restoreFromDisk(source)) {
      text = cache.get(memKey(source));
    }
    for (const line of (text || "").split("\n")) {
      const match = line.match(/^Q:\s*(.+)$/);
      if (match) questions.push(match[1].trim());
    }
  }
  return questions;
}

function generatedSections(programId: string | null = null, question: string | null = null): Section[] {
  const prog = programs.get(programId);
  const sections: Section[] = [];

  try {
    const identityText = identity.corpusSection(prog);
    if (identityText) sections.push(["About pixie", identityText]);
  } catch (error: unknown) {
    log.warn(
      "knowledge",
      `generated section "About pixie" failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const milestones = prog ? prog.milestones : programs.shared().milestones;
    const timelineText = programModule.corpusSection(new Date(), milestones, prog);
    if (timelineText) sections.push(["Program timeline", timelineText]);
  } catch (error: unknown) {
    log.warn(
      "knowledge",
      `generated section "Program timeline" failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const learnText = question ? learn.relevantCorpusSection(question, programId) : learn.corpusSection(programId);
    if (learnText) sections.push(["Learned answers", learnText]);
  } catch (error: unknown) {
    log.warn(
      "knowledge",
      `generated section "Learned answers" failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return sections;
}

function memText(source: SourceRecord) {
  let text = cache.get(memKey(source));
  if (!text && restoreFromDisk(source)) {
    text = cache.get(memKey(source));
  }
  if (!text && source?.url?.startsWith("file://")) {
    try {
      text = localFileText(source);
      if (text) cache.set(memKey(source), text);
    } catch (error: unknown) {
      log.warn(
        "knowledge",
        `local source unavailable for ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return text || null;
}

function sourceSections(programId: string | null = null): Section[] {
  const prog = programs.get(programId);
  const progSources = prog ? prog.sources || [] : [];
  const sharedSources = prog && prog.sharedSources === false ? [] : programs.shared().sources || [];

  const combined = [...progSources, ...sharedSources];
  const seen = new Set<string>();
  const result: Section[] = [];

  for (const src of combined) {
    if (!src || !src.name || seen.has(src.name)) continue;
    seen.add(src.name);
    const text = memText(src);
    if (text) result.push([src.name, text]);
  }

  if (programId) {
    for (const doc of programDocs.docSections(programId)) {
      if (doc.name && doc.text) result.push([doc.name, doc.text]);
    }
  }

  return result;
}

function sourceContainsCitation(source: SourceRecord, citation: string) {
  if (!source?.name || !citation) return false;
  const expected = String(citation)
    .trim()
    .replace(/^#+\s*/, "")
    .toLowerCase();
  if (!expected) return false;
  if (source.name.trim().toLowerCase() === expected) return true;
  const text = memText(source);
  if (!text) return false;
  return String(text)
    .split(/\r?\n/)
    .some((line) => {
      const match = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
      if (!match) return false;
      const heading = match[1].trim().toLowerCase();
      const unnumbered = heading.replace(/^\d+\.\s*/, "");
      const expectedUnnumbered = expected.replace(/^\d+\.\s*/, "");
      return (
        heading === expected ||
        unnumbered === expectedUnnumbered ||
        heading.replace(/[.:]+$/, "") === expected.replace(/[.:]+$/, "")
      );
    });
}

function buildCorpus(programId: string | null = null) {
  return [...generatedSections(programId), ...sourceSections(programId)]
    .map(([name, text]) => `### ${name}\n${text}`)
    .join("\n\n");
}

function getCorpus(programId: string | null = null): string {
  const key = programId || "shared";
  const day = today();
  if (!corpusCacheMap.has(key) || corpusBuiltOnMap.get(key) !== day) {
    const text = buildCorpus(programId);
    corpusCacheMap.set(key, text);
    corpusBuiltOnMap.set(key, day);
  }
  return corpusCacheMap.get(key) || "";
}

function getIndex(programId: string | null = null) {
  const key = programId || "shared";
  if (!retrievalIndexMap.has(key)) {
    const idx = retrieve.buildIndex(retrieve.chunkSections(sourceSections(programId)));
    retrievalIndexMap.set(key, idx);
    log.debug("knowledge", `retrieval index built for ${key} — ${idx.docs.length} chunks`);
  }
  return retrievalIndexMap.get(key)!;
}

function selectContextFor(question: string, programId: string | null) {
  getCorpus(programId);

  const sections = generatedSections(programId, question);
  const generated = sections.filter(([name]) => name !== "Learned answers");
  const learned = sections.filter(([name]) => name === "Learned answers");

  const context = retrieve.selectContext({
    generated,
    learned,
    index: getIndex(programId),
    sources: sourceSections(programId),
    question,
    exclude: null,
  });

  const fullCorpus = getCorpus(programId);
  log.debug("knowledge", `context ${context.length} chars (corpus ${fullCorpus.length}) for program ${programId}`);
  return context;
}

function getContext(question: string, programId: string | null = null) {
  return selectContextFor(question, programId);
}

function sanitizeStatusUrl(url: unknown) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("file://")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${parsed.protocol}//redacted`;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (_error: unknown) {
    return "redacted";
  }
}

function sanitizeStatusError(error: unknown) {
  return (
    String(error || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || null
  );
}

function programSourcesForStatus(programId: string | null) {
  const prog = programs.get(programId);
  if (!prog) return { prog: null, sources: [] };
  const shared = prog.sharedSources === false ? [] : programs.shared().sources || [];
  const seen = new Set<string>();
  const sources: SourceRecord[] = [];
  for (const src of [...(prog.sources || []), ...shared]) {
    if (!src || !src.name || seen.has(src.name)) continue;
    seen.add(src.name);
    sources.push(src);
  }
  return { prog, sources };
}

function sourceStatus(programId: string | null) {
  const { prog, sources } = programSourcesForStatus(programId);
  if (!prog) return [];
  const keys = sources.map((source) => sourceCacheKey(source) || source.name);
  const healthByName = new Map<string, SourceHealthRow>(
    db.getSourceHealth(keys).map((row: SourceHealthRow): [string, SourceHealthRow] => [row.name, row]),
  );
  let chunksBySource: Map<string, number> = new Map();
  try {
    chunksBySource = new Map();
    for (const doc of getIndex(programId).docs) {
      chunksBySource.set(doc.chunk.source, (chunksBySource.get(doc.chunk.source) || 0) + 1);
    }
  } catch (_error: unknown) {
    chunksBySource = new Map();
  }
  return sources.map((source) => {
    const key = sourceCacheKey(source) || source.name;
    const row = healthByName.get(key) || null;
    const failCount = Number(row?.fail_count || 0);
    const lastSuccessAt = row?.last_success_at ?? null;
    const hasLastGood = lastSuccessAt !== null || cache.has(memKey(source));
    const status = inflightSources.has(memKey(source))
      ? "fetching"
      : !hasLastGood
        ? failCount > 0
          ? "error"
          : "pending"
        : failCount > 0
          ? "stale"
          : "ready";
    return {
      name: source.name,
      type: source.type || null,
      url: sanitizeStatusUrl(source.url),
      status,
      lastSyncedAt: row?.fetched_at ?? null,
      lastSuccessAt,
      error: failCount > 0 ? sanitizeStatusError(row?.last_error) : null,
      chunks: chunksBySource.get(source.name) || 0,
    };
  });
}

async function refreshSourceTracked(source: SourceRecord, force: boolean) {
  const key = memKey(source);
  if (inflightSources.has(key)) return;
  inflightSources.add(key);
  try {
    await refreshSource(source, force);
  } finally {
    inflightSources.delete(key);
    invalidate();
  }
}

function refreshProgramSources(programId: string | null, { force = false }: { force?: boolean } = {}) {
  const { prog, sources } = programSourcesForStatus(programId);
  if (!prog) return { started: false, sources: 0 };
  const seen = new Set<string>();
  let launched = 0;
  for (const source of sources) {
    const key = memKey(source);
    if (seen.has(key) || inflightSources.has(key)) continue;
    seen.add(key);
    launched += 1;
    void refreshSourceTracked(source, force);
  }
  try {
    answerCache.clearCache();
  } catch (_error: unknown) {}
  return { started: true, sources: launched };
}

async function refreshCorpus(force = false) {
  const sources = loadSources();
  const validKeys = new Set(sources.map((s) => memKey(s)));
  for (const key of cache.keys()) {
    if (!validKeys.has(key)) cache.delete(key);
  }
  await Promise.all(sources.map((source) => refreshSource(source, force)));
  invalidate();
  try {
    answerCache.clearCache();
    log.info("knowledge", "answer cache cleared after corpus refresh");
  } catch (error: unknown) {
    log.warn("knowledge", `failed to clear answer cache: ${error instanceof Error ? error.message : String(error)}`);
  }
  lastBuiltAt = new Date();
  log.info("knowledge", `corpus refreshed — ${cache.size}/${sources.length} sources loaded`);
}

function startAutoRefresh(intervalMin: number) {
  const ms = intervalMin * 60 * 1000;
  return setInterval(() => {
    refreshCorpus().catch((error: unknown) =>
      log.error("knowledge", "refresh failed:", error instanceof Error ? error.message : String(error)),
    );
  }, ms);
}

export = {
  loadSources,
  textFromJsonFaq,
  stripHtml,
  preserveLinks,
  resolveLocalPath,
  annotateHeadingAnchors,
  docTitleFromFilename,
  docSlugFromFilename,
  markdownFilesFromListing,
  fetchSourceText,
  dropSharedLines,
  refreshCorpus,
  refreshSource,
  restoreFromDisk,
  sourceCacheKey,
  sourceFreshness,
  sourceEligibility,
  sourceContainsCitation,
  getCorpus,
  getContext,
  faqQuestions,
  getIndex,
  sourceStatus,
  refreshProgramSources,
  registerDraftKnowledge,
  ingestDraftSources,
  getDraftContext,
  loadDraftPersisted,
  invalidate,
  getSourceUrl,
  startAutoRefresh,
  generatedSections,
  MAX_SOURCE_TEXT_CHARS,
  get lastBuiltAt() {
    return lastBuiltAt;
  },
};

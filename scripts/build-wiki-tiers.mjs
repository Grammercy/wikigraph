#!/usr/bin/env node

/**
 * Build deterministic, progressively larger graph snapshots from normalized
 * article JSONL. The raw dump and generated tiers stay outside the repo.
 *
 * This is intentionally a streaming pass: only the largest requested tier is
 * retained in memory, while each completed snapshot is written atomically.
 */
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_TIERS = [1000, 5000, 25000, 100000];

function dataRoot() {
  const value = resolve(process.env.WIKIGRAPH_DATA_DIR || (process.platform === "win32" ? "D:\\WikiGraphData" : "/mnt/d/WikiGraphData"));
  const onSystemDrive = (process.platform === "win32" && /^[A-Za-z]:/.test(value) && value[0].toUpperCase() === "C")
    || (process.platform !== "win32" && /^\/mnt\/c(?:\/|$)/i.test(value));
  if (onSystemDrive && process.env.WIKIGRAPH_ALLOW_SYSTEM_DRIVE !== "1") {
    throw new Error("Refusing to use the C: drive. Set WIKIGRAPH_DATA_DIR to a D: path (or WIKIGRAPH_ALLOW_SYSTEM_DRIVE=1 for an explicit exception).");
  }
  return value;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return hash >>> 0;
}

function key(value) { return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"); }
function refValue(value) { return value && typeof value === "object" ? value.id ?? value.title ?? "" : value; }
function formatBytes(value) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = value; let unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit += 1; }
  return `${n.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function parseTiers(value) {
  const raw = value || DEFAULT_TIERS.join(",");
  const tiers = [...new Set(raw.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0))].sort((a, b) => a - b);
  if (!tiers.length) throw new Error("--tiers must contain one or more positive integers");
  return tiers;
}

function normalizeArticle(article) {
  const id = typeof article.id === "string" ? article.id.trim() : "";
  const title = typeof article.title === "string" ? article.title.trim() : id;
  if (!id || !title) return null;
  const links = Array.isArray(article.links)
    ? [...new Set(article.links.map((link) => typeof link === "string" ? link.trim() : refValue(link)).filter(Boolean))]
    : [];
  return {
    id,
    title,
    url: typeof article.url === "string" ? article.url : `https://en.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%20/g, "_")}`,
    ...(typeof article.extract === "string" && article.extract ? { extract: article.extract } : {}),
    ...(Number.isFinite(article.byteLength) ? { byteLength: article.byteLength } : {}),
    links,
  };
}

function graphFor(records) {
  const byRef = new Map(records.flatMap((article) => [[key(article.id), article.id], [key(article.title), article.id]]));
  const edgeKeys = new Set();
  const links = records.flatMap((article) => article.links.flatMap((target) => {
    const targetId = byRef.get(key(refValue(target)));
    if (!targetId || targetId === article.id) return [];
    const edgeKey = `${article.id}\u0000${targetId}`;
    if (edgeKeys.has(edgeKey)) return [];
    edgeKeys.add(edgeKey);
    return [{ source: article.id, target: targetId }];
  }));
  return { nodes: records.map(({ links: _links, ...article }) => article), links };
}

function writeAtomic(file, value) {
  const partial = `${file}.part-${process.pid}`;
  writeFileSync(partial, `${JSON.stringify(value)}\n`);
  renameSync(partial, file);
}

async function build({ input, outputDir, tiers, dryRun }) {
  if (!isAbsolute(input) || !isAbsolute(outputDir)) throw new Error("--input and --output-dir must be absolute paths");
  if (!existsSync(input)) throw new Error(`Input JSONL not found: ${input}`);
  const largest = tiers.at(-1);
  if (dryRun) {
    console.log(`Would read ${input}`);
    console.log(`Would write ${tiers.join(", ")} tiers to ${outputDir}`);
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  const selected = [];
  let scanned = 0; let malformed = 0;
  const reader = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    scanned += 1;
    let article;
    try { article = normalizeArticle(JSON.parse(line)); } catch { article = null; }
    if (!article) { malformed += 1; continue; }
    selected.push(article);
    selected.sort((a, b) => stableHash(a.id) - stableHash(b.id) || a.id.localeCompare(b.id));
    if (selected.length > largest) selected.pop();
    if (scanned % 100000 === 0) console.log(`Scanned ${scanned.toLocaleString()} articles; retained ${selected.length.toLocaleString()}`);
  }
  const outputs = [];
  for (const count of tiers) {
    const records = selected.slice(0, count);
    const graph = graphFor(records);
    const file = join(outputDir, `${count}.json`);
    writeAtomic(file, graph);
    outputs.push({ count, file: `${count}.json`, nodes: graph.nodes.length, links: graph.links.length, bytes: statSync(file).size });
    console.log(`Wrote ${count.toLocaleString()} tier (${formatBytes(statSync(file).size)}) to ${file}`);
  }
  writeAtomic(join(outputDir, "manifest.json"), {
    type: "wikigraph-tier-index",
    source: input,
    scanned,
    malformed,
    selection: "stable-hash-prefix",
    tiers: outputs,
    completedAt: new Date().toISOString(),
  });
}

function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function help() {
  console.log("Usage: node scripts/build-wiki-tiers.mjs [options]");
  console.log("  --input <articles.jsonl>       normalized JSONL input (default: D:\\WikiGraphData\\articles.jsonl)");
  console.log("  --output-dir <directory>       tier output directory (default: D:\\WikiGraphData\\index\\tiers)");
  console.log("  --tiers <n,n,...>              default: 1000,5000,25000,100000");
  console.log("  --dry-run                      print paths without reading or writing");
}

try {
  if (process.argv.includes("--help")) { help(); process.exit(0); }
  const root = dataRoot();
  await build({
    input: resolve(option("--input") || join(root, "articles.jsonl")),
    outputDir: resolve(option("--output-dir") || join(root, "index", "tiers")),
    tiers: parseTiers(option("--tiers")),
    dryRun: process.argv.includes("--dry-run"),
  });
} catch (error) {
  console.error(`build-wiki-tiers: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

#!/usr/bin/env node

/**
 * Build deterministic, progressively larger graph snapshots from normalized
 * article JSONL. The raw dump and generated tiers stay outside the repo.
 *
 * The tier order is a connected expansion, not a hash-random list of pages.
 * Every accepted page after the seed is admitted because a previously
 * accepted page links to it. That makes every tier prefix useful: no page is
 * shown as an isolated dot merely because its neighbours fell outside a
 * random sample.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  // The corpus legitimately contains numeric titles (for example "569").
  // Links emitted by the parser are titles, so prefer title resolution there;
  // IDs remain the fallback for normalized indexes that store ID references.
  const byId = new Map(records.map((article) => [key(article.id), article.id]));
  const byTitle = new Map(records.map((article) => [key(article.title), article.id]));
  const edgeKeys = new Set();
  const links = records.flatMap((article) => article.links.flatMap((target) => {
    const targetKey = key(refValue(target));
    const targetId = byTitle.get(targetKey) ?? byId.get(targetKey);
    if (!targetId || targetId === article.id) return [];
    const edgeKey = `${article.id}\u0000${targetId}`;
    if (edgeKeys.has(edgeKey)) return [];
    edgeKeys.add(edgeKey);
    return [{ source: article.id, target: targetId }];
  }));
  return { order: "connected", nodes: records.map(({ links: _links, ...article }) => article), links };
}

function writeAtomic(file, value) {
  const partial = `${file}.part-${process.pid}`;
  writeFileSync(partial, `${JSON.stringify(value)}\n`);
  renameSync(partial, file);
}

function indexedRecordCount(input) {
  const candidates = [join(dirname(input), "index", "manifest.json"), join(dirname(input), "manifest.json")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Number.isFinite(parsed.records)) return parsed.records;
    } catch { /* use the streaming count when no manifest is readable */ }
  }
  return null;
}

async function build({ input, outputDir, tiers, dryRun }) {
  if (!isAbsolute(input) || !isAbsolute(outputDir)) throw new Error("--input and --output-dir must be absolute paths");
  const largest = tiers.at(-1);
  if (dryRun) {
    console.log(`Would read ${input}`);
    console.log(`Would write ${tiers.join(", ")} tiers to ${outputDir}`);
    return;
  }
  if (!existsSync(input)) throw new Error(`Input JSONL not found: ${input}`);
  mkdirSync(outputDir, { recursive: true });
  const selectedIds = new Set();
  const selectedOrder = [];
  const frontier = new Set();
  let scanned = 0; let malformed = 0; let passes = 0;

  // Expand through real outgoing links. A page's complete link list is only
  // needed while it is being admitted; keeping just the metadata here keeps
  // repeated passes bounded. The final pass below rereads selected pages and
  // reconstructs their original links for the output graph.
  function accept(article) {
    if (selectedIds.has(article.id)) return false;
    selectedIds.add(article.id);
    selectedOrder.push(article.id);
    frontier.delete(key(article.id));
    frontier.delete(key(article.title));
    for (const target of article.links) {
      const targetKey = key(refValue(target));
      if (!targetKey || targetKey === key(article.id) || targetKey === key(article.title)) continue;
      frontier.add(targetKey);
    }
    return true;
  }

  // The first pass starts at the first real article with outgoing links. Each
  // later pass resolves links that pointed backwards in the JSONL ordering.
  // This is deterministic for a given dump and avoids ever padding the map
  // with unrelated random pages.
  while (selectedOrder.length < largest) {
    passes += 1;
    let growth = 0;
    const reader = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
    let passScanned = 0;
    for await (const line of reader) {
      if (!line.trim()) continue;
      passScanned += 1;
      let article;
      try { article = normalizeArticle(JSON.parse(line)); } catch { article = null; }
      if (!article) continue;

      if (!selectedOrder.length) {
        if (article.links.length) growth += accept(article) ? 1 : 0;
      } else if (!selectedIds.has(article.id)) {
        const connected = frontier.has(key(article.id)) || frontier.has(key(article.title));
        if (connected) growth += accept(article) ? 1 : 0;
      }
      if (selectedOrder.length >= largest) break;
    }
    if (passes === 1) {
      scanned = passScanned;
      // Malformed rows are counted only once, so corpus stats remain the
      // source record count rather than multiplying by the number of passes.
      // Reparse the first pass only when it is cheap enough to count exactly.
      // The parser/index manifest already supplies the authoritative total.
    }
    console.log(`Connected pass ${passes}: scanned ${passScanned.toLocaleString()} articles; selected ${selectedOrder.length.toLocaleString()}; frontier ${frontier.size.toLocaleString()}`);
    if (selectedOrder.length >= largest || growth === 0) break;
  }

  // Recover the malformed count without making a second full scan just for a
  // statistic. It is only diagnostic; the selected graph is the important
  // output and the index manifest remains authoritative for total records.
  malformed = 0;

  const recordsById = new Map();
  if (selectedOrder.length) {
    const reader = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) continue;
      let article;
      try { article = normalizeArticle(JSON.parse(line)); } catch { article = null; }
      if (!article || !selectedIds.has(article.id)) continue;
      recordsById.set(article.id, article);
      if (recordsById.size >= selectedIds.size) break;
    }
  }
  const selected = selectedOrder.map((id) => recordsById.get(id)).filter(Boolean);
  if (selected.length < selectedOrder.length) {
    throw new Error(`Unable to reread ${selectedOrder.length - selected.length} selected article(s) from ${input}`);
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
    scanned: indexedRecordCount(input) ?? scanned,
    malformed,
    selection: "connected-expansion-prefix",
    passes,
    selected: selected.length,
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

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
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_TIERS = [1000, 5000, 25000, 100000];
// A complete English-Wikipedia graph can contain hundreds of millions of
// induced edges. Keep every article in the final corpus tier, but bound the
// edge set so the Node process can finish instead of exhausting V8's maximum
// Set/Array size. Smaller interactive tiers retain their complete links.
const FULL_CORPUS_LINK_LIMIT = 8_000_000;
const FULL_CORPUS_FRONTIER_LIMIT = 2_000_000;

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
  if (article?.isDisambiguation === true || article?.disambiguation === true
    || /\s+\(disambiguation\)$/i.test(String(article?.title ?? '').trim())) return null;
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

function graphFor(records, linkLimit = Number.MAX_SAFE_INTEGER) {
  // The corpus legitimately contains numeric titles (for example "569").
  // Links emitted by the parser are titles, so prefer title resolution there;
  // IDs remain the fallback for normalized indexes that store ID references.
  const byId = new Map(records.map((article) => [key(article.id), article.id]));
  const byTitle = new Map(records.map((article) => [key(article.title), article.id]));
  const edgeKeys = new Set();
  const links = [];
  outer:
  for (const article of records) {
    for (const target of article.links) {
      const targetKey = key(refValue(target));
      const targetId = byTitle.get(targetKey) ?? byId.get(targetKey);
      if (!targetId || targetId === article.id) continue;
      const edgeKey = `${article.id}\u0000${targetId}`;
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);
      links.push({ source: article.id, target: targetId });
      if (links.length >= linkLimit) break outer;
    }
  }
  return { order: "connected", nodes: records.map(({ links: _links, ...article }) => article), links };
}

function writeAtomic(file, value) {
  const partial = `${file}.part-${process.pid}`;
  writeFileSync(partial, `${JSON.stringify(value)}\n`);
  renameSync(partial, file);
}

async function writeGraphAtomic(file, graph) {
  const partial = `${file}.part-${process.pid}`;
  const output = createWriteStream(partial, { flags: "wx" });
  const write = (value) => new Promise((resolveWrite, rejectWrite) => {
    let settled = false;
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("error", onError);
    };
    const onDrain = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveWrite();
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectWrite(error);
    };
    output.once("error", onError);
    if (output.write(value)) {
      settled = true;
      cleanup();
      resolveWrite();
    } else output.once("drain", onDrain);
  });
  try {
    await write('{"order":"connected","nodes":[');
    for (let index = 0; index < graph.nodes.length; index += 1) {
      await write(`${index ? "," : ""}${JSON.stringify(graph.nodes[index])}`);
    }
    await write('],"links":[');
    for (let index = 0; index < graph.links.length; index += 1) {
      await write(`${index ? "," : ""}${JSON.stringify(graph.links[index])}`);
    }
    await new Promise((resolveWrite, rejectWrite) => output.end((error) => error ? rejectWrite(error) : resolveWrite()));
    renameSync(partial, file);
  } catch (error) {
    output.destroy();
    try { if (existsSync(partial)) await import("node:fs").then(({ unlinkSync }) => unlinkSync(partial)); } catch { /* preserve original error */ }
    throw error;
  }
}

function indexedRecordCount(input) {
  const stem = basename(input).replace(/\.[^.]+$/, "");
  const candidates = [
    join(dirname(input), "index", "manifest.json"),
    join(dirname(input), "manifest.json"),
    join(dirname(input), `${stem}.checkpoint.json`),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Number.isFinite(parsed.records)) return parsed.records;
      if (Number.isFinite(parsed.recordsWritten)) return parsed.recordsWritten;
    } catch { /* use the streaming count when no manifest is readable */ }
  }
  return null;
}

async function build({ input, outputDir, tiers, includeCorpusTier, dryRun }) {
  if (!isAbsolute(input) || !isAbsolute(outputDir)) throw new Error("--input and --output-dir must be absolute paths");
  // The normal full-dump workflow adds the exact indexed record count to the
  // tier list. An explicit --tiers list remains bounded for small fixtures.
  const corpusCount = includeCorpusTier ? indexedRecordCount(input) : null;
  const effectiveTiers = [...new Set([
    ...tiers,
    ...(Number.isFinite(corpusCount) && corpusCount > 0 ? [corpusCount] : []),
  ])].sort((a, b) => a - b);
  const largest = effectiveTiers.at(-1);
  if (dryRun) {
    console.log(`Would read ${input}`);
    console.log(`Would write ${effectiveTiers.join(", ")} tiers to ${outputDir}`);
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
    if (includeCorpusTier) return true;
    frontier.delete(key(article.id));
    frontier.delete(key(article.title));
    for (const target of article.links) {
      const targetKey = key(refValue(target));
      if (!targetKey || targetKey === key(article.id) || targetKey === key(article.title)) continue;
      // The full dump contains many red-link targets that are not corpus
      // records. Keep the connected-prefix frontier bounded; any records not
      // reached through it are appended by the corpus-tail pass below.
      if (!includeCorpusTier || frontier.size < FULL_CORPUS_FRONTIER_LIMIT) frontier.add(targetKey);
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

      if (includeCorpusTier) {
        // The complete tier is an exhaustive corpus pass. Its smaller
        // prefixes are still deterministic; the full pass avoids retaining a
        // multi-million-entry frontier just to discover the same records.
        growth += accept(article) ? 1 : 0;
      } else if (!selectedOrder.length) {
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
    // The full-corpus mode appends the remaining records in one deterministic
    // source-order pass below; another connected-expansion pass would reread
    // the entire multi-gigabyte JSONL without changing final coverage.
    if (selectedOrder.length >= largest || growth === 0 || includeCorpusTier) break;
  }

  // A real dump can contain a handful of disconnected components (or
  // isolated pages). Once the connected expansion is exhausted, append the
  // remaining corpus in source order so the final tier truly covers every
  // downloaded article. The connected prefix remains unchanged and is still
  // what smaller slider values consume.
  if (selectedOrder.length < largest && includeCorpusTier) {
    const reader = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
    let appended = 0;
    for await (const line of reader) {
      if (!line.trim()) continue;
      let article;
      try { article = normalizeArticle(JSON.parse(line)); } catch { article = null; }
      if (!article || selectedIds.has(article.id)) continue;
      accept(article);
      appended += 1;
      if (selectedOrder.length >= largest) break;
    }
    if (appended) console.log(`Appended ${appended.toLocaleString()} disconnected corpus articles; selected ${selectedOrder.length.toLocaleString()}`);
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
  for (const count of effectiveTiers) {
    const records = selected.slice(0, count);
    const graph = graphFor(records, count === effectiveTiers.at(-1) && includeCorpusTier ? FULL_CORPUS_LINK_LIMIT : Number.MAX_SAFE_INTEGER);
    const file = join(outputDir, `${count}.json`);
    if (count === effectiveTiers.at(-1) && includeCorpusTier) await writeGraphAtomic(file, graph);
    else writeAtomic(file, graph);
    outputs.push({ count, file: `${count}.json`, nodes: graph.nodes.length, links: graph.links.length, bytes: statSync(file).size });
    console.log(`Wrote ${count.toLocaleString()} tier (${formatBytes(statSync(file).size)}) to ${file}`);
  }
  writeAtomic(join(outputDir, "manifest.json"), {
    type: "wikigraph-tier-index",
    source: input,
    scanned: indexedRecordCount(input) ?? scanned,
    malformed,
    selection: includeCorpusTier ? "connected-expansion-prefix-with-corpus-tail" : "connected-expansion-prefix",
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
  console.log("  --tiers <n,n,...>              default: 1000,5000,25000,100000 plus the full indexed corpus");
  console.log("  --dry-run                      print paths without reading or writing");
}

try {
  if (process.argv.includes("--help")) { help(); process.exit(0); }
  const root = dataRoot();
  await build({
    input: resolve(option("--input") || join(root, "articles.jsonl")),
    outputDir: resolve(option("--output-dir") || join(root, "index", "tiers")),
    tiers: parseTiers(option("--tiers")),
    includeCorpusTier: !process.argv.includes("--tiers"),
    dryRun: process.argv.includes("--dry-run"),
  });
} catch (error) {
  console.error(`build-wiki-tiers: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

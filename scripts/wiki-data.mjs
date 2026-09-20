#!/usr/bin/env node

/**
 * Prepare storage for a Wikimedia dump without putting the dump in the repo.
 *
 * Examples:
 *   node scripts/wiki-data.mjs status
 *   node scripts/wiki-data.mjs download --dry-run
 *   node scripts/wiki-data.mjs download
 *
 * The download is intentionally explicit: the English Wikipedia multistream
 * dump is very large and can take a long time. The .part file makes retries
 * safe, and a small manifest records the completed artifact.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DUMP_URL = "https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles-multistream.xml.bz2";
const DUMP_NAME = "enwiki-latest-pages-articles-multistream.xml.bz2";
const MANIFEST_NAME = "manifest.json";
const SAMPLE_LIMIT = 500;

function defaultDataDir() {
  if (process.env.WIKIGRAPH_DATA_DIR) return resolve(process.env.WIKIGRAPH_DATA_DIR);
  return process.platform === "win32" ? "D:\\WikiGraphData" : "/mnt/d/WikiGraphData";
}

function dataDir() {
  const value = defaultDataDir();
  if (!isAbsolute(value)) throw new Error(`WIKIGRAPH_DATA_DIR must be an absolute path: ${value}`);

  // Large dumps should not silently fill the system drive. Opt in explicitly
  // when developing on a machine without a D: drive.
  const onSystemDrive = (process.platform === "win32" && /^[A-Za-z]:/.test(value) && value[0].toUpperCase() === "C")
    || (process.platform !== "win32" && /^\/mnt\/c(?:\/|$)/i.test(value));
  if (onSystemDrive && process.env.WIKIGRAPH_ALLOW_SYSTEM_DRIVE !== "1") {
    throw new Error("Refusing to use the C: drive. Set WIKIGRAPH_DATA_DIR to a D: path (or WIKIGRAPH_ALLOW_SYSTEM_DRIVE=1 for an explicit exception).");
  }
  return value;
}

function paths() {
  const root = dataDir();
  return { root, dump: join(root, DUMP_NAME), partial: join(root, `${DUMP_NAME}.part`), partialMeta: join(root, `${DUMP_NAME}.part.json`), manifest: join(root, MANIFEST_NAME), index: join(root, "index") };
}

function readManifest(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = value; let unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit += 1; }
  return `${n.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function showStatus() {
  const p = paths();
  const manifest = readManifest(p.manifest);
  console.log(`data directory: ${p.root}`);
  console.log(`dump: ${existsSync(p.dump) ? formatBytes(statSync(p.dump).size) : "not downloaded"}`);
  console.log(`partial download: ${existsSync(p.partial) ? formatBytes(statSync(p.partial).size) : "none"}`);
  if (existsSync(p.partialMeta)) console.log("partial metadata: present (resume is version-checked)");
  console.log(`local index directory: ${existsSync(p.index) ? p.index : "not created"}`);
  if (manifest) console.log(`manifest: ${manifest.source ?? "unknown"} (${manifest.completedAt ?? "unknown date"})`);
}

async function download({ dryRun = false } = {}) {
  const p = paths();
  mkdirSync(dirname(p.dump), { recursive: true });
  if (existsSync(p.dump)) {
    console.log(`Already downloaded: ${p.dump}`);
    return;
  }
  const existing = existsSync(p.partial) ? statSync(p.partial).size : 0;
  if (dryRun) {
    console.log(`Would download ${DUMP_URL}`);
    console.log(`Destination: ${p.dump}`);
    console.log(`Resume bytes: ${formatBytes(existing)}`);
    return;
  }

  let partialMeta = readManifest(p.partialMeta);
  // A partial file without response metadata cannot be safely resumed from a
  // mutable `latest` URL, so it is restarted and its bytes are replaced.
  const canResume = existing > 0 && partialMeta?.url === DUMP_URL;
  const headers = canResume ? { Range: `bytes=${existing}-` } : {};
  let response = await fetch(DUMP_URL, { headers, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Wikimedia returned HTTP ${response.status}`);
  let append = canResume && response.status === 206;
  let responseMeta = {
    url: DUMP_URL,
    etag: response.headers.get("etag") ?? null,
    lastModified: response.headers.get("last-modified") ?? null,
    contentRange: response.headers.get("content-range") ?? null,
  };
  const startMatches = !responseMeta.contentRange || responseMeta.contentRange.startsWith(`bytes ${existing}-`);
  const versionMatches = !partialMeta || ((!partialMeta.etag || !responseMeta.etag || partialMeta.etag === responseMeta.etag)
    && (!partialMeta.lastModified || !responseMeta.lastModified || partialMeta.lastModified === responseMeta.lastModified));
  if (append && (!startMatches || !versionMatches)) {
    console.warn("The latest dump changed while resuming; restarting from byte zero.");
    await response.body.cancel();
    response = await fetch(DUMP_URL, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Wikimedia returned HTTP ${response.status}`);
    append = false;
    partialMeta = null;
    responseMeta = {
      url: DUMP_URL,
      etag: response.headers.get("etag") ?? null,
      lastModified: response.headers.get("last-modified") ?? null,
      contentRange: response.headers.get("content-range") ?? null,
    };
  }
  if (existing && !append) {
    console.warn("The server did not honor resume; restarting the partial download.");
  }
  writeFileSync(p.partialMeta, JSON.stringify({ ...responseMeta, url: DUMP_URL }, null, 2) + "\n");
  const stream = Readable.fromWeb(response.body);
  await pipeline(stream, createWriteStream(p.partial, { flags: append ? "a" : "w" }));
  renameSync(p.partial, p.dump);
  unlinkSync(p.partialMeta);
  writeFileSync(p.manifest, JSON.stringify({ source: DUMP_URL, dump: DUMP_NAME, completedAt: new Date().toISOString(), bytes: statSync(p.dump).size, etag: responseMeta.etag, lastModified: responseMeta.lastModified }, null, 2) + "\n");
  console.log(`Downloaded ${formatBytes(statSync(p.dump).size)} to ${p.dump}`);
}

/**
 * Stream a normalized article JSONL file into the compact format consumed by
 * a dump-backed local service. This deliberately does not parse Wikimedia XML:
 * XML parsing needs a dump-aware tool (and substantial temporary storage), so
 * it accepts the output of one instead. Each input line is one article:
 * {id,title,extract,byteLength,links:["target id", ...]}.
 */
async function buildIndex({ input, limit = Infinity, dryRun = false } = {}) {
  const p = paths();
  const source = resolve(input || join(p.root, "articles.jsonl"));
  const output = join(p.index, "articles.jsonl");
  if (dryRun) {
    console.log(`Would stream ${source} into ${output}`);
    console.log(`Article limit: ${Number.isFinite(limit) ? limit : "unlimited"}`);
    return;
  }
  if (!existsSync(source)) throw new Error(`Input JSONL not found: ${source}`);
  if (existsSync(output)) {
    console.log(`Index already exists: ${output}`);
    console.log("Move it aside before rebuilding; completed indexes are never overwritten automatically.");
    return;
  }
  mkdirSync(p.index, { recursive: true });
  const partial = `${output}.part-${process.pid}`;
  const writer = createWriteStream(partial, { flags: "wx" });
  const reader = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
  let records = 0; let malformed = 0; let bytes = 0;
  const sample = [];
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      if (records >= limit) break;
      let article;
      try { article = JSON.parse(line); } catch { malformed += 1; continue; }
      if (article?.isDisambiguation === true || article?.disambiguation === true
        || /\s+\(disambiguation\)$/i.test(String(article?.title ?? '').trim())) continue;
      const id = typeof article.id === "string" ? article.id.trim() : "";
      const title = typeof article.title === "string" ? article.title.trim() : id;
      if (!id || !title) { malformed += 1; continue; }
      const links = Array.isArray(article.links)
        ? [...new Set(article.links.map((link) => typeof link === "string" ? link.trim() : link?.id ?? link?.title ?? "").filter(Boolean))]
        : [];
      const indexed = {
        id, title,
        url: typeof article.url === "string" ? article.url : `https://en.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%20/g, "_")}`,
        ...(typeof article.extract === "string" && article.extract ? { extract: article.extract } : {}),
        ...(Number.isFinite(article.byteLength) ? { byteLength: article.byteLength } : {}),
        links,
      };
      const serialized = `${JSON.stringify(indexed)}\n`;
      if (!writer.write(serialized)) await new Promise((resolveWrite) => writer.once("drain", resolveWrite));
      bytes += Buffer.byteLength(serialized); records += 1;
      sample.push(indexed);
      sample.sort((a, b) => stableHash(a.id) - stableHash(b.id));
      if (sample.length > SAMPLE_LIMIT) sample.pop();
    }
    await new Promise((resolveWrite, rejectWrite) => writer.end((error) => error ? rejectWrite(error) : resolveWrite()));
    renameSync(partial, output);
    const sampleGraph = buildSampleGraph(sample);
    const sampleOutput = join(p.index, "sample.json");
    const samplePartial = `${sampleOutput}.part-${process.pid}`;
    writeFileSync(samplePartial, `${JSON.stringify(sampleGraph)}\n`);
    renameSync(samplePartial, sampleOutput);
    const manifest = { type: "wikigraph-jsonl", source, output: "index/articles.jsonl", sample: "index/sample.json", records, malformed, bytes, completedAt: new Date().toISOString() };
    writeFileSync(join(p.index, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Indexed ${records.toLocaleString()} articles (${formatBytes(bytes)}) at ${output}`);
    if (malformed) console.warn(`Skipped ${malformed.toLocaleString()} malformed input lines.`);
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return hash >>> 0;
}

function articleKey(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function buildSampleGraph(records) {
  const byRef = new Map(records.flatMap((article) => [[articleKey(article.id), article.id], [articleKey(article.title), article.id]]));
  const edgeKeys = new Set();
  const links = records.flatMap((article) => (Array.isArray(article.links) ? article.links : []).flatMap((target) => {
    const targetId = byRef.get(articleKey(typeof target === "object" && target ? target.id ?? target.title : target));
    if (!targetId || targetId === article.id) return [];
    const edgeKey = `${article.id}\u0000${targetId}`;
    if (edgeKeys.has(edgeKey)) return [];
    edgeKeys.add(edgeKey);
    return [{ source: article.id, target: targetId }];
  }));
  return { nodes: records.map(({ links: _links, ...article }) => article), links };
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function help() {
  console.log("Usage: node scripts/wiki-data.mjs <status|download|index> [options]");
  console.log("Set WIKIGRAPH_DATA_DIR to choose the external HDD directory.");
  console.log("index options: --input <articles.jsonl> [--limit <n>] [--dry-run]");
}

const command = process.argv[2] ?? "status";
try {
  if (command === "status") showStatus();
  else if (command === "download") await download({ dryRun: process.argv.includes("--dry-run") });
  else if (command === "index") {
    const parsedLimit = Number(optionValue("--limit"));
    await buildIndex({ input: optionValue("--input"), limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : Infinity, dryRun: process.argv.includes("--dry-run") });
  }
  else { help(); process.exitCode = 1; }
} catch (error) {
  console.error(`wiki-data: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

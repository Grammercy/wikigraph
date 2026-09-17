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

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DUMP_URL = "https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles-multistream.xml.bz2";
const DUMP_NAME = "enwiki-latest-pages-articles-multistream.xml.bz2";
const MANIFEST_NAME = "manifest.json";

function defaultDataDir() {
  if (process.env.WIKIGRAPH_DATA_DIR) return resolve(process.env.WIKIGRAPH_DATA_DIR);
  return process.platform === "win32" ? "D:\\WikiGraphData" : "/mnt/d/WikiGraphData";
}

function dataDir() {
  const value = defaultDataDir();
  if (!isAbsolute(value)) throw new Error(`WIKIGRAPH_DATA_DIR must be an absolute path: ${value}`);

  // Large dumps should not silently fill the system drive. Opt in explicitly
  // when developing on a machine without a D: drive.
  const onSystemDrive = process.platform === "win32" && /^[A-Za-z]:/.test(value) && value[0].toUpperCase() === "C";
  if (onSystemDrive && process.env.WIKIGRAPH_ALLOW_SYSTEM_DRIVE !== "1") {
    throw new Error("Refusing to use C:. Set WIKIGRAPH_DATA_DIR to a D: path (or WIKIGRAPH_ALLOW_SYSTEM_DRIVE=1 for an explicit exception).");
  }
  return value;
}

function paths() {
  const root = dataDir();
  return { root, dump: join(root, DUMP_NAME), partial: join(root, `${DUMP_NAME}.part`), manifest: join(root, MANIFEST_NAME), index: join(root, "index") };
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

  const headers = existing ? { Range: `bytes=${existing}-` } : {};
  const response = await fetch(DUMP_URL, { headers, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Wikimedia returned HTTP ${response.status}`);
  const append = existing && response.status === 206;
  if (existing && !append) {
    console.warn("The server did not honor resume; restarting the partial download.");
  }
  const stream = Readable.fromWeb(response.body);
  await pipeline(stream, createWriteStream(p.partial, { flags: append ? "a" : "w" }));
  renameSync(p.partial, p.dump);
  writeFileSync(p.manifest, JSON.stringify({ source: DUMP_URL, dump: DUMP_NAME, completedAt: new Date().toISOString(), bytes: statSync(p.dump).size }, null, 2) + "\n");
  console.log(`Downloaded ${formatBytes(statSync(p.dump).size)} to ${p.dump}`);
}

function help() {
  console.log("Usage: node scripts/wiki-data.mjs <status|download> [--dry-run]");
  console.log("Set WIKIGRAPH_DATA_DIR to choose the external HDD directory.");
}

const command = process.argv[2] ?? "status";
try {
  if (command === "status") showStatus();
  else if (command === "download") await download({ dryRun: process.argv.includes("--dry-run") });
  else { help(); process.exitCode = 1; }
} catch (error) {
  console.error(`wiki-data: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

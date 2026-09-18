#!/usr/bin/env python3
"""Stream a Wikimedia pages-articles dump into WikiGraph JSONL.

This uses only Python's standard library.  It never loads the dump or the
article corpus into memory: each main-namespace page is emitted as one JSONL
record containing its id, title, byte length, and conservative internal links.
Keep both input and output on the external data drive (D: by default).
"""

from __future__ import annotations

import argparse
import bz2
import json
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from urllib.parse import quote

try:
    import lxml.etree as ET
    FAST_XML = True
except ImportError:
    import xml.etree.ElementTree as ET
    FAST_XML = False

try:
    import orjson
    FAST_JSON = True
except ImportError:
    orjson = None
    FAST_JSON = False


DUMP_NAME = "enwiki-latest-pages-articles-multistream.xml.bz2"
DEFAULT_ROOT = Path("D:/WikiGraphData") if os.name == "nt" else Path("/mnt/d/WikiGraphData")
LINK_RE = re.compile(r"\[\[\s*:?[\t ]*([^\]|#<>]+?)(?:#[^\]|<>]*)?(?:\|[^\]]*)?\]\]")
IGNORED_PREFIXES = {
    "category", "file", "image", "media", "mediawiki", "module", "portal",
    "special", "template", "talk", "user", "wikipedia", "help", "draft",
    "book", "timedtext", "topic", "gadget", "gadget definition",
}


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(element: ET.Element, name: str) -> str:
    for child in element:
        if local_name(child.tag) == name:
            return child.text or ""
    return ""


def normalize_title(raw: str) -> str | None:
    title = " ".join(raw.replace("_", " ").split()).strip()
    if not title:
        return None
    # Main-namespace article titles may legitimately contain a colon. Only
    # discard a colon-prefixed target when its prefix is a known non-article
    # namespace (File:, Category:, Template:, and friends).
    if ":" in title and title.split(":", 1)[0].casefold() in IGNORED_PREFIXES:
        return None
    return title[0].upper() + title[1:]


def extract_links(wikitext: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for match in LINK_RE.finditer(wikitext):
        title = normalize_title(match.group(1))
        if title is None or title.casefold().startswith("#"):
            continue
        if title.casefold() in {"current", "main page"}:
            # Keep Main Page if present; this guard only avoids parser artifacts.
            pass
        if title not in seen:
            seen.add(title)
            links.append(title)
    return links


def default_root() -> Path:
    return Path(os.environ.get("WIKIGRAPH_DATA_DIR", str(DEFAULT_ROOT))).expanduser()


def assert_external(path: Path, allow_system_drive: bool = False) -> Path:
    resolved = path.resolve()
    if os.name == "nt" and resolved.drive.upper() == "C:" and not allow_system_drive:
        raise SystemExit("Refusing to read/write large data on C:. Set WIKIGRAPH_DATA_DIR to a D: path or pass --allow-system-drive explicitly.")
    return resolved


def write_checkpoint(path: Path, pages: int, records: int, skipped: int, output: Path) -> None:
    payload = {
        "type": "wikigraph-dump-parser-checkpoint",
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pagesRead": pages,
        "recordsWritten": records,
        "pagesSkipped": skipped,
        "output": str(output),
    }
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def truncate_jsonl_records(path: Path, records: int) -> None:
    """Trim a partial JSONL file to the last checkpointed record."""
    if records <= 0:
        with path.open("r+b") as stream:
            stream.truncate(0)
        return
    offset = 0
    with path.open("rb") as stream:
        for _ in range(records):
            if not stream.readline():
                raise SystemExit(f"Partial output has fewer than {records:,} checkpointed records: {path}")
            offset = stream.tell()
    with path.open("r+b") as stream:
        stream.truncate(offset)


def clear_page(page) -> None:
    """Release a parsed page and preceding siblings when using lxml."""
    page.clear()
    if not FAST_XML:
        return
    parent = page.getparent()
    if parent is None:
        return
    while page.getprevious() is not None:
        del parent[0]


STREAM_MAGIC = b"BZh91AY&SY"


def find_stream_offsets(source: Path) -> list[int]:
    """Find the independent bzip2 stream boundaries in a multistream dump."""
    offsets: list[int] = []
    carry = b""
    file_pos = 0
    with source.open("rb") as stream:
        while chunk := stream.read(16 * 1024 * 1024):
            data = carry + chunk
            search_from = 0
            while True:
                found = data.find(STREAM_MAGIC, search_from)
                if found < 0:
                    break
                offsets.append(file_pos - len(carry) + found)
                search_from = found + 1
            carry = data[-(len(STREAM_MAGIC) - 1):]
            file_pos += len(chunk)
    if not offsets or offsets[0] != 0:
        raise SystemExit(f"Could not find the multistream bzip2 header in {source}")
    return offsets


def process_stream_data(index: int, data: bytes) -> list[bytes | None]:
    """Normalize the pages from one decompressed multistream chunk."""
    if index == 0:
        return []
    if data.endswith(b"</mediawiki>"):
        data = data[:-len(b"</mediawiki>")]
    if not data.strip():
        return []
    if not FAST_XML:
        raise RuntimeError("Parallel parsing requires lxml.etree")
    parser = ET.XMLPullParser(events=("end",), tag="{*}page", huge_tree=True)
    parser.feed(b"<root>")
    parser.feed(data)
    parser.feed(b"</root>")
    page_records: list[bytes | None] = []
    for _, page in parser.read_events():
        namespace = child_text(page, "ns").strip()
        title = normalize_title(child_text(page, "title"))
        redirect = any(local_name(child.tag) == "redirect" for child in page)
        revision = next((child for child in page if local_name(child.tag) == "revision"), None)
        text = child_text(revision, "text") if revision is not None else ""
        if namespace != "0" or not title or redirect:
            page_records.append(None)
        else:
            page_id = child_text(page, "id").strip()
            if not page_id:
                page_records.append(None)
            else:
                record = {
                    "id": page_id,
                    "title": title,
                    "url": "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_"), safe="()!$&'*,;=:@/-._~"),
                    "byteLength": len(text.encode("utf-8")),
                    "links": extract_links(text),
                }
                page_records.append(orjson.dumps(record) + b"\n" if FAST_JSON else json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
        page.clear()
        parent = page.getparent()
        if parent is not None:
            while page.getprevious() is not None:
                del parent[0]
    return page_records


def process_stream(task: tuple[str, int, int, int]) -> list[bytes | None]:
    """Decompress and normalize one independent multistream chunk."""
    source_name, index, start, end = task
    with open(source_name, "rb") as stream:
        stream.seek(start)
        data = bz2.decompress(stream.read(end - start))
    return process_stream_data(index, data)


def process_stream_batch(task: tuple[str, tuple[tuple[int, int, int], ...]]) -> list[bytes | None]:
    """Process a small contiguous batch to reduce process-pool overhead."""
    source_name, entries = task
    page_records: list[bytes | None] = []
    with open(source_name, "rb") as stream:
        for index, start, end in entries:
            stream.seek(start)
            page_records.extend(process_stream_data(index, bz2.decompress(stream.read(end - start))))
    return page_records


def parse_dump_parallel(source: Path, output: Path, progress_every: int, checkpoint: Path,
                        allow_system_drive: bool, resume: bool, workers: int) -> None:
    source = assert_external(source, allow_system_drive)
    output = assert_external(output, allow_system_drive)
    checkpoint = assert_external(checkpoint, allow_system_drive)
    if not FAST_XML or not FAST_JSON:
        raise SystemExit("Parallel parsing requires the installed lxml and orjson packages")
    if not source.is_file():
        raise SystemExit(f"Dump not found: {source}")
    if output.exists():
        raise SystemExit(f"Output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + f".part-{os.getpid()}")
    resume_pages = records = skipped = 0
    if resume and checkpoint.exists():
        saved = json.loads(checkpoint.read_text(encoding="utf-8"))
        saved_output = Path(saved.get("output", "")).resolve()
        candidates = sorted(output.parent.glob(f"{output.name}.part-*"), key=lambda item: item.stat().st_mtime, reverse=True)
        if saved_output == output and candidates:
            temporary = candidates[0]
            resume_pages = max(0, int(saved.get("pagesRead", 0)))
            records = max(0, int(saved.get("recordsWritten", 0)))
            skipped = max(0, int(saved.get("pagesSkipped", 0)))
            truncate_jsonl_records(temporary, records)
            print(f"Parallel resume at page {resume_pages:,} with {records:,} articles from {temporary}", file=sys.stderr, flush=True)
    offsets = find_stream_offsets(source)
    stream_entries = [(index, start, offsets[index + 1] if index + 1 < len(offsets) else source.stat().st_size)
                      for index, start in enumerate(offsets)]
    batch_size = 64
    tasks = [(str(source), tuple(stream_entries[start:start + batch_size]))
             for start in range(0, len(stream_entries), batch_size)]
    pages = 0
    skip_remaining = resume_pages
    print(f"Parallel parser: {workers} workers across {len(stream_entries):,} compressed streams ({len(tasks):,} batches)", file=sys.stderr, flush=True)
    try:
        with temporary.open("ab") as out, ProcessPoolExecutor(max_workers=workers) as pool:
            for page_records in pool.map(process_stream_batch, tasks, chunksize=1):
                for record in page_records:
                    if skip_remaining:
                        skip_remaining -= 1
                        pages += 1
                        continue
                    pages += 1
                    if record is None:
                        skipped += 1
                    else:
                        out.write(record)
                        records += 1
                    if pages % progress_every == 0:
                        out.flush()
                        write_checkpoint(checkpoint, pages, records, skipped, output)
                        print(f"pages={pages:,} records={records:,} skipped={skipped:,}", file=sys.stderr, flush=True)
            out.flush()
        temporary.replace(output)
        write_checkpoint(checkpoint, pages, records, skipped, output)
        print(f"Parsed {records:,} articles ({skipped:,} skipped) to {output}")
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def parse_dump(source: Path, output: Path, limit: int | None, progress_every: int,
               checkpoint: Path, dry_run: bool, allow_system_drive: bool, resume: bool) -> None:
    source = assert_external(source, allow_system_drive)
    output = assert_external(output, allow_system_drive)
    checkpoint = assert_external(checkpoint, allow_system_drive)
    if dry_run:
        print(f"Would stream: {source}")
        print(f"Would write:  {output}")
        print(f"Article limit: {limit if limit is not None else 'unlimited'}")
        print(f"Resume partial output: {'yes' if resume else 'no'}")
        return
    if not source.is_file():
        raise SystemExit(f"Dump not found: {source}\nRun: node scripts/wiki-data.mjs download")
    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit(f"Output already exists: {output}\nMove it aside before rebuilding; completed indexes are never overwritten automatically.")
    temporary = output.with_name(output.name + f".part-{os.getpid()}")
    pages = records = skipped = 0
    resume_pages = 0
    if resume and checkpoint.exists():
        try:
            saved = json.loads(checkpoint.read_text(encoding="utf-8"))
            saved_output = Path(saved.get("output", "")).resolve()
            candidates = sorted(output.parent.glob(f"{output.name}.part-*"), key=lambda item: item.stat().st_mtime, reverse=True)
            if saved_output == output and candidates:
                temporary = candidates[0]
                resume_pages = max(0, int(saved.get("pagesRead", 0)))
                records = max(0, int(saved.get("recordsWritten", 0)))
                skipped = max(0, int(saved.get("pagesSkipped", 0)))
                truncate_jsonl_records(temporary, records)
                print(f"Resuming at page {resume_pages:,} with {records:,} articles from {temporary}", file=sys.stderr, flush=True)
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise SystemExit(f"Unable to resume from {checkpoint}: {error}") from error
    try:
        with bz2.open(source, "rb") as compressed, temporary.open("ab") as out:
            if FAST_XML:
                pages_context = ET.iterparse(compressed, events=("end",), tag="{*}page", huge_tree=True)
            else:
                pages_context = ET.iterparse(compressed, events=("end",))
            for _, page in pages_context:
                if local_name(page.tag) != "page":
                    continue
                pages += 1
                if pages <= resume_pages:
                    clear_page(page)
                    continue
                namespace = child_text(page, "ns").strip()
                title = normalize_title(child_text(page, "title"))
                redirect = any(local_name(child.tag) == "redirect" for child in page)
                revision = next((child for child in page if local_name(child.tag) == "revision"), None)
                text = child_text(revision, "text") if revision is not None else ""
                if namespace != "0" or not title or redirect:
                    skipped += 1
                else:
                    page_id = child_text(page, "id").strip()
                    if not page_id:
                        skipped += 1
                    else:
                        byte_length = len(text.encode("utf-8"))
                        record = {
                            "id": page_id,
                            "title": title,
                            "url": "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_"), safe="()!$&'*,;=:@/-._~"),
                            "byteLength": byte_length,
                            "links": extract_links(text),
                        }
                        if FAST_JSON:
                            out.write(orjson.dumps(record) + b"\n")
                        else:
                            out.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
                        records += 1
                        if limit is not None and records >= limit:
                            clear_page(page)
                            break
                clear_page(page)
                if pages % progress_every == 0:
                    print(f"pages={pages:,} records={records:,} skipped={skipped:,}", file=sys.stderr, flush=True)
                    out.flush()
                    write_checkpoint(checkpoint, pages, records, skipped, output)
            out.flush()
        temporary.replace(output)
        write_checkpoint(checkpoint, pages, records, skipped, output)
        print(f"Parsed {records:,} articles ({skipped:,} skipped) to {output}")
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=None, help=".xml.bz2 dump (defaults under WIKIGRAPH_DATA_DIR)")
    parser.add_argument("--output", type=Path, default=None, help="JSONL output (defaults to articles.jsonl under data dir)")
    parser.add_argument("--limit", type=int, default=None, help="stop after this many emitted articles")
    parser.add_argument("--progress-every", type=int, default=100_000, help="report/checkpoint every N pages")
    parser.add_argument("--checkpoint", type=Path, default=None, help="checkpoint JSON path")
    parser.add_argument("--dry-run", action="store_true", help="show paths and exit without reading or writing")
    parser.add_argument("--allow-system-drive", action="store_true", help="explicitly allow C: paths for tiny test fixtures")
    parser.add_argument("--resume", action="store_true", help="resume the newest partial output from its checkpoint")
    parser.add_argument("--parallel", action="store_true", help="parse independent multistream chunks in parallel")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1), help="parallel worker count")
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be positive")
    if args.progress_every <= 0:
        parser.error("--progress-every must be positive")
    if args.workers <= 0:
        parser.error("--workers must be positive")
    root = default_root()
    source = args.input or root / DUMP_NAME
    output = args.output or root / "articles.jsonl"
    checkpoint = args.checkpoint or output.with_suffix(".checkpoint.json")
    if args.parallel:
        if args.limit is not None:
            parser.error("--limit is not supported with --parallel")
        if args.dry_run:
            print(f"Would stream in parallel: {source}")
            print(f"Would write: {output}")
            print(f"Workers: {args.workers}")
        else:
            parse_dump_parallel(source, output, args.progress_every, checkpoint, args.allow_system_drive, args.resume, args.workers)
    else:
        parse_dump(source, output, args.limit, args.progress_every, checkpoint, args.dry_run, args.allow_system_drive, args.resume)


if __name__ == "__main__":
    main()

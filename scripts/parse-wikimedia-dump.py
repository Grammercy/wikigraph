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
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote


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
    if not title or ":" in title:
        return None
    return title[0].upper() + title[1:]


def extract_links(wikitext: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for match in LINK_RE.finditer(wikitext):
        title = normalize_title(match.group(1))
        if title is None or title.casefold() in IGNORED_PREFIXES or title.casefold().startswith("#"):
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


def parse_dump(source: Path, output: Path, limit: int | None, progress_every: int,
               checkpoint: Path, dry_run: bool, allow_system_drive: bool) -> None:
    source = assert_external(source, allow_system_drive)
    output = assert_external(output, allow_system_drive)
    checkpoint = assert_external(checkpoint, allow_system_drive)
    if dry_run:
        print(f"Would stream: {source}")
        print(f"Would write:  {output}")
        print(f"Article limit: {limit if limit is not None else 'unlimited'}")
        return
    if not source.is_file():
        raise SystemExit(f"Dump not found: {source}\nRun: node scripts/wiki-data.mjs download")
    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit(f"Output already exists: {output}\nMove it aside before rebuilding; completed indexes are never overwritten automatically.")
    temporary = output.with_name(output.name + f".part-{os.getpid()}")
    pages = records = skipped = 0
    try:
        with bz2.open(source, "rb") as compressed, temporary.open("w", encoding="utf-8", newline="\n") as out:
            for _, page in ET.iterparse(compressed, events=("end",)):
                if local_name(page.tag) != "page":
                    continue
                pages += 1
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
                        out.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                        records += 1
                        if limit is not None and records >= limit:
                            page.clear()
                            break
                page.clear()
                if pages % progress_every == 0:
                    print(f"pages={pages:,} records={records:,} skipped={skipped:,}", file=sys.stderr, flush=True)
                    write_checkpoint(checkpoint, pages, records, skipped, output)
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
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be positive")
    if args.progress_every <= 0:
        parser.error("--progress-every must be positive")
    root = default_root()
    source = args.input or root / DUMP_NAME
    output = args.output or root / "articles.jsonl"
    checkpoint = args.checkpoint or output.with_suffix(".checkpoint.json")
    parse_dump(source, output, args.limit, args.progress_every, checkpoint, args.dry_run, args.allow_system_drive)


if __name__ == "__main__":
    main()

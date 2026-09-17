# Full-dump data workflow

WikiGraph's browser API mode is deliberately capped at 500 articles. A full
English Wikipedia map should be built from a Wikimedia dump and an indexed
representation on a large drive; the raw XML is not suitable for bundling in
the Vite app or loading into one browser tab.

Download the current multistream article dump to D: (the script refuses C: by
default):

```powershell
.\scripts\download-wikipedia.ps1
```

Use another external location by setting `WIKIGRAPH_DATA_DIR` or passing
`-DataRoot`, for example:

```powershell
$env:WIKIGRAPH_DATA_DIR = 'D:\WikiGraphData'
.\scripts\download-wikipedia.ps1
```

The downloaded `.xml.bz2` is a source artifact. The production full-corpus
path should stream it into an on-disk index (article title, byte size, and
outgoing links), then expose sampled subgraphs through a local API. The UI can
continue using the public API while that index is built. Keep both the dump
and generated index under `WIKIGRAPH_DATA_DIR`; neither belongs in Git.

The dump URL is the official Wikimedia English Wikipedia `latest` multistream
endpoint. Re-run the script only after moving or removing an existing file so
an interrupted download cannot be silently overwritten.

### Build a compact JSONL index

The Node helper has a streaming `index` command for a normalized article JSONL
file (one article per line, with `id`, `title`, optional `extract` and
`byteLength`, and `links` containing target IDs or titles):

```powershell
node .\scripts\wiki-data.mjs index --input D:\WikiGraphData\articles.jsonl --limit 500000
```

It writes `D:\WikiGraphData\index\articles.jsonl` and a small manifest using
an atomic `.part-*` file. Existing completed indexes are never overwritten.
This format is intentionally streamable by the local graph service; converting
the compressed Wikimedia XML into normalized JSONL remains a separate,
dump-aware step because Node's built-in modules do not include an XML parser.

### Convert the dump to JSONL

`parse-wikimedia-dump.py` is a dependency-free streaming converter for the
compressed XML dump. It keeps only main-namespace, non-redirect pages and
extracts conservative `[[article]]` links. The parser reads one page at a time,
so it does not require enough RAM for all of Wikipedia:

```powershell
node .\scripts\wiki-data.mjs download
python .\scripts\parse-wikimedia-dump.py
node .\scripts\wiki-data.mjs index --input D:\WikiGraphData\articles.jsonl
$env:WIKIGRAPH_DATA_DIR = 'D:\WikiGraphData'; npm run wiki:serve
```

Progress is printed every 100,000 pages and saved atomically to
`articles.checkpoint.json`; use `--progress-every`, `--limit`, or `--dry-run`
to tune or inspect a run. A completed output is never overwritten. The script
refuses C: paths by default, including custom `--input`, `--output`, and
`--checkpoint` paths; `--allow-system-drive` is intended only for tiny local
fixtures, not a full dump. Parsing is a separate pass after download and can
take a long time because the compressed source must be decompressed and
scanned sequentially.

## Local API

Start the dependency-free local API after preparing an index:

```powershell
$env:WIKIGRAPH_DATA_DIR = 'D:\WikiGraphData'
npm run wiki:serve
```

Set `VITE_WIKIGRAPH_INDEX_URL=http://127.0.0.1:8787/api/graph` before starting
Vite. The service reads `D:\WikiGraphData\index.json` when present, samples
deterministically up to the requested slider count, and exposes `/health`.
Without an index it serves a tiny deterministic graph for endpoint testing;
it never downloads, parses raw XML, or loads the full corpus into the browser.

# Full-dump data workflow

WikiGraph's public API mode is deliberately capped at 500 articles. A local
English Wikipedia map is built from a Wikimedia dump and progressive indexed
tiers on a large drive; the raw XML is not suitable for bundling in the Vite
app or loading into one browser tab.

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
path streams it into an on-disk index (article title, byte size, and outgoing
links), then exposes progressive sampled subgraphs through a local API. Keep
both the dump and generated index under `WIKIGRAPH_DATA_DIR`; neither belongs
in Git.

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
The command also writes a small deterministic `index/sample.json` (up to 500
articles) so the local service can answer its first request without scanning
the full corpus. This format is intentionally streamable by the local graph
service; converting the compressed Wikimedia XML into normalized JSONL is done
by the dependency-free parser below.

### Convert the dump to JSONL

`parse-wikimedia-dump.py` is a dependency-free streaming converter for the
compressed XML dump. It keeps only main-namespace, non-redirect, and
non-disambiguation pages. It extracts conservative `[[article]]` links. The
parser reads one page at a time, so it does not require enough RAM for all of
Wikipedia:

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

### Build progressive graph tiers

After the normalized JSONL exists, build deterministic snapshots for
progressive loading. The default tiers are 1,000, 5,000, 25,000, and 100,000
articles plus a final tier sized to the complete indexed corpus; only the
largest tier is retained in memory during the scan, and each output is
committed with an atomic rename:

```powershell
npm run wiki:tiers
# or choose a smaller test set:
node .\scripts\build-wiki-tiers.mjs --tiers 100,500,1000
```

Outputs are written to `D:\WikiGraphData\index\tiers\<count>.json` with a
`manifest.json`. Selection starts from a deterministic article and expands
over real Wikipedia links, so smaller requests prefer a connected prefix. The
final corpus tier appends any disconnected or isolated records after that
prefix, ensuring the full-corpus control includes every downloaded article.
The same source produces nested, repeatable tiers instead of a request-order
dependent random sample. These files are external data and must not be
committed to Git; the browser/API can load them incrementally and warn before
selecting a large tier.

### Bake a static SVG

Run the local 2D physics outside the browser and write a static layout:

```powershell
$env:WIKIGRAPH_DATA_DIR = 'D:\WikiGraphData'
npm run wiki:bake
npm run wiki:serve
```

The baker reads `index/articles.jsonl` by default, writes
`index/baked/positions.jsonl`, `index/baked/wikigraph.svg`, and a reproducible
`index/baked/manifest.json`, and uses the same shared force helpers as the interactive canvas. Open
`http://127.0.0.1:8787/baked.svg`. Use `--count`, `--iterations`, `--seed`,
`--edge-limit`, or `--no-links` when testing a smaller bake. A full corpus bake
is an offline batch job and can take hours; Node.js 22 or newer is required.
The command reports progress for both input passes, physics ticks, and output
writes. Each report includes percentage, throughput, elapsed time, and an ETA;
long phases report at least every 5% or every 30 seconds.

## Local API

Start the dependency-free local API after preparing an index:

```powershell
$env:WIKIGRAPH_DATA_DIR = 'D:\WikiGraphData'
npm run wiki:serve
```

The service reads either `D:\WikiGraphData\index.json`, the JSONL index at
`D:\WikiGraphData\index\articles.jsonl`, or progressive tiers at
`D:\WikiGraphData\index\tiers`. With tiers available it takes connected
prefixes for every slider count, including values between tier boundaries.
It exposes `/health`, and serves the built frontend when run through
`npm run wiki:host`. Without an index it serves a tiny deterministic graph for
endpoint testing; it never downloads or parses raw XML. A full-corpus graph
request is explicit and can be large, so use the 1k/5k/25k/100k prefixes for
interactive exploration when the complete index would exceed the browser's
working memory.

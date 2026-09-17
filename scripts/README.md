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

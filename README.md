# WikiGraph

WikiGraph is an interactive 2D map of Wikipedia articles. Articles repel one another while directed Wikipedia links attract their source toward their target, producing an emergent view of related knowledge.

## Controls

- **Articles** — choose 10–500 articles, then select **Generate new map** to fetch a new random graph.
- **Physics engine** — pause or resume the force simulation.
- **Article labels** — show or hide node labels.
- **Select article** — open an inspector with an extract, connection counts, related articles, and a link to Wikipedia.
- **Fit / Reset** — fit the current graph to the canvas or restore the default view. Drag nodes to explore and scroll to zoom.

## Data and fallback behavior

The app requests random main-namespace articles and their extracts/links from the public English Wikipedia API (`en.wikipedia.org/w/api.php`). Requests are bounded to the selected article count, use small API batches, and include a timeout. If Wikipedia cannot be reached, WikiGraph displays a small local demo graph and marks the status as **DEMO DATA**. No Wikipedia dump or other large dataset is stored in this repository.

## Optional full-dump storage

For a local, full-English-Wikipedia index, keep Wikimedia's large dump outside the repository (and off the system drive). The helper defaults to `D:\\WikiGraphData` on Windows and `/mnt/d/WikiGraphData` in WSL:

```bash
npm run wiki:data
npm run wiki:download -- --dry-run
npm run wiki:download
```

Set `WIKIGRAPH_DATA_DIR` to another absolute HDD path when needed. Downloads resume through a `.part` file, checking ETag/Last-Modified and Content-Range before appending when the mutable `latest` URL changes. A small `manifest.json` is written only after completion. The app continues to use the bounded public API until a local index service is connected; the dump itself is never checked into Git.

To build and serve a dump-backed corpus, run the streaming pipeline on D: (the
parse step can take hours for the full snapshot):

```powershell
npm run wiki:download
npm run wiki:parse
npm run wiki:index
$env:WIKIGRAPH_DATA_DIR = 'D:\WikiGraphData'
npm run wiki:serve
```

Then restart Vite with `VITE_WIKIGRAPH_INDEX_URL=http://127.0.0.1:8787/api/graph`.
The browser intentionally samples at most 500 articles per view so the force
layout stays interactive; the complete English corpus remains on disk and
queryable by the local service.

## Run locally

Requirements: Node.js 18+.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). To verify a production build:

```bash
npm run build
npm run preview
```

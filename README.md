# WikiGraph

## Hosted demo

The static frontend is deployed at [grammercy.github.io/wikigraph](https://grammercy.github.io/wikigraph/).
The hosted build uses Wikipedia's public API. The optional full-dump index server remains local because
GitHub Pages does not run backend processes; use `npm run wiki:serve` on the machine that stores the dump
under `D:\WikiGraphData` when you want the full local corpus.

WikiGraph is an interactive 2D map of Wikipedia articles. Articles repel one another while directed Wikipedia links attract their source toward their target, producing an emergent view of related knowledge.

## Controls

- **Articles** — choose a graph size from 10 through the full graph-ready local corpus, then select **Generate new map**. A warning and acknowledgement appear above 1,000 nodes.
- **Displayed articles** — limit what is painted to the hubs and the most-connected articles. The layout still simulates every loaded article; selecting an article reveals its full connected neighbourhood until it is deselected.
- **Physics engine** — pause or resume the force simulation.
- **Article names** — show or hide node names beside graph nodes.
- **Remove year and day articles** — hide standalone year or month/day articles and their connections. New maps keep requesting articles until the requested size is restored or the available corpus is exhausted.
- **Select article** — open an inspector with an extract, connection counts, related articles, and a link to Wikipedia.
- **Article finder**. Press **Ctrl+F** (or select **Find**) to search loaded article titles, then jump to a result without changing the current zoom.
- **Fit / Reset** — fit the current graph to the canvas or restore the default view. Drag nodes to explore and scroll to zoom.

## Data and fallback behavior

The hosted Pages build requests main-namespace articles and their extracts/links from the public English Wikipedia API (`en.wikipedia.org/w/api.php`). The local build automatically uses the D:-drive API when it is available, progressively loading deterministic, link-connected 1k/5k/25k/100k tiers and a final tier containing the full indexed corpus while the page remains open. Slider values prefer connected prefixes; the final tier appends any disconnected or isolated downloaded records so the full-corpus option does not silently omit articles. If Wikipedia cannot be reached, WikiGraph displays a small local demo graph and marks the status as **DEMO DATA**. No Wikipedia dump or other large dataset is stored in this repository.

## Optional full-dump storage

For a local, full-English-Wikipedia index, keep Wikimedia's large dump outside the repository (and off the system drive). The helper defaults to `D:\\WikiGraphData` on Windows and `/mnt/d/WikiGraphData` in WSL:

```bash
npm run wiki:data
npm run wiki:download -- --dry-run
npm run wiki:download
```

Set `WIKIGRAPH_DATA_DIR` to another absolute HDD path when needed. Downloads resume through a `.part` file, checking ETag/Last-Modified and Content-Range before appending when the mutable `latest` URL changes. A small `manifest.json` is written only after completion. The dump itself is never checked into Git; the derived JSONL and tiers stay on D:.

To build and serve a dump-backed corpus, run the streaming pipeline on D: (the
parse step can take hours for the full snapshot):

```powershell
npm run wiki:download
npm run wiki:parse
npm run wiki:index
npm run wiki:tiers
$env:WIKIGRAPH_DATA_DIR = 'D:\WikiGraphData'
npm run wiki:serve
```

The local Vite server proxies `/api` to port 8787, and the production host
serves the same API and UI from one origin. The complete English corpus remains
on D: and is queryable through `/api/stats`, `/api/search`, and `/api/article`;
the browser can request the final full-corpus tier explicitly, while the
smaller progressive tiers keep normal exploration responsive.

To serve the production website and local API from one origin, run
`npm run wiki:host` and open `http://127.0.0.1:8787/`; it serves `dist/` with
SPA fallback plus `/health`, `/api/stats`, `/api/search`, `/api/article`, and
`/api/graph`.

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

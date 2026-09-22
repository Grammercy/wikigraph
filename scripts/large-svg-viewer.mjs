#!/usr/bin/env node

/**
 * Build and serve a bounded, canvas-based view of an SVG that is too large
 * for a browser DOM.  Geometry is spatially bucketed and reservoir-sampled;
 * the original SVG is never loaded into the browser.
 *
 *   node scripts/large-svg-viewer.mjs build --input D:\\...\\huge.svg --cache D:\\...\\cache
 *   node scripts/large-svg-viewer.mjs serve --cache D:\\...\\cache --port 8788
 */
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const arg = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? fallback : fallback }
const numberArg = (args, name, fallback) => Math.max(1, Math.floor(Number(arg(args, name, fallback))))
const escape = (value) => String(value ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
const attrs = (line) => Object.fromEntries([...line.matchAll(/([A-Za-z][\w:-]*)="([^"]*)"/g)].map((m) => [m[1], escape(m[2])]))
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const usage = () => console.log('Usage: node scripts/large-svg-viewer.mjs build --input <svg> --cache <dir> [--grid 256] [--line-cap 2500] [--label-cap 250] [--node-cap 1500]\n       node scripts/large-svg-viewer.mjs serve --cache <dir> [--port 8788]')

function readViewBox(file) {
  const handle = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(2_000_000)
  const bytes = readSync(handle, buffer, 0, buffer.length, 0)
  closeSync(handle)
  const header = buffer.subarray(0, bytes).toString('utf8')
  const match = header.match(/<svg\b[^>]*\bviewBox="([^"]+)"/i)
  if (!match) throw new Error('SVG viewBox was not found in the first 2 MB')
  const values = match[1].trim().split(/[ ,]+/).map(Number)
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) throw new Error('Invalid SVG viewBox')
  return values
}

function reservoir(bucket, field, value, cap, state) {
  bucket.counts[field] = (bucket.counts[field] || 0) + 1
  const values = bucket[field]
  if (values.length < cap) { values.push(value); return }
  state.value = (state.value * 1664525 + 1013904223) >>> 0
  const slot = state.value % bucket.counts[field]
  if (slot < cap) values[slot] = value
}

async function build(args) {
  const input = resolve(arg(args, '--input', ''))
  const cache = resolve(arg(args, '--cache', `${input}.lvg`))
  const grid = numberArg(args, '--grid', 256)
  const caps = { lines: numberArg(args, '--line-cap', 2500), nodes: numberArg(args, '--node-cap', 1500), labels: numberArg(args, '--label-cap', 250) }
  if (!existsSync(input)) throw new Error(`Input SVG not found: ${input}`)
  mkdirSync(join(cache, 'tiles'), { recursive: true })
  const [minX, minY, width, height] = readViewBox(input)
  const maxX = minX + width; const maxY = minY + height
  const buckets = new Map(); const overview = { lines: [], nodes: [], labels: [], counts: {} }; const overviewState = { value: 0x9e3779b9 }
  const states = new Map(); const getBucket = (tx, ty) => {
    const id = `${tx}_${ty}`
    let bucket = buckets.get(id)
    if (!bucket) { bucket = { lines: [], nodes: [], labels: [], counts: {} }; buckets.set(id, bucket); states.set(id, { value: (tx * 73856093 ^ ty * 19349663) >>> 0 }) }
    return [bucket, states.get(id)]
  }
  const tile = (x, y) => [Math.max(0, Math.min(grid - 1, Math.floor((x - minX) / width * grid))), Math.max(0, Math.min(grid - 1, Math.floor((y - minY) / height * grid)))]
  let scanned = 0; let lineCount = 0; let nodeCount = 0; let labelCount = 0
  const inputLines = createInterface({ input: createReadStream(input), crlfDelay: Infinity })
  for await (const line of inputLines) {
    scanned += 1
    if ((scanned & 0x7fffff) === 0) console.log(`Scanned ${scanned.toLocaleString()} SVG lines; buckets=${buckets.size.toLocaleString()}`)
    if (line.startsWith('<line ')) {
      const a = attrs(line); const x1 = finite(a.x1); const y1 = finite(a.y1); const x2 = finite(a.x2); const y2 = finite(a.y2)
      const record = [x1, y1, x2, y2]; const [tx, ty] = tile((x1 + x2) * 0.5, (y1 + y2) * 0.5); const [bucket, state] = getBucket(tx, ty)
      reservoir(bucket, 'lines', record, caps.lines, state); reservoir(overview, 'lines', record, 200_000, overviewState); lineCount += 1
    } else if (line.startsWith('<circle ')) {
      const a = attrs(line); const x = finite(a.cx); const y = finite(a.cy); const r = finite(a.r, 2); const record = [x, y, r]; const [tx, ty] = tile(x, y); const [bucket, state] = getBucket(tx, ty)
      reservoir(bucket, 'nodes', record, caps.nodes, state); reservoir(overview, 'nodes', record, 150_000, overviewState); nodeCount += 1
    } else if (line.startsWith('<text ')) {
      const a = attrs(line); const x = finite(a.x); const y = finite(a.y); const text = line.replace(/^.*?>/, '').replace(/<\/text>.*$/, ''); const record = [x, y, text]; const [tx, ty] = tile(x, y); const [bucket, state] = getBucket(tx, ty)
      reservoir(bucket, 'labels', record, caps.labels, state); reservoir(overview, 'labels', record, 40_000, overviewState); labelCount += 1
    }
  }
  for (const [id, bucket] of buckets) writeFileSync(join(cache, 'tiles', `${id}.json`), JSON.stringify(bucket))
  writeFileSync(join(cache, 'overview.json'), JSON.stringify(overview))
  writeFileSync(join(cache, 'meta.json'), JSON.stringify({ version: 1, input, viewBox: [minX, minY, width, height], grid, caps, counts: { lines: lineCount, nodes: nodeCount, labels: labelCount }, sampled: { tiles: buckets.size, overview: { lines: overview.lines.length, nodes: overview.nodes.length, labels: overview.labels.length } } }, null, 2))
  writeFileSync(join(cache, 'viewer.html'), viewerHtml)
  console.log(`Built ${cache}: ${lineCount.toLocaleString()} lines, ${nodeCount.toLocaleString()} nodes, ${labelCount.toLocaleString()} labels; sampled ${buckets.size.toLocaleString()} tiles.`)
}

const viewerHtml = `<!doctype html><meta charset="utf-8"><title>Large SVG viewer</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#f7f8fb;font:13px system-ui;color:#30343b}canvas{width:100%;height:100%;display:block}#hud{position:fixed;left:12px;top:12px;padding:8px 10px;background:#ffffffe8;border:1px solid #ccd2dc;border-radius:7px;box-shadow:0 2px 12px #0001}button{margin-left:8px}</style><canvas id="c"></canvas><div id="hud">Loading… <button id="fit">Fit</button></div><script>
const c=document.querySelector('canvas'),x=c.getContext('2d'),hud=document.querySelector('#hud');let meta,overview,tiles=new Map(),view={cx:0,cy:0,scale:1};const resize=()=>{c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;x.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);draw()};addEventListener('resize',resize);const worldToScreen=(px,py)=>[(px-view.cx)*view.scale+innerWidth/2,(py-view.cy)*view.scale+innerHeight/2];const load=async u=>{const r=await fetch(u);return r.json()};async function draw(){if(!meta)return;const [mx,my,w,h]=meta.viewBox;x.clearRect(0,0,innerWidth,innerHeight);x.fillStyle='#f7f8fb';x.fillRect(0,0,innerWidth,innerHeight);const data=view.scale<1.5?overview:await loadTiles();drawData(data);hud.textContent=view.scale<1.5?'Overview (sampled)':'Zoomed tiles (sampled)';const b=document.createElement('button');b.textContent='Fit';b.onclick=fit;hud.append(b)}function drawData(d){x.lineWidth=Math.max(.35,Math.min(1.4,view.scale));x.strokeStyle='#73777f55';x.beginPath();for(const q of d.lines){const a=worldToScreen(q[0],q[1]),b=worldToScreen(q[2],q[3]);x.moveTo(a[0],a[1]);x.lineTo(b[0],b[1])}x.stroke();for(const q of d.nodes){const p=worldToScreen(q[0],q[1]);x.fillStyle='#9aabf8';x.beginPath();x.arc(p[0],p[1],Math.max(1.2,Math.min(8,q[2]*view.scale)),0,Math.PI*2);x.fill()}if(view.scale>2){x.font='10px system-ui';x.fillStyle='#555c68';for(const q of d.labels){const p=worldToScreen(q[0],q[1]);if(p[0]>-100&&p[0]<innerWidth+100&&p[1]>-20&&p[1]<innerHeight+20)x.fillText(q[2],p[0],p[1])}}}async function loadTiles(){const [mx,my,w,h]=meta.viewBox;const s=Math.max(1,view.scale);const worldW=innerWidth/s,worldH=innerHeight/s;const left=view.cx-worldW/2,top=view.cy-worldH/2;const x0=Math.max(0,Math.floor((left-mx)/w*meta.grid)),x1=Math.min(meta.grid-1,Math.ceil((left+worldW-mx)/w*meta.grid));const y0=Math.max(0,Math.floor((top-my)/h*meta.grid)),y1=Math.min(meta.grid-1,Math.ceil((top+worldH-my)/h*meta.grid));const all=[];for(let ty=y0;ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++){const k=tx+'_'+ty;all.push(tiles.has(k)?Promise.resolve(tiles.get(k)):load('tiles/'+k+'.json').then(v=>(tiles.set(k,v),v)).catch(()=>({lines:[],nodes:[],labels:[]})))}const ds=await Promise.all(all);return ds.reduce((a,b)=>({lines:a.lines.concat(b.lines),nodes:a.nodes.concat(b.nodes),labels:a.labels.concat(b.labels)}),{lines:[],nodes:[],labels:[]})}function fit(){const [mx,my,w,h]=meta.viewBox;view.cx=mx+w/2;view.cy=my+h/2;view.scale=Math.min(innerWidth/w,innerHeight/h)*.92;draw()}c.addEventListener('wheel',e=>{e.preventDefault();const f=e.deltaY<0?1.25:.8;view.scale=Math.max(.01,Math.min(100,view.scale*f));draw()},{passive:false});let drag; c.addEventListener('pointerdown',e=>{drag=[e.clientX,e.clientY,view.cx,view.cy];c.setPointerCapture(e.pointerId)});c.addEventListener('pointermove',e=>{if(!drag)return;view.cx=drag[2]-(e.clientX-drag[0])/view.scale;view.cy=drag[3]-(e.clientY-drag[1])/view.scale;draw()});c.addEventListener('pointerup',()=>drag=null);(async()=>{meta=await load('meta.json');overview=await load('overview.json');resize();fit()})()
</script>`

async function serve(args) {
  const cache = resolve(arg(args, '--cache', ''))
  const port = numberArg(args, '--port', 8788)
  if (!existsSync(join(cache, 'meta.json'))) throw new Error(`No cache at ${cache}; run build first`)
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url || '/').split('?')[0])
    const file = path === '/' ? 'viewer.html' : path.slice(1)
    if (!/^(viewer\.html|meta\.json|overview\.json|tiles\/[0-9]+_[0-9]+\.json)$/.test(file)) { response.writeHead(404); response.end('Not found'); return }
    const target = join(cache, file)
    if (!existsSync(target)) { response.writeHead(404); response.end('Not found'); return }
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json')
    createReadStream(target).pipe(response)
  })
  server.listen(port, () => console.log(`Large SVG viewer: http://127.0.0.1:${port}/`))
}

const [command, ...args] = process.argv.slice(2)
if (command === 'build') await build(args)
else if (command === 'serve') await serve(args)
else usage()

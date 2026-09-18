import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves this project from /wikigraph/, while local development
// and other static hosts serve it from the origin root. Allow an explicit
// override for previews and custom domains without changing local defaults.
declare const process: { env: Record<string, string | undefined> }

const base = process.env.VITE_BASE_PATH ?? (process.env.GITHUB_ACTIONS ? '/wikigraph/' : '/')

export default defineConfig({
  plugins: [react()],
  base,
  server: {
    host: 'localhost',
    port: 5173,
    proxy: {
      // Keep the browser contract identical in dev and in the production
      // local host. If the D:-drive API is not running, the data loader falls
      // back to the public Wikipedia API.
      '/api': 'http://127.0.0.1:8787',
    },
  },
})

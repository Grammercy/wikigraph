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
  },
})

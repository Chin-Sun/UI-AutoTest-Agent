import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = `http://127.0.0.1:${process.env.UTA_PORT ?? 4600}`

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/files': api,
      '/demo': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
})

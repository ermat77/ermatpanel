import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173, // Vite default port
    proxy: {
      '/api': {
        target: 'http://localhost:18080',
        changeOrigin: true,
        ws: true, // Enable WebSocket proxying
        // Long timeout for SSE (server-download/progress) so the stream is not closed
        proxyTimeout: 3600000, // 1 hour
        timeout: 3600000,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req) => {
            // Prevent buffering of Server-Sent Events so events stream in real time
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
              proxyRes.headers['x-no-compression'] = '1'
            }
          })
        },
      },
    },
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
})

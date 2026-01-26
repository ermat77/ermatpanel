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
      },
    },
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
})

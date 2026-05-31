import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html',
        widget: 'widget.html'
      }
    }
  },
  server: {
    port: 5173
  }
})

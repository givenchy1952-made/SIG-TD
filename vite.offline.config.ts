import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Build a fully local demo: no hosted JS/CSS, no Supabase connection, no CDN.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist-offline',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'sig-demo.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})

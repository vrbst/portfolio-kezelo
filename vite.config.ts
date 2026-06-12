import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Relative base + HashRouter => works on GitHub Pages under any sub-path
// without server-side routing config.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
})

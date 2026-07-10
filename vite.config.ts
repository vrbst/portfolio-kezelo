import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Build stamp shown in Settings so you can tell which build a device runs
// (useful for confirming a PWA update landed). Time is the build machine's
// clock (UTC in CI); sha is the commit short hash when GitHub Actions provides it.
const BUILD_TIME = new Date().toISOString();
const BUILD_SHA = (process.env.GITHUB_SHA ?? "").slice(0, 7) || "dev";

// Relative base + HashRouter => works on GitHub Pages under any sub-path
// without server-side routing config.
export default defineConfig({
  base: "./",
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Portfólió-kezelő",
        short_name: "Portfólió",
        description:
          "Lightyear és Magyar Államkincstár portfólió egy helyen, helyben tárolva.",
        lang: "hu",
        theme_color: "#0b1020",
        background_color: "#0b1020",
        display: "standalone",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "index.html",
        // App data (prices/history) is refreshed by a cron — prefer network,
        // fall back to the last cached copy when offline.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith(".json"),
            handler: "NetworkFirst",
            options: {
              cacheName: "portfolio-data",
              expiration: { maxEntries: 12, maxAgeSeconds: 86400 },
            },
          },
        ],
      },
    }),
  ],
});

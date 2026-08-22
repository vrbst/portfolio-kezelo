import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Build stamp shown in Settings so you can tell which build a device runs.
//
// It reflects the last commit that changed actual app code — NOT the wall clock
// and NOT the latest commit. The nightly price bot commits only
// public/prices.json + public/history.json; if the stamp used `new Date()` or
// HEAD's sha, every daily price deploy would show a fresh "yesterday" build date
// even though no code changed, which reads as a phantom update. Excluding the
// two bot-written data files from the `git log` pathspec pins the stamp to the
// last real code change.
//
// IMPORTANT: this stamp is written to a runtime-fetched `version.json`, NOT
// baked into the JS bundle. If it were `define`d into the bundle, every build
// would change a precached chunk's content hash — so a daily price-only deploy
// (which only rewrites the non-precached prices.json) would still bump the
// service worker and pop a bogus "Új verzió érhető el." toast. Keeping it out
// of the precache means price-only deploys produce byte-identical JS/CSS/HTML,
// and the update prompt fires only on real code changes.
//
// Needs full git history in CI — the deploy workflow checks out with
// fetch-depth: 0. Falls back to the build clock if git is unavailable (e.g. a
// shallow checkout or a tarball with no .git).
function buildStamp(): { builtAt: string; sha: string } {
  try {
    const out = execSync(
      'git log -1 --format=%cI%x09%h -- . ":(exclude)public/prices.json" ":(exclude)public/history.json"',
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const [iso, sha] = out.split("\t");
    if (iso && sha) return { builtAt: iso, sha };
  } catch {
    /* no git / shallow clone — fall back to the build clock */
  }
  return {
    builtAt: new Date().toISOString(),
    sha: (process.env.GITHUB_SHA ?? "").slice(0, 7) || "dev",
  };
}

const { builtAt: BUILD_TIME, sha: BUILD_SHA } = buildStamp();

// Emits dist/version.json at build time. `.json` is excluded from the workbox
// precache globs, so this file is served fresh (NetworkFirst) and never counts
// as a service-worker update.
function emitVersionJson(): Plugin {
  return {
    name: "emit-version-json",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ builtAt: BUILD_TIME, sha: BUILD_SHA }),
      });
    },
  };
}

// Relative base + HashRouter => works on GitHub Pages under any sub-path
// without server-side routing config.
export default defineConfig({
  base: "./",
  plugins: [
    emitVersionJson(),
    react(),
    tailwindcss(),
    VitePWA({
      // "prompt": the new service worker WAITS until the user clicks the
      // in-app "Frissítés" toast (UpdatePrompt) — no more hard-reload ritual
      // after a deploy, and no mid-session surprise reload either.
      registerType: "prompt",
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

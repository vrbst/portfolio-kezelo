import { defineConfig, devices } from "@playwright/test";

// Browser tests of the BUILT app (dist/) on the invented portfolio of
// src/test/fixture.ts. Run: `npm run test:e2e` (builds first). In CI the
// deploy workflow runs them after `npm run build`.
//
// PW_CHROMIUM_PATH: use an already installed Chromium instead of the one
// `npx playwright install chromium` downloads (e.g. in a sandbox).

const PORT = 4173;

// The fixture builds its dates from LOCAL time: build them in the zone the
// browser runs in (the workers inherit this).
process.env.TZ = "Europe/Budapest";

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.results",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}/`,
    timezoneId: "Europe/Budapest",
    locale: "hu-HU",
    // No fade-ins: cards below the fold would stay transparent until scrolled
    // to, hiding their text from the checks.
    reducedMotion: "reduce",
    // The PWA service worker would cache between tests.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } } },
    // Phone width: where cards spilled out before (4547af9, 883f79d).
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } } },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

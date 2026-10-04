import { expect, test, type Page } from "@playwright/test";
import {
  fixtureHistory,
  fixturePriceFile,
  fixtureSnapshot,
  savingsGoals,
} from "../src/test/fixture";

// The built app in a real browser, on the invented portfolio: every page
// renders without errors, nothing spills out sideways on a phone, and privacy
// mode hides every amount. The clock is fixed and the network is cut off, so
// the run is the same every time.

const NOW = new Date("2026-10-14T10:00:00+02:00");
const DAY = "2026-10-14";

const PAGES = [
  ["/", "Áttekintés"],
  ["/accounts", "Számlák"],
  ["/accounts/mak", "Kincstár számla"],
  ["/income", "Hozam"],
  ["/calendar", "Naptár"],
  ["/forecast", "Előrejelzés"],
  ["/goals", "Célok"],
  ["/alerts", "Teendők"],
  ["/import", "Import"],
  ["/settings", "Beállítások"],
] as const;

/** Planning prefs → the localStorage keys the app reads (see src/lib/prefs.ts). */
const PREF_KEYS: Record<string, string> = {
  savings: "pf-savings",
  glidePath: "pf-glidepath",
  brokerFees: "pf-broker-fees",
  accountLimits: "pf-account-limits",
  purchaseAccounts: "pf-purchase-accounts",
  income: "pf-income",
};

async function openSeeded(page: Page, opts: { privacy?: boolean } = {}) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // The cut-off network (Yahoo, proxy, GitHub) is on purpose, not an error.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });

  // Start the browser's clock at NOW and let it run: a fixed clock would
  // freeze the animations (a page stuck at opacity 0 hides everything).
  await page.clock.install({ time: NOW });
  await page.clock.resume();
  // Only the app itself: no Yahoo, no proxy, no GitHub. The committed price
  // files are served from the fixture.
  const history = fixtureHistory(DAY);
  for (const k of Object.keys(history.prices)) history.prices[k] = history.prices[k].filter(([d]) => d < DAY);
  history.fx.EUR = history.fx.EUR.filter(([d]) => d < DAY);
  const priceFile = fixturePriceFile(history);
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.route("**/prices.json*", (r) => r.fulfill({ json: priceFile }));
  await page.route("**/history.json*", (r) => r.fulfill({ json: history }));

  // Let the app create its IndexedDB, then fill it and the prefs, and reload.
  await page.goto("./");
  await page.waitForLoadState("networkidle");
  const snap = fixtureSnapshot();
  await page.evaluate(
    async ({ snap, prefKeys, privacy }) => {
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = indexedDB.open("portfolio");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(["accounts", "instruments", "transactions", "meta"], "readwrite");
      for (const a of snap.accounts) tx.objectStore("accounts").put(a);
      for (const i of snap.instruments) tx.objectStore("instruments").put(i);
      for (const t of snap.transactions) tx.objectStore("transactions").put(t);
      tx.objectStore("meta").put({ key: "goals", value: snap.goals ?? [] });
      tx.objectStore("meta").put({ key: "reminders", value: snap.reminders ?? [] });
      await new Promise((res, rej) => {
        tx.oncomplete = () => res(null);
        tx.onerror = () => rej(tx.error);
      });
      db.close();
      for (const [kind, key] of Object.entries(prefKeys)) {
        const p = (snap.prefs as Record<string, { updatedAt: string; value: unknown }>)[kind];
        if (!p) continue;
        localStorage.setItem(key, JSON.stringify(p.value));
        localStorage.setItem(`${key}-updated`, p.updatedAt);
      }
      localStorage.setItem("pf-privacy", privacy ? "1" : "0");
    },
    { snap, prefKeys: PREF_KEYS, privacy: !!opts.privacy },
  );
  await page.reload();
  await page.waitForLoadState("networkidle");
  return errors;
}

/**
 * Open a page with a fresh load (no page transition: the outgoing page would
 * stay in the DOM while it fades out) and wait until its cards are shown.
 */
async function show(page: Page, path: string) {
  await page.goto(`./#${path}`);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("main")).toBeVisible();
  // The page has faded in: the page wrappers Motion fades (inline opacity,
  // near the top of <main>) are fully opaque. Deeper ones may pulse forever.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLElement>("main, main > *, main > * > *, main > * > * > *")]
        .filter((e) => e.style.opacity !== "")
        .every((e) => getComputedStyle(e).opacity === "1"),
    null,
    { timeout: 10_000 },
  );
}

/** Elements wider than the viewport (the page must not scroll sideways). */
async function sidewaysOverflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > vw + 1)
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= vw + 1) continue;
        // Report the outermost culprit only (not every descendant).
        if (el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 1) continue;
        // Content inside a horizontal scroller is fine (e.g. a wide table).
        let p = el.parentElement;
        let scrolls = false;
        while (p) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") scrolls = true;
          p = p.parentElement;
        }
        if (!scrolls) out.push(`${el.tagName.toLowerCase()}.${el.className} (${Math.round(r.right)}px > ${vw}px): ${el.textContent?.slice(0, 60)}`);
      }
    return out;
  });
}

/** Visible (not blurred / hidden) texts in <main> with an amount or a goal name. */
function readableSecrets(page: Page, goalNames: string[]) {
  return page.evaluate((goalNames) => {
    const money = /\d[\d\s\u00a0\u202f.,]*\s?(Ft|€|EUR|M Ft)(?![a-zá-ű])/;
    const hidden = (el: Element | null): boolean => {
      // Market prices and fixed samples are not personal (data-privacy="public").
      if (el?.closest('[data-privacy="public"]')) return true;
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        // A page transition leaves "blur(0px)" behind: only a real blur hides.
        const blur = /blur\(([\d.]+)px\)/.exec(cs.filter);
        if ((blur && Number(blur[1]) >= 2) || cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return true;
      }
      return false;
    };
    const out: string[] = [];
    const walker = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? "";
      const hit = money.test(text) || goalNames.some((g) => text.includes(g));
      if (hit && !hidden(n.parentElement)) {
        // Where it is: the nearest element with a class, for the error message.
        const at = n.parentElement?.closest("[class]");
        const cls = at ? `${at.tagName.toLowerCase()}.${String(at.className).split(" ").slice(0, 3).join(".")}` : "";
        out.push(`${text.trim().slice(0, 80)}  ⟵ ${cls}`);
      }
    }
    return [...new Set(out)];
  }, goalNames);
}

test.describe("every page", () => {
  for (const [path, name] of PAGES) {
    test(`${name} (${path}) renders without errors or sideways overflow`, async ({ page }) => {
      const errors = await openSeeded(page);
      await show(page, path);
      await expect(page.locator("main")).not.toBeEmpty();
      expect(errors, "console / page errors").toEqual([]);
      expect(await sidewaysOverflow(page), "elements wider than the screen").toEqual([]);
    });
  }
});

test.describe("privacy mode", () => {
  const goalNames = savingsGoals().map((g) => g.name);

  test("control: without it, the amounts and goal names ARE readable", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/goals");
    await expect(page.locator("main")).toContainText("Babakocsi");
    const seen = await readableSecrets(page, goalNames);
    expect(seen.some((t) => /\d.*Ft/.test(t))).toBe(true);
    expect(seen.some((t) => t.includes("Babakocsi"))).toBe(true);
  });

  for (const [path, name] of PAGES) {
    test(`${name} (${path}): no amount or goal name is readable`, async ({ page }) => {
      await openSeeded(page, { privacy: true });
      await show(page, path);
      const leaks = await readableSecrets(page, goalNames);
      expect(leaks, "readable amounts / goal names in privacy mode").toEqual([]);
    });
  }
});

test("the app shows the same total the bot computes", async ({ page }) => {
  // The bot's pipeline (Node) on the same data and price files, no live quotes.
  const { buildContext } = await import("../scripts/notify/data");
  const { installLocalStorage } = await import("../scripts/notify/env");
  const { applyRemotePrefs } = await import("../src/lib/prefs");
  const snapshot = fixtureSnapshot();
  installLocalStorage();
  applyRemotePrefs(snapshot.prefs);
  const history = fixtureHistory(DAY);
  for (const k of Object.keys(history.prices)) history.prices[k] = history.prices[k].filter(([d]) => d < DAY);
  history.fx.EUR = history.fx.EUR.filter(([d]) => d < DAY);
  const ctx = buildContext({
    snapshot,
    priceFile: fixturePriceFile(history),
    history,
    fxQuotes: {},
    priceQuotes: {},
    at: NOW,
    idleCashHuf: 100_000,
    reserveGraceDays: 45,
  });
  const digits = String(Math.round(ctx.summary.totalValueHuf));

  await openSeeded(page);
  await show(page, "/");
  // Compare digits only (the app groups with narrow spaces).
  await expect
    .poll(async () => (await page.locator("main").innerText()).replace(/[\s\u00a0\u202f.]/g, ""))
    .toContain(`${digits}Ft`);
});

test.describe("glide-path editor", () => {
  async function openEditor(page: Page, privacy = false) {
    const errors = await openSeeded(page, { privacy });
    await show(page, "/goals");
    await page.getByTitle("Szerkesztés", { exact: true }).click();
    await expect(page.getByText("Pálya", { exact: true })).toBeVisible();
    return errors;
  }

  test("basic view first; the advanced settings are behind a toggle", async ({ page }) => {
    const errors = await openEditor(page);
    const mode = page.locator("select").filter({ has: page.locator('option[value="inflows"]') });
    await mode.selectOption("inflows");
    await expect(page.getByText("Újrajelzési lépcső (csoportra)").first()).toBeHidden();
    await expect(page.getByText("Pálya (kezdő → záró dátum)").first()).toBeHidden();
    await page.getByRole("button", { name: /Haladó beállítások/ }).click();
    await expect(page.getByText("Újrajelzési lépcső (csoportra)").first()).toBeVisible();
    // Calendar-only settings stay hidden in inflows mode.
    await expect(page.getByText("Sávhatár alapja").first()).toBeHidden();
    await mode.selectOption("calendar");
    await expect(page.getByText("Pálya (kezdő → záró dátum)").first()).toBeVisible();
    expect(errors, "console / page errors").toEqual([]);
    expect(await sidewaysOverflow(page), "elements wider than the screen").toEqual([]);
  });

  test("privacy mode: nothing personal is readable in the editor", async ({ page }) => {
    await openEditor(page, true);
    await page.getByRole("button", { name: /Haladó beállítások/ }).click();
    const leaks = await readableSecrets(page, savingsGoals().map((g) => g.name));
    expect(leaks, "readable amounts / goal names in privacy mode").toEqual([]);
  });
});

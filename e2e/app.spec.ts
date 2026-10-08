import { expect, test, type Page } from "@playwright/test";
import {
  fixtureBondRates,
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
  ["/hirek", "Hírek"],
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

async function openSeeded(page: Page, opts: { privacy?: boolean; sync?: boolean } = {}) {
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
  await page.route("**/bond-rates.json*", (r) => r.fulfill({ json: fixtureBondRates() }));

  // Let the app create its IndexedDB, then fill it and the prefs, and reload.
  await page.goto("./");
  await page.waitForLoadState("networkidle");
  const snap = fixtureSnapshot();
  await page.evaluate(
    async ({ snap, prefKeys, privacy, sync }) => {
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
      if (sync)
        localStorage.setItem("portfolio.syncConfig", JSON.stringify({ token: "t", owner: "teszt", repo: "adat", path: "data.json" }));
    },
    { snap, prefKeys: PREF_KEYS, privacy: !!opts.privacy, sync: !!opts.sync },
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

/** A fresh load of a page, without waiting for its fade-in (see the news tests). */
async function reopen(page: Page, path: string) {
  await page.goto(`./#${path}`);
  await page.reload();
  await page.waitForLoadState("networkidle");
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

test.describe("dashboard value chart", () => {
  const tickTexts = (page: Page, axis: "x" | "y") =>
    page.locator(`main .recharts-${axis}Axis-tick-labels .recharts-cartesian-axis-tick-value`).allTextContents();

  test("opens on Hozam; in privacy mode the axis amounts are masked", async ({ page }) => {
    await openSeeded(page, { privacy: true });
    await show(page, "/");
    await expect(page.getByRole("heading", { name: "Hozam az időben" })).toBeVisible();
    await expect.poll(async () => (await tickTexts(page, "y")).length).toBeGreaterThan(0);
    expect((await tickTexts(page, "y")).every((t) => t.trim() === "•••")).toBe(true);
    const leaks = await readableSecrets(page, savingsGoals().map((g) => g.name));
    expect(leaks, "readable amounts / goal names in privacy mode").toEqual([]);
  });

  test("the chosen view is kept after a reload; the short ranges show day labels", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/");
    await page.getByRole("button", { name: "Érték", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Érték az időben" })).toBeVisible();
    await reopen(page, "/");
    await expect(page.getByRole("heading", { name: "Érték az időben" })).toBeVisible();
    const week = page.getByRole("button", { name: "Utolsó 7 nap" });
    await expect(week).toBeEnabled();
    await week.click();
    await expect(week).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => {
        const ticks = await tickTexts(page, "x");
        return ticks.length >= 3 && ticks.every((t) => /^\d{2}\.\s?\d{2}\.?$/.test(t.trim()));
      })
      .toBe(true);
    expect(await sidewaysOverflow(page), "elements wider than the screen").toEqual([]);
  });
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

test.describe("market news (Hírek)", () => {
  /**
   * The sync repo with an invented digest; the snapshot file is not there.
   * After openSeeded: the route registered last wins over its network cut.
   */
  async function withNews(page: Page) {
    const { fixtureDigest } = await import("../src/test/newsFixture");
    const { withIndexEntry } = await import("../src/lib/newsSchema");
    const evening = fixtureDigest("2026-10-13", "evening");
    const morning = fixtureDigest("2026-10-14", "morning");
    const index = withIndexEntry(withIndexEntry(null, evening), morning);
    const file = (v: unknown) => ({
      json: { sha: "s", content: Buffer.from(JSON.stringify(v), "utf8").toString("base64") },
    });
    await page.route(/api\.github\.com\/repos\/teszt\/adat\/contents\//, (r) => {
      const path = new URL(r.request().url()).pathname.split("/contents/")[1];
      if (path === "news/index.json") return r.fulfill(file(index));
      if (path === "news/2026-10-14-morning.json") return r.fulfill(file(morning));
      if (path === "news/2026-10-13-evening.json") return r.fulfill(file(evening));
      return r.fulfill({ status: 404, body: "" });
    });
  }

  test("the page lists the latest digest; the dashboard card links to it", async ({ page }) => {
    const errors = await openSeeded(page, { sync: true });
    await withNews(page);
    await show(page, "/hirek");
    const main = page.locator("main");
    await expect(main).toContainText("Reggeli előzetes");
    await expect(main).toContainText("Gyengült a forint <az euróval> szemben");
    await expect(main).toContainText("Következő napok");
    await page.selectOption("#news-pick", { index: 1 });
    await expect(main).toContainText("Napzárta");
    expect(await sidewaysOverflow(page), "elements wider than the screen").toEqual([]);

    await show(page, "/");
    await expect(main).toContainText("Piaci hírek");
    await main.getByRole("link", { name: /Összes hír/ }).click();
    await expect(page).toHaveURL(/#\/hirek$/);
    expect(errors, "console / page errors").toEqual([]);
  });

  test("today's unread news are flagged (yesterday's never); reading clears it", async ({ page }, info) => {
    await openSeeded(page, { sync: true });
    await withNews(page);
    const desktop = info.project.name === "desktop";
    const badge = page.locator('aside a[href="#/hirek"] span[title="Mai olvasatlan hírek"]');
    await show(page, "/");
    // Today's morning edition: 7 items. Yesterday's unread evening one doesn't count.
    await expect(page.locator("main")).toContainText("7 új hír ma (reggeli előzetes)");
    if (desktop) await expect(badge).toHaveText("7");

    await show(page, "/hirek");
    await expect(page.locator("main")).toContainText("Reggeli előzetes");
    // Back on the dashboard (a second dashboard load in one test never
    // finishes its fade-in here, so this checks the content only).
    await reopen(page, "/");
    await expect(page.locator("main")).toContainText("Piaci hírek");
    await expect(page.locator("main")).not.toContainText("új hír ma");
    if (desktop) await expect(badge).toHaveCount(0);
  });

  test("the ✕ on the dashboard banner marks today's news read", async ({ page }) => {
    await openSeeded(page, { sync: true });
    await withNews(page);
    await show(page, "/");
    await expect(page.locator("main")).toContainText("új hír ma");
    await page.getByTitle("Olvasottnak jelölöm").click();
    await expect(page.locator("main")).not.toContainText("új hír ma");
    await reopen(page, "/");
    await expect(page.locator("main")).toContainText("Piaci hírek");
    await expect(page.locator("main")).not.toContainText("új hír ma");
  });

  test("privacy mode: the news stay readable, nothing personal leaks", async ({ page }) => {
    await openSeeded(page, { privacy: true, sync: true });
    await withNews(page);
    const goalNames = savingsGoals().map((g) => g.name);
    for (const path of ["/hirek", "/"]) {
      await show(page, path);
      await expect(page.locator("main")).toContainText("forint");
      expect(await readableSecrets(page, goalNames), path).toEqual([]);
    }
  });
});

test("Kincstár: the bond card suggests a switch and lists the buyable bonds", async ({ page }) => {
  await openSeeded(page);
  await show(page, "/accounts/mak");
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "Állampapír-ajánlatok" }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Érdemes lehet cserélni");
  await expect(card).toContainText("→ FixMÁP 2031/T");
  await expect(card).toContainText("Lejár 35 nap múlva");
  await expect(card.locator("table")).toContainText("MÁP Plusz 2032/T");
  await expect(card.locator("table")).toContainText("DKJ D270120");
});

test.describe("explanations behind an \"i\"", () => {
  test("open on hover / tap, stay on screen, close with Esc", async ({ page }, info) => {
    await openSeeded(page);
    await show(page, "/forecast");
    const tip = page.getByRole("button", { name: "Magyarázat" }).first();
    const pop = page.getByRole("tooltip");
    await expect(pop).toHaveCount(0);
    if (info.project.name === "desktop") await tip.hover();
    else await tip.tap();
    await expect(pop).toBeVisible();
    await expect(pop).toContainText("lezárt hónap átlagos nettó befizetése");
    const box = (await pop.boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw);
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
  });

  test("privacy mode blurs amounts inside an open popover too", async ({ page }) => {
    await openSeeded(page, { privacy: true });
    await show(page, "/accounts/mak");
    const tips = page.getByRole("button", { name: "Magyarázat" });
    await expect(tips.first()).toBeVisible();
    // Every tip on the page, one by one: nothing personal is readable in it.
    for (let i = 0; i < (await tips.count()); i++) {
      await tips.nth(i).click();
      const pop = page.getByRole("tooltip");
      await expect(pop).toBeVisible();
      const leaks = await pop.evaluate((el) => {
        const money = /\d[\d\s\u00a0\u202f.,]*\s?(Ft|€|EUR|M Ft)(?![a-zá-ű])/;
        const out: string[] = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!money.test(n.textContent ?? "")) continue;
          const blur = /blur\(([\d.]+)px\)/.exec(getComputedStyle(n.parentElement!).filter);
          if (!blur || Number(blur[1]) < 2) out.push(n.textContent!.trim());
        }
        return out;
      });
      expect(leaks).toEqual([]);
      await page.keyboard.press("Escape");
    }
  });
});

test("the sidebar marker sits on the active page (clicks, back button)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the sidebar is desktop-only");
  await openSeeded(page);
  await show(page, "/");
  const marker = page.locator(".nav-marker");
  const onLink = async (label: string) => {
    const link = page.locator("aside").getByRole("link", { name: label });
    await expect(link).toHaveClass(/active/);
    await expect
      .poll(async () => {
        const [m, l] = [await marker.boundingBox(), await link.boundingBox()];
        return m && l ? Math.abs(m.y - l.y) + Math.abs(m.height - l.height) : 99;
      })
      .toBeLessThan(1.5);
  };
  await onLink("Áttekintés");
  await page.locator("aside").getByRole("link", { name: "Előrejelzés" }).click();
  await expect(page).toHaveURL(/#\/forecast$/);
  await onLink("Előrejelzés");
  await page.locator("aside").getByRole("link", { name: "Beállítások" }).click();
  await onLink("Beállítások");
  await page.goBack();
  await onLink("Előrejelzés");
  expect(await page.locator(".nav-marker").count()).toBe(1);
});

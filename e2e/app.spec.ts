import { expect, test, type Page } from "@playwright/test";
import {
  CASHFLOW_CATEGORIES,
  CASHFLOW_ITEM_TEXTS,
  fixtureBondRates,
  fixtureCashflow,
  fixtureCashflowItems,
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
  ["/cashflow", "Pénzáramlás"],
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
    async ({ snap, prefKeys, privacy, sync, cashflow, cashflowItems }) => {
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = indexedDB.open("portfolio");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(["accounts", "instruments", "transactions", "meta", "cashflowItems"], "readwrite");
      for (const it of cashflowItems) tx.objectStore("cashflowItems").put(it);
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
      localStorage.setItem("pf-cashflow", JSON.stringify(cashflow));
      localStorage.setItem("pf-cashflow-updated", "2026-10-02T08:00:00.000Z");
      localStorage.setItem("pf-privacy", privacy ? "1" : "0");
      if (sync)
        localStorage.setItem("portfolio.syncConfig", JSON.stringify({ token: "t", owner: "teszt", repo: "adat", path: "data.json" }));
    },
    { snap, prefKeys: PREF_KEYS, privacy: !!opts.privacy, sync: !!opts.sync, cashflow: fixtureCashflow(), cashflowItems: fixtureCashflowItems() },
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
function readableSecrets(page: Page, goalNames: string[], root = "main") {
  return page.evaluate(([goalNames, root]) => {
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
    const walker = document.createTreeWalker(document.querySelector(root) ?? document.body, NodeFilter.SHOW_TEXT);
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
  }, [goalNames, root] as const);
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

test.describe("cash flow page (1Money)", () => {
  test("control: without privacy mode the categories and amounts ARE readable", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/cashflow");
    await expect(page.locator("main")).toContainText("Teszt-Lakás");
    const seen = await readableSecrets(page, CASHFLOW_CATEGORIES);
    expect(seen.some((t) => t.includes("Teszt-Lakás"))).toBe(true);
    expect(seen.some((t) => /\d.*Ft/.test(t))).toBe(true);
  });

  test("privacy mode: no category name and no amount is readable", async ({ page }) => {
    await openSeeded(page, { privacy: true });
    // With an income category left out, the note about the excluded money shows too.
    await page.evaluate(() =>
      localStorage.setItem(
        "pf-cashflow-settings",
        JSON.stringify({ excluded: ["income:Teszt-Fizetés"], remind: true, reserveMonths: 6, reserveAccounts: ["mak"] }),
      ),
    );
    await show(page, "/cashflow");
    await expect(page.locator("main")).toContainText("Kategóriák");
    await expect(page.locator("main")).toContainText("A kizárt bevételek");
    await expect(page.getByTestId("reserve-status")).toContainText("Cél:");
    expect(await readableSecrets(page, CASHFLOW_CATEGORIES), "readable in privacy mode").toEqual([]);
  });

  test("a category can be left out of the averages", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/cashflow");
    const main = page.locator("main");
    const avg = main.locator(".card", { hasText: "Havi kiadás (átlag)" }).first();
    // 9 invented months: food 90–106 e Ft + rent 150 e Ft, so ≈ 248 e Ft a month.
    await expect(avg).toContainText("248");
    await main.getByLabel("Teszt-Lakás (kiadás) beleszámít az átlagokba").uncheck();
    await expect(avg).not.toContainText("248");
    await expect(avg).toContainText("98");
    // The choice survives a reload (it is a synced setting).
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(main.getByLabel("Teszt-Lakás (kiadás) beleszámít az átlagokba")).not.toBeChecked();
  });

  test("the average can start at a month: fewer months count, and it survives a reload", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/cashflow");
    const main = page.locator("main");
    const avg = main.locator(".card", { hasText: "Havi bevétel (átlag)" }).first();
    await expect(avg).toContainText("9 lezárt hónap");
    await main.getByLabel("Az átlag kezdete").selectOption("2026-06");
    await expect(avg).toContainText("4 lezárt hónap");
    await expect(avg).toContainText("kezdet: 2026. június");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(main.getByLabel("Az átlag kezdete")).toHaveValue("2026-06");
    await main.getByRole("button", { name: "Nincs határ" }).click();
    await expect(main.locator(".card", { hasText: "Havi bevétel (átlag)" }).first()).toContainText("9 lezárt hónap");
  });

  test("the category lists: income first, spending after; with a start month only what happened since", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/cashflow");
    const income = page.getByTestId("cf-income");
    const spending = page.getByTestId("cf-expense");
    await expect(income).toContainText("Bevételek");
    await expect(income).toContainText("Teszt-Fizetés");
    await expect(income).not.toContainText("Teszt-Lakás");
    await expect(spending).toContainText("Kiadások");
    await expect(spending).toContainText("Teszt-Lakás");
    await expect(spending).not.toContainText("Teszt-Fizetés");
    // Income comes first on the page.
    const [yIncome, ySpending] = [(await income.boundingBox())!.y, (await spending.boundingBox())!.y];
    expect(yIncome).toBeLessThan(ySpending);
    // All 9 invented months: 9 × 150 000 rent, 9 × 600 000 pay.
    await expect(spending).toContainText(/1\D350\D000/);
    await expect(income).toContainText(/5\D400\D000/);
    await expect(income.getByText("100%")).toBeVisible();

    // From June on: 4 months (June–September).
    await page.getByLabel("Az átlag kezdete").selectOption("2026-06");
    await expect(spending).toContainText(/\b600\D000/);
    await expect(spending).not.toContainText(/1\D350\D000/);
    await expect(income).toContainText(/2\D400\D000/);
    await expect(spending).toContainText("2026. június óta");
    await expect(page.locator("main")).toContainText("2026. június – 2026. szeptember");
  });

  test("a category opens into its single items; one can be taken out, listed, and put back", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/cashflow");
    const spending = page.getByTestId("cf-expense");
    const open = spending.getByRole("button", { name: "Teszt-Lakás (kiadás) tételei" });
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    const rows = spending.getByTestId("cf-item");
    await expect(rows).toHaveCount(9);
    await expect(spending.getByTestId("cf-items-summary")).toContainText("9 tétel");
    await expect(spending).toContainText(/1\D350\D000/);

    await rows.first().getByRole("checkbox").uncheck();
    // 9 × 150 000 − one rent
    await expect(spending).toContainText(/1\D200\D000/);
    await expect(spending.getByTestId("cf-items-summary")).toContainText("ebből 1 kihúzva");
    await expect(open).toContainText("1 kihúzva");
    await expect(page.getByTestId("cf-skip")).toHaveCount(1);
    await expect(page.locator("main")).toContainText("Kihúzott tételek (1)");

    // Synced setting: survives a reload.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("cf-skip")).toHaveCount(1);
    await expect(page.getByTestId("cf-expense")).toContainText(/1\D200\D000/);

    await page.getByRole("button", { name: /Visszavesz/ }).click();
    await expect(page.getByTestId("cf-skip")).toHaveCount(0);
    await expect(page.getByTestId("cf-expense")).toContainText(/1\D350\D000/);
  });

  test("privacy mode: the single items' notes, accounts and amounts are hidden too", async ({ page }) => {
    await openSeeded(page, { privacy: true });
    await show(page, "/cashflow");
    await page.getByTestId("cf-expense").getByRole("button", { name: "Teszt-Élelmiszer (kiadás) tételei" }).click();
    await expect(page.getByTestId("cf-item").first()).toBeVisible();
    expect(await readableSecrets(page, [...CASHFLOW_CATEGORIES, ...CASHFLOW_ITEM_TEXTS]), "readable in privacy mode").toEqual([]);
  });

  test("importing a CSV: the items are kept here, a skipped item that is recategorised later is dropped with a note", async ({ page }) => {
    const head =
      '"DÁTUM","TÍPUS","FIÓKBÓL","FIÓKBA/KATEGÓRIÁHOZ","ÖSSZEG","VALUTA","ÖSSZEG 2","VALUTA 2","CÍMKÉK","MEGJEGYZÉSEK:"';
    const row = (d: string, t: string, cat: string, a: string, note: string) =>
      `"${d}","${t}","Teszt-Számla","${cat}","${a}","HUF","${a}","HUF","","${note}"`;
    const csv = (secondCategory: string) =>
      Buffer.from(
        [
          head,
          row("2026. 09. 06.", "Kiadás", secondCategory, "20000", "Masodik"),
          row("2026. 09. 05.", "Kiadás", "Import-Étel", "10000", "Elso"),
          row("2026. 09. 01.", "Bevétel", "Import-Fizetés", "500000", "Fizetes"),
        ].join("\n"),
        "utf8",
      );
    const file = (buffer: Buffer) => ({ name: "1Money_2026_ 10_ 24_.csv", mimeType: "text/csv", buffer });

    await openSeeded(page);
    await reopen(page, "/import");
    await page.locator('input[type="file"]').setInputFiles(file(csv("Import-Étel")));
    await expect(page.locator("main")).toContainText("1Money: 1 hónap");
    await page.getByRole("button", { name: /importálása/ }).click();
    await expect(page.locator("main")).toContainText("Sikeres importálás");

    await reopen(page, "/cashflow");
    const spending = page.getByTestId("cf-expense");
    await spending.getByRole("button", { name: "Import-Étel (kiadás) tételei" }).click();
    const rows = spending.getByTestId("cf-item");
    await expect(rows).toHaveCount(2);
    await rows.filter({ hasText: "Masodik" }).getByRole("checkbox").uncheck();
    await expect(spending.locator("tr", { hasText: "Import-Étel" }).first()).toContainText(/\b10\D000/);
    await expect(page.getByTestId("cf-skip")).toHaveCount(1);

    // The same item, now in another category: its skip is dropped and the user is told.
    await reopen(page, "/import");
    await page.locator('input[type="file"]').setInputFiles(file(csv("Import-Egyéb")));
    await expect(page.locator("main")).toContainText("1Money: 1 hónap");
    await page.getByRole("button", { name: /importálása/ }).click();
    await expect(page.locator("main")).toContainText("1 kihúzott tétel már nincs az exportban");

    await reopen(page, "/cashflow");
    await expect(page.getByTestId("cf-skip")).toHaveCount(0);
    await expect(page.getByTestId("cf-expense")).toContainText("Import-Egyéb");
  });

  test("the emergency reserve: a target from the spending, held on the chosen account, no longer idle cash", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/alerts");
    await expect(page.locator("main")).toContainText("Parlagon álló készpénz – Államkincstár");
    const active = async () => Number(/Aktív\s*\((\d+)\)/.exec(await page.locator("main").innerText())?.[1]);
    const before = await active();
    expect(before).toBeGreaterThan(0);

    await show(page, "/cashflow");
    const main = page.locator("main");
    await main.getByLabel("Tartalék", { exact: true }).selectOption("6");
    const status = page.getByTestId("reserve-status");
    // 6 × 248 000 = 1 488 000 target; nothing held until an account is chosen
    await expect(status).toContainText(/1\D488\D000/);
    await expect(status).toContainText("Jelölj ki legalább egy értékpapírt vagy számlát");
    await main.getByLabel(/Államkincstár/).check();
    // 363 430 cash − 100 000 held for a goal = 263 430 in the reserve
    await expect(status).toContainText(/263\D430/);
    await expect(status).toContainText("Hiányzik");
    await expect(main.getByRole("progressbar", { name: "Vésztartalék" })).toBeVisible();

    // Reload keeps it, and the cash is no longer reported as idle.
    await reopen(page, "/alerts");
    await expect(page.locator("main")).toContainText(new RegExp(`Aktív\\s*\\(${before - 1}\\)`));
    expect(await active()).toBe(before - 1);
  });

  test("the reserve can be a bond (the Fix bond): its value counts, the cash stays free", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/alerts");
    const active = async () => Number(/Aktív\s*\((\d+)\)/.exec(await page.locator("main").innerText())?.[1]);
    const before = await active();

    await show(page, "/cashflow");
    const main = page.locator("main");
    await main.getByLabel("Tartalék", { exact: true }).selectOption("6");
    // The Fix bond is offered first, and by choosing it alone the reserve is complete (it is worth more than 1 488 000).
    const first = main.locator("fieldset").first().locator("label").first();
    await expect(first).toContainText("Fix Magyar Állampapír");
    await first.getByRole("checkbox").check();
    const status = page.getByTestId("reserve-status");
    await expect(status).toContainText("A tartalék megvan");
    await expect(status).toContainText("papírban");
    await expect(main.getByRole("progressbar", { name: "Vésztartalék" })).toHaveAttribute("aria-valuenow", "100");

    // The cash is not part of the reserve, so it is still reported as idle: the alert count is unchanged.
    await reopen(page, "/alerts");
    await expect(page.locator("main")).toContainText(new RegExp(`Aktív\\s*\\(${before}\\)`));
    await expect(page.locator("main")).toContainText("Parlagon álló készpénz – Államkincstár");
  });

  test("the forecast suggests the monthly saving from 1Money; nothing changes until it is taken", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/forecast");
    const hint = page.getByTestId("cashflow-hint");
    // 9 invented months: 600 000 income − 248 000 spending ≈ 352 000 a month
    await expect(hint).toContainText(/352\D000/);
    await expect(hint).toContainText("9 lezárt hónap alapján");
    const field = page.locator("main input[inputmode]").first();
    const before = await field.inputValue();
    expect(before).not.toMatch(/352\D?000/);
    await hint.getByRole("button", { name: "Átveszem" }).click();
    await expect(field).toHaveValue(/352\D?000/);
    await expect(hint).toContainText("átvéve");
    await expect(hint.getByRole("button", { name: "Átveszem" })).toHaveCount(0);
  });

  test("the monthly to-do shows up when last month is missing and goes away with the setting", async ({ page }) => {
    await openSeeded(page);
    // The clock stands at 14 Oct. Leave September out (an export of 2 Sep ends before it).
    const upToAugust = fixtureCashflow()
      .filter((m) => m.month <= "2026-08")
      .map((m) => ({ ...m, through: "2026-09-02" }));
    await page.evaluate((months) => localStorage.setItem("pf-cashflow", JSON.stringify(months)), upToAugust);
    // reopen + auto-waiting expectations, not show(): its fade-in wait times out under load.
    await reopen(page, "/alerts");
    await expect(page.locator("main")).toContainText(/Aktív\s*\(7\)/);
    await expect(page.locator("main")).toContainText("1Money-export feltöltése – 2026. szeptember");
    await reopen(page, "/cashflow");
    await page.locator("main").getByLabel(/Havi teendő/).uncheck();
    await reopen(page, "/alerts");
    // It is no longer active: one fewer in "Aktív" (7 → 6), and it moved to the fulfilled history.
    await expect(page.locator("main")).toContainText(/Aktív\s*\(6\)/);
    await expect(page.locator("main")).toContainText(/Teljesült\s*\(\d+\)\s*1Money-export feltöltése/);
  });
});

test.describe("obligations that end (Előrejelzés)", () => {
  test("add one, it is listed with when it frees up, survives a reload, and can be removed", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/forecast");
    const box = page.getByTestId("obligations");
    await expect(box).toContainText("Lejáró kötelezettségek");
    await box.getByLabel("Kötelezettség neve").fill("Teszt-Lízing");
    await box.getByLabel("Kötelezettség havi összege").fill("118000");
    await box.getByLabel("Utolsó fizetés hónapja").fill("2029-04");
    await box.getByRole("button", { name: "Kötelezettség hozzáadása" }).click();
    const row = box.getByTestId("obligation");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Teszt-Lízing");
    await expect(row).toContainText(/118\D000/);
    await expect(row).toContainText("utolsó fizetés 2029. 04., 2029. 05.-tól szabad");

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("obligations").getByTestId("obligation")).toHaveCount(1);

    await page.getByTestId("obligations").getByRole("button", { name: "Teszt-Lízing törlése" }).click();
    await expect(page.getByTestId("obligations").getByTestId("obligation")).toHaveCount(0);
  });

  test("an ended one stays listed as over; the add button waits for a valid entry", async ({ page }) => {
    await openSeeded(page);
    await page.evaluate(() => {
      localStorage.setItem("pf-forecast", JSON.stringify({ obligations: [{ id: "o1", name: "Teszt-Régi", monthlyHuf: 20000, endMonth: "2026-08" }] }));
      localStorage.setItem("pf-forecast-updated", "2026-10-14T08:00:00.000Z");
    });
    await show(page, "/forecast");
    const box = page.getByTestId("obligations");
    await expect(box.getByTestId("obligation")).toContainText("lejárt");
    await expect(box.getByRole("button", { name: "Kötelezettség hozzáadása" })).toBeDisabled();
    await box.getByLabel("Kötelezettség havi összege").fill("5000");
    await box.getByLabel("Utolsó fizetés hónapja").fill("2026-08"); // in the past
    await expect(box.getByRole("button", { name: "Kötelezettség hozzáadása" })).toBeDisabled();
    await box.getByLabel("Utolsó fizetés hónapja").fill("2027-02");
    await expect(box.getByRole("button", { name: "Kötelezettség hozzáadása" })).toBeEnabled();
  });

  test("privacy mode: the name and the amount are hidden", async ({ page }) => {
    await openSeeded(page, { privacy: true });
    await page.evaluate(() => {
      localStorage.setItem("pf-forecast", JSON.stringify({ obligations: [{ id: "o1", name: "Teszt-Lízing", monthlyHuf: 118000, endMonth: "2029-04" }] }));
      localStorage.setItem("pf-forecast-updated", "2026-10-14T08:00:00.000Z");
    });
    await show(page, "/forecast");
    await expect(page.getByTestId("obligation")).toBeVisible();
    expect(await readableSecrets(page, ["Teszt-Lízing", ...savingsGoals().map((g) => g.name)])).toEqual([]);
  });
});

test.describe("holdings: one table everywhere, details in a sheet", () => {
  test("a dashboard row opens the instrument sheet with the buys; Esc closes it", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/");
    const main = page.locator("main");
    if (await main.getByRole("tab", { name: "Eszközök" }).count()) await main.getByRole("tab", { name: "Eszközök" }).click();
    await main.getByRole("button", { name: "VWCE" }).first().click();
    const sheet = page.getByRole("dialog", { name: /VWCE/ });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Vásárlásaim");
    await expect(sheet).toContainText("Piaci adatok (1 év)");
    await expect(sheet).toContainText("Nagy mozgás riasztás");
    expect(await sidewaysOverflow(page), "elements wider than the screen").toEqual([]);
    if (test.info().project.name === "desktop") {
      const scrolling = await sheet.locator("table").evaluateAll((tables) =>
        tables.filter((t) => t.parentElement && t.parentElement.scrollWidth > t.parentElement.clientWidth + 1).length,
      );
      expect(scrolling, "purchase table scrolls sideways in the desktop sheet").toBe(0);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("an account page lists only that account's holdings", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/accounts/mak");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Értékpapírok" })).toBeVisible();
    await expect(main.getByRole("button", { name: "VWCE" })).toHaveCount(0);
    await show(page, "/accounts");
    await expect(main.getByRole("heading", { name: "Eszközeim" })).toHaveCount(0);
  });

  test("paper data from the sync repo: in the sheet and as sector exposure on the dashboard", async ({ page }) => {
    await openSeeded(page, { sync: true });
    const at = "2026-10-14T05:00:00.000Z";
    const file = {
      v: 1,
      updatedAt: at,
      items: {
        IE00BK5BQT80: {
          symbol: "VWCE.DE",
          fetchedAt: at,
          quoteType: "ETF",
          currency: "EUR",
          pe: 21.04,
          pb: 3.44,
          totalAssets: 85_316_706_304,
          sectors: [
            { name: "technology", weight: 0.317 },
            { name: "financial_services", weight: 0.1675 },
          ],
          topHoldings: [{ name: "NVIDIA Corp", weight: 0.048 }],
        },
      },
      errors: {},
    };
    await page.route(/api\.github\.com\/repos\/teszt\/adat\/contents\//, (r) =>
      new URL(r.request().url()).pathname.endsWith("market/fundamentals.json")
        ? r.fulfill({ json: { sha: "s", content: Buffer.from(JSON.stringify(file), "utf8").toString("base64") } })
        : r.fulfill({ status: 404, body: "" }),
    );
    await show(page, "/");
    const main = page.locator("main");
    if (await main.getByRole("tab", { name: "Allokáció" }).count()) await main.getByRole("tab", { name: "Allokáció" }).click();
    const donut = main.getByTestId("alloc-donut");
    const detail = page.getByTestId("slice-detail");
    // A slice's legend row lists what it is made of: on hover (desktop) or tap (touch).
    const point = async (name: string) => {
      const row = donut.getByText(name, { exact: true });
      if (await main.getByRole("tab", { name: "Allokáció" }).count()) await row.click();
      else await row.hover();
    };
    await point("Állampapír");
    await expect(detail).toContainText("Állampapír");
    await donut.getByRole("button", { name: "Szektor" }).click();
    await expect(donut).toContainText("Technológia");
    await expect(donut).toContainText("alapján");
    await point("Technológia");
    await expect(detail).toContainText("VWCE");
    if (await main.getByRole("tab", { name: "Eszközök" }).count()) await main.getByRole("tab", { name: "Eszközök" }).click();
    await main.getByRole("button", { name: "VWCE" }).first().click();
    const sheet = page.getByRole("dialog", { name: /VWCE/ });
    await expect(sheet).toContainText("Papír-adatok");
    await expect(sheet).toContainText("P/E (súlyozott)");
    await expect(sheet).toContainText("21,0");
    await expect(sheet).toContainText("NVIDIA Corp");
  });

  test("outlook from the sync repo: market-implied band and named views in the sheets, nothing personal", async ({ page }) => {
    await openSeeded(page, { sync: true, privacy: true });
    const at = "2026-10-14T05:00:00.000Z";
    const file = {
      v: 1,
      updatedAt: at,
      profiles: {
        GB00BJYDH287: { assetClass: "crypto", underlying: "BTC", source: "rule", checkedAt: at },
        IE00BK5BQT80: { assetClass: "equity_fund", source: "ai", checkedAt: at },
      },
      items: {
        GB00BJYDH287: {
          implied: [
            { underlying: "BTC", horizonDays: 163, expiry: "2027-03-26", spot: 83_000, forward: 84_000, p10: 59_000, p50: 82_500, p90: 115_000, probUp: 0.485, asOf: "2026-10-14" },
          ],
        },
        IE00BK5BQT80: {
          // A months-old consensus is still shown, but as old.
          consensus: [
            { source: "yahoo", asOf: "2026-04-01", currency: "EUR", target: { min: 100, avg: 110, max: 120, count: 5 } },
          ],
          views: [
            { house: "Vanguard", kind: "annualReturn", value: 0.059, unit: "%/év", horizon: "10 év", publishedAt: "2026-01-22", url: "https://example.com/vcmm" },
          ],
        },
      },
      errors: {},
    };
    await page.route(/api\.github\.com\/repos\/teszt\/adat\/contents\//, (r) =>
      new URL(r.request().url()).pathname.endsWith("market/outlook.json")
        ? r.fulfill({ json: { sha: "s", content: Buffer.from(JSON.stringify(file), "utf8").toString("base64") } })
        : r.fulfill({ status: 404, body: "" }),
    );
    await show(page, "/accounts/ly-tbsz25");
    const goalNames = savingsGoals().map((g) => g.name);

    await page.locator("main").getByRole("button", { name: "VWCE" }).first().click();
    const vwce = page.getByRole("dialog", { name: /VWCE/ });
    await expect(vwce).toContainText("Kilátások");
    await expect(vwce).toContainText("Nevesített előrejelzések");
    await expect(vwce).toContainText("Vanguard");
    await expect(vwce).toContainText("5,9%/év");
    await expect(vwce).toContainText("régi adat");
    await expect(vwce).toContainText("Nem befektetési tanács");
    expect(await readableSecrets(page, goalNames, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");

    await page.locator("main").getByRole("button", { name: "WBIT" }).first().click();
    const wbit = page.getByRole("dialog", { name: /WBIT/ });
    await expect(wbit).toContainText("Az opciós piac várakozása (BTC-opciók, Deribit)");
    await expect(wbit).toContainText("~5 hó");
    await expect(wbit).toContainText("49%");
    expect(await readableSecrets(page, goalNames, '[role="dialog"]')).toEqual([]);
  });

  test("forecast: 'Kilátások alapján' derives the returns, shows where they come from, never overwrites the manual ones", async ({ page }) => {
    await openSeeded(page, { sync: true, privacy: true });
    const at = "2026-10-14T05:00:00.000Z";
    const file = {
      v: 1,
      updatedAt: at,
      profiles: {
        IE00BK5BQT80: { assetClass: "equity_fund", source: "ai", checkedAt: at },
        GB00BJYDH287: { assetClass: "crypto", underlying: "BTC", source: "ai", checkedAt: at },
      },
      items: {
        IE00BK5BQT80: {
          views: [
            { house: "Vanguard", kind: "annualReturn", value: 0.051, unit: "USD", horizon: "10 év", publishedAt: "2026-06-30", url: "https://example.com/vanguard" },
            { house: "Invesco", kind: "annualReturn", value: 0.06, unit: "USD", horizon: "10 év", publishedAt: "2026-06-30", url: "https://example.com/invesco" },
            { house: "J.P. Morgan", kind: "annualReturn", value: 0.07, unit: "USD", horizon: "10–15 év", publishedAt: "2026-06-30", url: "https://example.com/jpm" },
          ],
        },
      },
      errors: {},
    };
    await page.route(/api\.github\.com\/repos\/teszt\/adat\/contents\//, (r) =>
      new URL(r.request().url()).pathname.endsWith("market/outlook.json")
        ? r.fulfill({ json: { sha: "s", content: Buffer.from(JSON.stringify(file), "utf8").toString("base64") } })
        : r.fulfill({ status: 404, body: "" }),
    );
    await show(page, "/forecast");
    const real = page.getByLabel("Reális (% / év)");
    const source = page.getByTestId("return-source");

    // Manual by default: the typed 6 %, and a preview of what the outlook would say.
    await expect(real).toHaveValue("6");
    await expect(real).not.toHaveAttribute("readonly", "");
    await expect(source).toContainText("A Kilátások szerint:");

    await source.getByRole("button", { name: "Kilátások alapján" }).click();
    await expect(source).toContainText("A mezők a levezetett értékeket mutatják");
    await expect(real).toHaveAttribute("readonly", "");
    await expect(real).not.toHaveValue("6");
    const derived = await real.inputValue();

    // Where it comes from: the asset, its houses, the correction, the disclaimer.
    await source.getByText("Honnan jön?").click();
    const breakdown = page.getByTestId("return-breakdown");
    await expect(breakdown).toContainText("VWCE");
    await expect(breakdown).toContainText("Vanguard");
    await expect(breakdown).toContainText("deviza-korr.");
    await expect(breakdown).toContainText("nem befektetési tanács");
    expect(await readableSecrets(page, savingsGoals().map((g) => g.name), "main")).toEqual([]);

    // The choice stays across a reload, and so do the derived numbers…
    await page.reload();
    await expect(page.getByLabel("Reális (% / év)")).toHaveValue(derived);
    // …and switching back finds the manual numbers untouched.
    await page.getByTestId("return-source").getByRole("button", { name: "Kézi" }).click();
    await expect(page.getByLabel("Reális (% / év)")).toHaveValue("6");
    await expect(page.getByLabel("Pesszimista (% / év)")).toHaveValue("3");
    await expect(page.getByLabel("Optimista (% / év)")).toHaveValue("9");
  });

  test("privacy mode: nothing personal is readable in the sheet", async ({ page }) => {
    await openSeeded(page, { privacy: true });
    await show(page, "/accounts/ly-tbsz25");
    await page.locator("main").getByRole("button", { name: "VWCE" }).first().click();
    await expect(page.getByRole("dialog")).toContainText("Vásárlásaim");
    const goalNames = savingsGoals().map((g) => g.name);
    expect(await readableSecrets(page, goalNames, '[role="dialog"]')).toEqual([]);
  });
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
    .poll(async () => {
      const main = page.locator("main");
      const labels = await main.locator("[aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")).join(" "));
      return `${await main.innerText()} ${labels}`.replace(/[\s\u00a0\u202f.]/g, "");
    })
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

test.describe("medium-term goals (Középtávú célok)", () => {
  test("a goal is added in the dialog and its card appears", async ({ page }) => {
    const errors = await openSeeded(page);
    await show(page, "/goals");
    await page.getByRole("button", { name: "Új cél" }).last().click();
    const dialog = page.getByRole("dialog", { name: "Új cél" });
    await expect(dialog).toBeVisible();
    // Nothing is saved without a name: the reason is shown in the dialog.
    await dialog.getByRole("button", { name: "Cél felvétele" }).click();
    await expect(dialog.getByText("Adj nevet a célnak.")).toBeVisible();
    await dialog.getByPlaceholder("pl. Autó").fill("E2E cél");
    await dialog.getByLabel("Célösszeg (Ft)").fill("900000");
    await dialog.getByLabel("Céldátum").fill("2035-12-31");
    await expect(dialog.getByText(/Havi/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cél felvétele" }).click();
    await expect(dialog).toBeHidden();
    // The new goal's card title (the budget strip above also lists the name, truncated).
    await expect(
      page.locator("span.priv.font-medium:not(.truncate)", { hasText: "E2E cél" }),
    ).toBeVisible();
    expect(errors, "console / page errors").toEqual([]);
    expect(await sidewaysOverflow(page), "elements wider than the screen").toEqual([]);
  });

  test("a goal is closed after confirmation: it drops to the end, dimmed", async ({ page }) => {
    const errors = await openSeeded(page);
    await show(page, "/goals");
    const first = savingsGoals()[0].name;
    const cards = page.locator("main div.rounded-xl.border.p-3");
    const before = await cards.count();
    await page.getByRole("button", { name: "Cél lezárása" }).first().click();
    // Nothing happens until the confirmation.
    await expect(page.getByText("Lezárva", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Mégse" }).first().click();
    await page.getByRole("button", { name: "Cél lezárása" }).first().click();
    await page.getByRole("button", { name: "Lezárás", exact: true }).click();
    await expect(page.getByText("Lezárva", { exact: true })).toHaveCount(1);
    await expect(cards).toHaveCount(before);
    const last = cards.last();
    await expect(last).toContainText(first);
    await expect(last).toContainText("Lezárva");
    await expect(last).toHaveCSS("opacity", /^0.[45]/);
    // It can be reopened.
    await last.getByRole("button", { name: "Cél újranyitása" }).click();
    await expect(page.getByText("Lezárva", { exact: true })).toHaveCount(0);
    expect(errors, "console / page errors").toEqual([]);
  });

  test("the schedule popup shows the chart and the planned amounts", async ({ page }) => {
    const errors = await openSeeded(page);
    await show(page, "/goals");
    await page.getByRole("button", { name: "Ütemterv" }).first().click();
    const dialog = page.getByRole("dialog", { name: /Ütemterv/ });
    await expect(dialog.getByText("Tervezett összegek")).toBeVisible();
    await expect(dialog.locator("svg.recharts-surface").first()).toBeVisible();
    await expect(dialog.getByText("Céldátum", { exact: true })).toBeVisible();
    expect(errors, "console / page errors").toEqual([]);
  });

  test("privacy mode: nothing personal is readable in the schedule popup", async ({ page }) => {
    await openSeeded(page, { privacy: true });
    await show(page, "/goals");
    await page.getByRole("button", { name: "Ütemterv" }).first().click();
    const dialog = page.getByRole("dialog", { name: /Ütemterv/ });
    await expect(dialog.getByText("Tervezett összegek")).toBeVisible();
    const leaks = await readableSecrets(page, savingsGoals().map((g) => g.name), '[role="dialog"]');
    expect(leaks, "readable amounts / goal names in privacy mode").toEqual([]);
  });
});

test.describe("market news (Hírek)", () => {
  /**
   * The sync repo with an invented digest; the snapshot file is not there.
   * After openSeeded: the route registered last wins over its network cut.
   */
  async function withNews(page: Page) {
    const { fixtureDigest, fixtureEventsFile } = await import("../src/test/newsFixture");
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
      if (path === "news/events.json") return r.fulfill(file(fixtureEventsFile()));
      return r.fulfill({ status: 404, body: "" });
    });
  }

  test("the page lists the latest digest; the dashboard card links to it", async ({ page }, info) => {
    const errors = await openSeeded(page, { sync: true });
    await withNews(page);
    await show(page, "/hirek");
    const main = page.locator("main");
    await expect(main).toContainText("Reggeli előzetes");
    await expect(main).toContainText("Gyengült a forint <az euróval> szemben");
    await expect(main).toContainText("Következő napok");
    // the announcements followed, and what came out of the earlier ones
    await expect(main).toContainText("Teszt inflációs adat");
    await expect(main.getByTitle("Az eredményét a bejelentés után automatikusan megkeresi")).toHaveCount(1);
    const followUps = page.getByTestId("follow-ups");
    await expect(followUps).toContainText("Figyelt bejelentések");
    await expect(followUps).toContainText("Teszt kamatdöntés");
    await expect(followUps).toContainText("vár a bejelentésre");
    await expect(followUps).toContainText("Bejelentések eredménye");
    await expect(followUps).toContainText("3,2% é/é");
    await expect(followUps).toContainText("a várakozás felett");
    // filter by the affected asset
    const filter = main.getByRole("group", { name: "Szűrés érintett papírra" });
    await filter.getByRole("button", { name: /^WBIT/ }).click();
    await expect(main).toContainText("Gyengült a forint <az euróval> szemben");
    await expect(main).not.toContainText("Kitalált háttérhír");
    await filter.getByRole("button", { name: "Mind" }).click();
    await expect(main).toContainText("Kitalált háttérhír");
    await page.selectOption("#news-pick", { index: 1 });
    await expect(main).toContainText("Napzárta");
    expect(await sidewaysOverflow(page), "elements wider than the screen").toEqual([]);

    await show(page, "/");
    await expect(main).toContainText("Piaci hírek");
    if (info.project.name === "mobile") {
      // On the phone the market tab comes first and is open by default.
      await expect(main.getByRole("tab").first()).toHaveText("Piac");
      await expect(main.getByRole("tab", { name: "Piac" })).toHaveAttribute("aria-selected", "true");
    }
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
  const dkj = card.getByRole("combobox", { name: "DKJ-sorozat" });
  await expect(dkj).toHaveValue("D261223");
  await expect(dkj.locator("option")).toHaveText(["DKJ D261223", "DKJ D270120"]);
  const dkjRow = card.locator("tr", { has: page.getByRole("combobox", { name: "DKJ-sorozat" }) });
  await expect(dkjRow).toContainText("5,24%");
  await dkj.selectOption("D270120");
  await expect(dkjRow).toContainText("5,20%");
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

  test("on touch, a short tap shows an element's title like a hover does", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "touch only");
    await openSeeded(page);
    await show(page, "/");
    const marked = await page.evaluate(() => {
      const el = [...document.querySelectorAll("main [title]")].find(
        (e) =>
          e.getAttribute("title")!.trim() &&
          !e.closest("a,button,input,select,textarea,label,summary,[role=button],[role=tab],[role=link]") &&
          (e as HTMLElement).offsetWidth > 0,
      );
      el?.setAttribute("data-e2e-titled", "");
      return el?.getAttribute("title") ?? null;
    });
    expect(marked, "a titled, non-interactive element on the dashboard").not.toBeNull();
    const pop = page.locator("[data-touch-title]");
    await page.locator("[data-e2e-titled]").tap();
    await expect(pop).toBeVisible();
    await expect(pop).toHaveText(marked!.trim());
    await page.locator("[data-e2e-titled]").tap();
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

test.describe("Telegram notification settings", () => {
  test("a switch, a time and an AI mode are kept after a reload; nothing spills out sideways", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/settings");
    await expect(page.getByRole("heading", { name: "Telegram-értesítések" })).toBeVisible();
    const weekly = page.getByLabel("Heti jelentés", { exact: true });
    await expect(weekly).toBeChecked();
    await weekly.uncheck();
    await page.getByLabel("Éjszakai AI-elemzés", { exact: true }).selectOption("silent");
    await page.getByLabel("Csendes órák kezdete").fill("23:00");
    expect(await sidewaysOverflow(page), "elements wider than the screen").toEqual([]);
    await reopen(page, "/settings");
    await expect(page.getByLabel("Heti jelentés", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("Éjszakai AI-elemzés", { exact: true })).toHaveValue("silent");
    await expect(page.getByLabel("Csendes órák kezdete")).toHaveValue("23:00");
  });
});

test.describe("restore from a backup file", () => {
  /** The "Tranzakciók" count in the Beállítások data card. */
  const txCount = async (page: Page) =>
    Number(await page.locator("dt", { hasText: "Tranzakciók" }).locator("xpath=following-sibling::dd").innerText());

  const backupFile = (extra: boolean) => {
    const snap = fixtureSnapshot();
    const txs = extra ? [...snap.transactions, { ...snap.transactions[0], id: "mentes-extra-1" }] : snap.transactions;
    return {
      name: "mentes.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          kind: "portfolio-backup",
          version: 1,
          exportedAt: "2026-10-13T09:00:00.000Z",
          accounts: snap.accounts,
          instruments: snap.instruments,
          transactions: txs,
          alertState: {},
          goals: [],
          deletedGoalIds: [],
          deletedAccounts: {},
          reminders: [],
          deletedReminderIds: [],
          deletedAlertIds: [],
          fx: {},
        }),
      ),
    };
  };

  test("brings back what is missing, keeps the rest, and survives a reload", async ({ page }) => {
    const errors = await openSeeded(page);
    await show(page, "/settings");
    const before = await txCount(page);
    await page.getByTestId("restore-input").setInputFiles(backupFile(true));
    // The summary comes first; nothing has changed yet.
    await expect(page.getByTestId("restore-confirm")).toContainText(`${before + 1} tranzakció`);
    expect(await txCount(page)).toBe(before);
    await page.getByRole("button", { name: "Visszatöltés", exact: true }).click();
    await expect(page.getByText("Visszatöltve. 1 új tranzakció.")).toBeVisible();
    await expect.poll(() => txCount(page)).toBe(before + 1);
    await reopen(page, "/settings");
    expect(await txCount(page)).toBe(before + 1);
    expect(errors).toEqual([]);
  });

  test("a security the backup brings gets its live price right away, not at the next poll", async ({ page }) => {
    await openSeeded(page);
    const proxyCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("workers.dev")) proxyCalls.push(r.url());
    });
    await show(page, "/settings");
    // Let the startup round settle, then count only what the restore causes.
    await page.waitForTimeout(1500);
    const before = proxyCalls.length;
    const snap = fixtureSnapshot();
    const etf = snap.instruments.find((i) => i.type === "etf")!;
    const fresh = { ...etf, key: "IE00UJETF0001", isin: "IE00UJETF0001", name: "Új ETF" };
    const file = backupFile(false);
    const body = JSON.parse(file.buffer.toString());
    body.instruments.push(fresh);
    await page.getByTestId("restore-input").setInputFiles({ ...file, buffer: Buffer.from(JSON.stringify(body)) });
    await page.getByRole("button", { name: "Visszatöltés", exact: true }).click();
    await expect(page.getByText(/^Visszatöltve./)).toBeVisible();
    // The new security's quote is looked up by its ISIN (not merely "some request").
    await expect
      .poll(() => proxyCalls.slice(before).some((u) => u.includes("IE00UJETF0001")), {
        message: "a price request for the restored security",
      })
      .toBe(true);
  });

  test("Mégse changes nothing; a file that is not a backup is refused with a reason", async ({ page }) => {
    await openSeeded(page);
    await show(page, "/settings");
    const before = await txCount(page);
    await page.getByTestId("restore-input").setInputFiles(backupFile(true));
    await page.getByRole("button", { name: "Mégse", exact: true }).click();
    await expect(page.getByTestId("restore-confirm")).toHaveCount(0);
    expect(await txCount(page)).toBe(before);

    await page.getByTestId("restore-input").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from("nem json") });
    await expect(page.getByText("A fájl nem érvényes JSON.")).toBeVisible();
    await page.getByTestId("restore-input").setInputFiles({ name: "y.json", mimeType: "application/json", buffer: Buffer.from('{"version":1}') });
    await expect(page.getByText(/nem portfólió-mentés/)).toBeVisible();
    expect(await txCount(page)).toBe(before);
  });
});

test.describe("delete all data", () => {
  const ls = (page: Page, keys: string[]) =>
    page.evaluate((ks) => Object.fromEntries(ks.map((k) => [k, localStorage.getItem(k)])), keys);

  test("the database and the planning prefs (goals…) are gone; look and privacy settings stay", async ({ page }) => {
    await openSeeded(page);
    await page.evaluate(() => localStorage.setItem("pf-skin", "terminal"));
    const synced = ["pf-savings", "pf-savings-updated", "pf-glidepath", "pf-glidepath-updated", "pf-income", "pf-broker-fees"];
    const before = await ls(page, synced);
    for (const k of ["pf-savings", "pf-glidepath"]) expect(before[k], `${k} is seeded`).not.toBeNull();

    await show(page, "/settings");
    await page.getByRole("button", { name: "Összes adat törlése" }).click();
    await page.getByRole("button", { name: "Igen, töröljem mindet" }).click();
    await expect(page.locator("dt", { hasText: "Tranzakciók" }).locator("xpath=following-sibling::dd")).toHaveText("0");

    // Gone right away, and still gone after a reload (nothing re-seeds on an empty app).
    const gone = Object.fromEntries(synced.map((k) => [k, null]));
    expect(await ls(page, synced)).toEqual(gone);
    await reopen(page, "/settings");
    expect(await ls(page, synced)).toEqual(gone);
    // Not data: the look stays.
    expect((await ls(page, ["pf-skin"]))["pf-skin"]).toBe("terminal");
  });
});

test.describe("?skin= link", () => {
  test("forces the Asszisztens skin for that window and leaves the stored skin alone", async ({ page }) => {
    await openSeeded(page);
    await page.evaluate(() => localStorage.setItem("pf-skin", "terminal"));

    await page.goto("./?skin=asszisztens#/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("html")).toHaveAttribute("data-skin", "asszisztens");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#000000");
    await expect(page.getByRole("button", { name: /Asszisztens/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("a megnyitó link állította be")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("pf-skin"))).toBe("terminal");

    // A plain link opens with the stored skin again.
    await page.goto("./#/settings");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("html")).toHaveAttribute("data-skin", "terminal");
  });
});

test.describe("leftovers of the removed Google sync", () => {
  test("a stored sign-in and access token are cleared when the app starts", async ({ page }) => {
    await openSeeded(page);
    await page.evaluate(() => {
      localStorage.setItem("portfolio.googleSync", JSON.stringify({ email: "teszt@example.com", path: "data.json" }));
      localStorage.setItem("portfolio.googleToken", JSON.stringify({ accessToken: "t", expiresAt: Date.now() + 3_000_000 }));
    });
    await page.reload();
    await page.waitForLoadState("networkidle");
    // The app's own data is untouched by the cleanup.
    await show(page, "/settings");
    await expect(page.locator("dt", { hasText: "Tranzakciók" }).locator("xpath=following-sibling::dd")).not.toHaveText("0");
    const keys = await page.evaluate(() => [localStorage.getItem("portfolio.googleSync"), localStorage.getItem("portfolio.googleToken")]);
    expect(keys).toEqual([null, null]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PROBE_DAYS,
  candidateDays,
  collectIssuerDocs,
  listPending,
  readIssuerState,
  removePending,
  urlFor,
  urlTemplate,
  type Fetched,
} from "./issuerDocs";
import { miniPdf } from "./pdfFixture";
import type { OutlookFile } from "../../../src/lib/outlook";

const BASE = "https://example.com/static/Consensus_20260803.pdf";
const NOW = new Date(2026, 9, 13, 6, 50); // 2026-10-13

const longRows = (extra = ""): [number, number, string][] =>
  Array.from({ length: 12 }, (_, i) => [50, 780 - i * 20, `Celar sor ${i} ${extra} HUF 45.888 atlag 29.000 min 58.667 max`]);
const pdf = (extra = "") => miniPdf(longRows(extra));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "issuer-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function remote(docs: Record<string, Uint8Array | Fetched>) {
  const heads: string[] = [];
  const gets: string[] = [];
  return {
    heads,
    gets,
    deps: {
      dir,
      head: async (u: string) => {
        heads.push(u);
        return u in docs;
      },
      get: async (u: string): Promise<Fetched> => {
        gets.push(u);
        const d = docs[u];
        if (!d) return { ok: false, contentType: "", bytes: new Uint8Array() };
        return d instanceof Uint8Array ? { ok: true, contentType: "application/pdf", bytes: d } : d;
      },
    },
  };
}

const fileWith = (profiles: Record<string, string | undefined>, consensus: Record<string, string> = {}): OutlookFile => ({
  v: 1,
  updatedAt: "2026-10-13T00:00:00Z",
  profiles: Object.fromEntries(
    Object.entries(profiles).map(([k, url]) => [k, { assetClass: "equity", source: "ai", checkedAt: "2026-10-01", ...(url ? { consensusUrl: url } : {}) }]),
  ) as OutlookFile["profiles"],
  items: Object.fromEntries(
    Object.entries(consensus).map(([k, url]) => [
      k,
      { consensus: [{ source: "issuer", url, asOf: "2026-08-03", currency: "HUF", target: { min: 1, avg: 2, max: 3 } }] },
    ]),
  ) as OutlookFile["items"],
  errors: {},
});

describe("dated addresses", () => {
  it("the date is cut out of the URL and put back", () => {
    const t = urlTemplate(BASE)!;
    expect(t).toEqual({ before: "https://example.com/static/Consensus_", after: ".pdf", day: "2026-08-03" });
    expect(urlFor(t, "2026-09-02")).toBe("https://example.com/static/Consensus_20260902.pdf");
    expect(urlTemplate("https://example.com/consensus.pdf")).toBeNull();
    expect(urlTemplate("https://example.com/id_120260803999.pdf")).toBeNull();
  });

  it("candidate days: after the known one, newest first, capped", () => {
    expect(candidateDays("2026-10-10", "2026-10-13")).toEqual(["2026-10-13", "2026-10-12", "2026-10-11"]);
    expect(candidateDays("2026-10-13", "2026-10-13")).toEqual([]);
    expect(candidateDays("2025-01-01", "2026-10-13")).toHaveLength(MAX_PROBE_DAYS);
  });
});

describe("collectIssuerDocs", () => {
  it("takes the newest document found after the known one and keeps its text", async () => {
    const newer = "https://example.com/static/Consensus_20260929.pdf";
    const older = "https://example.com/static/Consensus_20260915.pdf";
    const r = remote({ [BASE]: pdf("a"), [older]: pdf("b"), [newer]: pdf("c") });
    const out = await collectIssuerDocs(fileWith({ OTP: BASE }), r.deps, NOW);
    expect(out).toEqual({ saved: ["OTP"], errors: {} });
    const pending = listPending(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ key: "OTP", url: newer });
    expect(pending[0].text).toContain("45.888");
    expect(readIssuerState(dir).OTP).toMatchObject({ latestUrl: newer, latestDay: "2026-09-29", handledUrl: newer });
    // newest candidate first: the older one was never even asked about
    expect(r.heads[0]).toBe("https://example.com/static/Consensus_20261013.pdf");
    expect(r.heads).not.toContain(older);
  });

  it("the next day it neither probes the old days nor downloads the handled document again", async () => {
    const newer = "https://example.com/static/Consensus_20260929.pdf";
    const first = remote({ [newer]: pdf() });
    await collectIssuerDocs(fileWith({ OTP: BASE }), first.deps, NOW);
    removePending(dir, "OTP");

    const second = remote({ [newer]: pdf() });
    const out = await collectIssuerDocs(fileWith({ OTP: BASE }), second.deps, new Date(2026, 9, 14, 6, 50));
    expect(out.saved).toEqual([]);
    expect(second.gets).toEqual([]);
    expect(second.heads[0]).toBe("https://example.com/static/Consensus_20261014.pdf");
    expect(second.heads).toHaveLength(15); // 30 Sep … 14 Oct only
    expect(listPending(dir)).toEqual([]);
  });

  it("with nothing newer the document the AI named is the one that is read", async () => {
    const r = remote({ [BASE]: pdf() });
    const out = await collectIssuerDocs(fileWith({ OTP: BASE }), r.deps, NOW);
    expect(out.saved).toEqual(["OTP"]);
    expect(listPending(dir)[0].url).toBe(BASE);
  });

  it("a document whose numbers are in the file already is not read again", async () => {
    const r = remote({ [BASE]: pdf() });
    const out = await collectIssuerDocs(fileWith({ OTP: BASE }, { OTP: BASE }), r.deps, NOW);
    expect(out.saved).toEqual([]);
    expect(r.gets).toEqual([]);
    expect(listPending(dir)).toEqual([]);
  });

  it("a fixed address: new content is new, the same content is not", async () => {
    const fixed = "https://example.com/consensus-latest.pdf";
    const one = remote({ [fixed]: pdf("egy") });
    expect((await collectIssuerDocs(fileWith({ X: fixed }), one.deps, NOW)).saved).toEqual(["X"]);
    removePending(dir, "X");
    expect((await collectIssuerDocs(fileWith({ X: fixed }), remote({ [fixed]: pdf("egy") }).deps, NOW)).saved).toEqual([]);
    expect((await collectIssuerDocs(fileWith({ X: fixed }), remote({ [fixed]: pdf("ketto") }).deps, NOW)).saved).toEqual(["X"]);
  });

  it("not a PDF, no text, or a failed download: an error for that asset only", async () => {
    const html: Fetched = { ok: true, contentType: "text/html", bytes: new TextEncoder().encode("<html>belepj</html>") };
    const empty = miniPdf([[50, 700, "x"]]);
    const urls = { A: "https://example.com/a_20260803.pdf", B: "https://example.com/b_20260803.pdf", C: "https://example.com/c_20260803.pdf", D: "https://example.com/d_20260803.pdf" };
    const r = remote({ [urls.A]: html, [urls.B]: empty, [urls.D]: pdf() });
    const out = await collectIssuerDocs(fileWith(urls), r.deps, NOW);
    expect(Object.keys(out.errors).sort()).toEqual(["A", "B", "C"]);
    expect(out.errors.A).toMatch(/nem PDF/);
    expect(out.errors.B).toMatch(/olvasható szöveg/);
    expect(out.saved).toEqual(["D"]);
  });

  it("an asset without a consensus address is skipped", async () => {
    const r = remote({});
    expect(await collectIssuerDocs(fileWith({ X: undefined }), r.deps, NOW)).toEqual({ saved: [], errors: {} });
    expect(r.heads).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { horizontalBars, linePlot, verticalBars, type Row } from "./plot";

const text = (rows: Row[]) => rows.map((r) => r.map((x) => x.text).join(""));
const braille = (s: string) => [...s].map((c) => c.charCodeAt(0) - 0x2800);

describe("linePlot", () => {
  it("has the requested size and spans the data range", () => {
    const p = linePlot([{ values: [0, 5, 10], color: "cyan" }], 20, 6);
    expect(p.rows).toHaveLength(6);
    for (const line of text(p.rows)) expect([...line]).toHaveLength(20);
    expect([p.min, p.max]).toEqual([0, 10]);
  });

  it("draws a rising line from the bottom left to the top right", () => {
    const rows = text(linePlot([{ values: [0, 1, 2, 3, 4], color: "cyan" }], 10, 4).rows);
    // first column: only the lowest dot row; last column: only the highest.
    expect(braille(rows[3][0])[0] & 0xc0).not.toBe(0); // bottom dots of the first cell
    expect(braille(rows[0][9])[0] & 0x09).not.toBe(0); // top dots of the last cell
    expect(rows[0][0]).toBe(" ");
    expect(rows[3][9]).toBe(" ");
  });

  it("colours a cell by the series drawn last", () => {
    const p = linePlot(
      [
        { values: [1, 1, 1], color: "red" },
        { values: [1, 1, 1], color: "green" },
      ],
      6,
      3,
    );
    const colours = new Set(p.rows.flat().filter((r) => r.text.trim()).map((r) => r.color));
    expect(colours).toEqual(new Set(["green"]));
  });

  it("uses a fixed domain and tolerates gaps and flat data", () => {
    expect(linePlot([{ values: [2, 3], color: "x" }], 4, 2, [0, 10]).max).toBe(10);
    expect(linePlot([{ values: [1, NaN, 3], color: "x" }], 6, 3).rows).toHaveLength(3);
    const flat = linePlot([{ values: [5, 5, 5], color: "x" }], 6, 3);
    expect(flat.min).toBeLessThan(flat.max);
  });

  it("is empty without data", () => {
    expect(linePlot([], 10, 4).rows).toEqual([]);
    expect(linePlot([{ values: [], color: "x" }], 10, 4).rows).toEqual([]);
  });
});

describe("verticalBars", () => {
  it("grows positive bars up from the bottom, in proportion", () => {
    const rows = text(verticalBars([{ value: 0.5 }, { value: 2 }, { value: 4 }], 4));
    expect(rows).toHaveLength(4);
    // the tallest bar fills every row, the shortest only the bottom one.
    expect(rows.map((r) => r[4])).toEqual(["█", "█", "█", "█"]);
    expect(rows.map((r) => r[0])).toEqual([" ", " ", " ", "▄"]);
  });

  it("keeps a tiny positive bar visible next to a huge one", () => {
    const rows = text(verticalBars([{ value: 0.001 }, { value: 100 }], 5));
    expect(rows[rows.length - 1][0]).toBe("▁");
    expect(verticalBars([{ value: 0 }, { value: 100 }], 5).map((r) => r[0].text[0]).join("").trim()).toBe("");
  });

  it("puts negative bars under a zero line", () => {
    const rows = text(verticalBars([{ value: 3 }, { value: -3 }], 5));
    const zero = rows.findIndex((r) => r.startsWith("─"));
    expect(zero).toBeGreaterThan(0);
    expect(rows[zero - 1][0]).toBe("█");
    expect(rows[zero + 1][2]).toBe("█");
    expect(rows[zero + 1][0]).toBe(" ");
  });

  it("handles only-negative, all-zero and empty input", () => {
    expect(text(verticalBars([{ value: -1 }, { value: -2 }], 3)).join("")).toContain("█");
    expect(text(verticalBars([{ value: 0 }], 3))).toEqual(["──"]);
    expect(verticalBars([], 3)).toEqual([]);
  });

  it("keeps the requested height when there are positive bars only", () => {
    expect(verticalBars([{ value: 1 }, { value: 2 }], 6)).toHaveLength(6);
  });
});

describe("horizontalBars", () => {
  it("scales to the largest value and pads the labels", () => {
    const [a, b] = horizontalBars(
      [
        { label: "ETF", value: 50, note: "50%" },
        { label: "Kötvény", value: 25, note: "25%" },
      ],
      20,
    );
    expect(a.bar.text).toBe("█".repeat(20));
    expect(b.bar.text).toBe("█".repeat(10));
    expect(a.label).toBe("ETF    ");
    expect(b.label).toBe("Kötvény");
    expect(a.note).toBe("50%");
  });

  it("uses eighth blocks for the remainder and survives zero", () => {
    const [a] = horizontalBars([{ label: "a", value: 1 }, { label: "b", value: 8 }], 1);
    expect(a.bar.text).toBe("▏");
    expect(horizontalBars([{ label: "a", value: 0 }], 10)[0].bar.text).toBe("");
  });
});

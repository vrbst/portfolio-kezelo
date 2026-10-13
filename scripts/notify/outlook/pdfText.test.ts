import { describe, expect, it } from "vitest";
import { linesOf, pdfToText } from "./pdfText";
import { miniPdf } from "./pdfFixture";

describe("linesOf", () => {
  it("pieces on one baseline make one line, left to right; lines top to bottom", () => {
    expect(
      linesOf([
        { x: 300, y: 700.4, text: "46.700" },
        { x: 50, y: 700, text: "Árfolyam:" },
        { x: 50, y: 680, text: "Célár" },
        { x: 10, y: 720, text: "Cím" },
        { x: 400, y: 690, text: "   " },
      ]),
    ).toEqual(["Cím", "Árfolyam: 46.700", "Célár"]);
  });
});

describe("pdfToText", () => {
  it("reads the text layer and keeps table rows together", async () => {
    const pdf = miniPdf([
      [50, 780, "OTP Bank - Elemzoi konszenzus"],
      [50, 740, "EPS (Ft)"],
      [300, 740, "4.577"],
      [400, 740, "5.084"],
      [50, 720, "DPS (HUF)"],
      [300, 720, "1.251"],
    ]);
    const text = await pdfToText(pdf);
    expect(text.split("\n")).toEqual(["OTP Bank - Elemzoi konszenzus", "EPS (Ft) 4.577 5.084", "DPS (HUF) 1.251"]);
  });

  it("rejects something that is not a PDF", async () => {
    await expect(pdfToText(new TextEncoder().encode("<html>nem pdf</html>"))).rejects.toThrow();
  });
});

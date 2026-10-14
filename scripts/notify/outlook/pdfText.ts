import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

interface Piece {
  x: number;
  y: number;
  text: string;
}

/** Items on (almost) the same baseline make one line, left to right. */
export function linesOf(pieces: Piece[], tolerance = 2): string[] {
  const sorted = [...pieces].filter((p) => p.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Piece[][] = [];
  for (const p of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - p.y) <= tolerance) row.push(p);
    else rows.push([p]);
  }
  return rows.map((r) =>
    r
      .sort((a, b) => a.x - b.x)
      .map((p) => p.text.trim())
      .join(" "),
  );
}

/** The text layer of a PDF as lines (table rows stay on one line). */
export async function pdfToText(data: Uint8Array): Promise<string> {
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const pieces: Piece[] = content.items.flatMap((it) =>
        "str" in it ? [{ x: it.transform[4], y: it.transform[5], text: it.str }] : [],
      );
      pages.push(linesOf(pieces).join("\n"));
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}

// Small text helpers shared by the views and the charts.

import { shortName } from "../notify/reports";

/** shortName() escapes for Telegram's HTML; the terminal wants the plain text. */
export const name = (s: string) =>
  shortName(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export const MASK = "••••";
export const HIDDEN = "•••• Ft";

import { OUTLOOK_PATH, validateOutlookFile, type OutlookFile } from "../../../src/lib/outlook";
import type { NewsStore } from "../news/job";

/**
 * The stored market/outlook.json. Null only when the file does not exist yet.
 * A failed read, or a file that cannot be read back, throws: the file holds
 * what only the weekly AI run can make (views, profiles, document addresses),
 * so "could not read it" must never turn into "start again from nothing".
 */
export async function readOutlookFile(store: NewsStore, now: Date): Promise<OutlookFile | null> {
  const text = await store.read(OUTLOOK_PATH);
  if (text == null) return null;
  const file = (() => {
    try {
      return validateOutlookFile(JSON.parse(text), now);
    } catch {
      return null;
    }
  })();
  if (!file) throw new Error(`A ${OUTLOOK_PATH} nem olvasható (hibás vagy új formátumú): nem írom felül.`);
  return file;
}

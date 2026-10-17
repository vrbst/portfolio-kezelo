export const VENDOR_DIR: string;
export const STAMP_FILE: string;
export const DEFAULT_SOURCE: string;
export const VENDORED_FILES: string[];
export function normalizedHash(text: string): string;
export function hashFiles(dir: string, files?: string[]): Record<string, string>;
export function syncHubClient(opts?: { source?: string; target?: string }): {
  package: string;
  version: string;
  source: string;
  hubCommit: string | null;
  files: Record<string, string>;
};

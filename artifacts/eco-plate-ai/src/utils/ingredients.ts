/**
 * Deduplicate a comma-separated ingredient string, preserving order
 * and normalising whitespace.
 */
export function dedupeIngredients(raw: string): string {
  const seen = new Set<string>();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}

/** Count the number of individual ingredients in a comma-separated string. */
export function countIngredients(raw: string): number {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/**
 * Parse comma-separated ingredient string into deduplicated array.
 * Handles whitespace normalization and deduplication.
 */
export function parseIngredientsString(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => {
      if (!s) return false;
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
}

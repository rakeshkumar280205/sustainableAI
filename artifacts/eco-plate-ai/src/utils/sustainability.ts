/**
 * Estimate how many grams of food were saved based on ingredient count.
 * Uses 50–80g per ingredient as a conservative estimate.
 */
export function estimateSavedGrams(usedCount: number): { low: number; high: number } {
  return { low: usedCount * 50, high: usedCount * 80 };
}

/**
 * Calculate what percentage of the user's ingredients a recipe uses.
 */
export function getEfficiencyPct(usedCount: number, totalCount: number): number {
  if (totalCount === 0) return 0;
  return Math.round((usedCount / totalCount) * 100);
}

/**
 * Return a contextual insight line based on ingredient usage and missing count.
 */
export function getSmartInsight(usedCount: number, totalMissing: number): string {
  if (totalMissing === 0)
    return "These recipes are perfect for your ingredients — no extra shopping needed.";
  if (totalMissing <= 2)
    return "Only a couple of extra ingredients needed — very efficient cooking.";
  if (usedCount >= 4)
    return "These recipes maximize usage of your available ingredients.";
  return "You can cook great meals without unnecessary purchases.";
}

/**
 * Find the index of the recipe that uses the most of the user's ingredients.
 */
export function findBestRecipeIndex(
  recipes: { used?: string[] }[]
): number {
  return recipes.reduce(
    (bestIdx, r, i, arr) =>
      (r.used?.length ?? 0) > (arr[bestIdx]?.used?.length ?? 0) ? i : bestIdx,
    0
  );
}

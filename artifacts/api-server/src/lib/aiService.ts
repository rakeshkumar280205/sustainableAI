import OpenAI from "openai";
import { z } from "zod";
import { logger } from "./logger.js";
import config from "../config.js";

// ─── TYPES ───────────────────────────────────────────────────────────────────

export enum AIProvider {
  OpenAI = "openai",
  HuggingFace = "huggingface",
  Fallback = "fallback",
}

// ─── OPENAI CLIENT (vision + text) ────────────────────────────────────────────

function getOpenAIClient(): OpenAI | null {
  if (!config.openaiApiKey) return null;
  return new OpenAI({
    apiKey: config.openaiApiKey,
    ...(config.openaiBaseUrl && { baseURL: config.openaiBaseUrl }),
  });
}

// ─── TIMEOUT HELPER ──────────────────────────────────────────────────────────

function timeoutAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`AI request timed out after ${milliseconds}ms`)),
      milliseconds
    );
  });
}

export interface Recipe {
  name: string;
  description: string;
  instructions: string;
  cookTime: string;
  difficulty: string;
  used: string[];
  missing: string[];
  efficiency?: number; // 0-1: used / (used + missing)
}

export interface RecipeSuggestion {
  recipes: Recipe[];
  sustainabilityMessage: string;
  ingredientsUsed: string[];
  cuisine: string | null;
  isFallback: boolean;
  provider: AIProvider;
  confidence?: number; // 0-1
  cacheHit?: boolean;
}

export interface IngredientDetectionResult {
  ingredients: string[];
  confidence: number; // 0-1
  isApproximate: boolean;
  provider: AIProvider;
}

// ─── RESILIENCE LAYER (CACHE + CIRCUIT BREAKER) ───────────────────────────

const RECIPE_CACHE_TTL_MS = 5 * 60 * 1000;
const RECIPE_CACHE = new Map<
  string,
  { value: RecipeSuggestion; expiresAt: number }
>();

const AI_CIRCUIT_BREAKER_THRESHOLD = 5;
let consecutiveAIFailures = 0;

function isAICircuitOpen(): boolean {
  return consecutiveAIFailures > AI_CIRCUIT_BREAKER_THRESHOLD;
}

function recordAIFailure(): void {
  consecutiveAIFailures += 1;
}

function recordAISuccess(): void {
  consecutiveAIFailures = 0;
}

function normalizeIngredientList(input: string): string[] {
  const seen = new Set<string>();
  return input
    .split(",")
    .map((i) => i.trim().toLowerCase())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function buildRecipeCacheKey(
  ingredientList: string[],
  cuisine: string | null | undefined
): string {
  const cuisineKey = (cuisine ?? "any").trim().toLowerCase() || "any";
  const normalizedIngredients = [...ingredientList].sort((a, b) => a.localeCompare(b));
  return `${normalizedIngredients.join(",")}|${cuisineKey}`;
}

function cloneRecipeSuggestion(value: RecipeSuggestion): RecipeSuggestion {
  return JSON.parse(JSON.stringify(value)) as RecipeSuggestion;
}

function getCachedRecipeSuggestion(cacheKey: string): RecipeSuggestion | null {
  const entry = RECIPE_CACHE.get(cacheKey);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    RECIPE_CACHE.delete(cacheKey);
    return null;
  }

  const cloned = cloneRecipeSuggestion(entry.value);
  cloned.cacheHit = true;
  return cloned;
}

function setCachedRecipeSuggestion(cacheKey: string, value: RecipeSuggestion): void {
  const cacheValue = cloneRecipeSuggestion(value);
  cacheValue.cacheHit = false;
  RECIPE_CACHE.set(cacheKey, {
    value: cacheValue,
    expiresAt: Date.now() + RECIPE_CACHE_TTL_MS,
  });
}

function withEfficiency(
  recipes: Recipe[],
  ingredientList: string[],
  cuisine: string | null | undefined
): Recipe[] {
  const cuisineKey = normalizeCuisine(cuisine);
  const entry = FALLBACK_DATA[cuisineKey] ?? FALLBACK_DATA.default;
  const knownExtras = entry.cuisineExtras;
  const inputSet = new Set(ingredientList);

  const normalizeList = (items: string[]): string[] => {
    const seen = new Set<string>();
    return items
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .filter((item) => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      });
  };

  const scored = recipes.map((recipe) => {
    const sourceUsed = normalizeList(recipe.used ?? []);
    const sourceMissing = normalizeList(recipe.missing ?? []);

    const used = sourceUsed.filter((item) => inputSet.has(item));

    // If provider output doesn't align, keep a sensible used fallback from input.
    const finalUsed = used.length > 0 ? used : ingredientList.slice(0, 3);

    const missingFromSource = sourceMissing.filter(
      (item) => !inputSet.has(item) && !finalUsed.includes(item)
    );
    const missingFromCuisine = knownExtras.filter(
      (item) => !inputSet.has(item) && !finalUsed.includes(item)
    );

    const missing = normalizeList([...missingFromSource, ...missingFromCuisine]).slice(0, 4);

    const efficiency =
      finalUsed.length + missing.length > 0
        ? finalUsed.length / (finalUsed.length + missing.length)
        : 0.5;

    return {
      ...recipe,
      used: finalUsed,
      missing,
      efficiency: Math.min(1, Math.max(0, efficiency)),
    };
  });

  scored.sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0));
  return scored;
}

const OpenAIRecipeSchema = z.object({
  recipes: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1),
        instructions: z.string().min(1),
        cookTime: z.string().min(1),
        difficulty: z.string().min(1),
        used: z.array(z.string()).default([]),
        missing: z.array(z.string()).default([]),
      })
    )
    .min(1)
    .max(2),
});

// ─── FALLBACK RECIPES & DEMO MODE ──────────────────────────────────────────

const DEMO_RECIPES: Record<string, Recipe[]> = {
  "indian+rice": [
    {
      name: "Vegetable Biryani",
      description: "Fragrant basmati rice layered with spiced vegetables — a celebration dish made from whatever's in your pantry.",
      instructions: "1. Wash and soak basmati rice for 30 min. 2. Fry onions in ghee until caramelised. 3. Add ginger-garlic paste, cook 2 min. 4. Add vegetables, turmeric, cumin, garam masala. Stir 3 min. 5. Drain rice, par-boil 6 min. 6. Layer rice over vegetables. 7. Cover tightly, steam on low heat 20 min. 8. Fluff and serve with raita.",
      cookTime: "45 minutes",
      difficulty: "Medium",
      used: ["rice", "onion", "garlic"],
      missing: ["garam masala", "turmeric", "cumin", "ghee or butter"],
    },
    {
      name: "Khichdi",
      description: "The ultimate Indian comfort food — soft rice and lentils cooked with turmeric and tempered spices.",
      instructions: "1. Rinse rice and lentils together. 2. In a pressure cooker, heat oil and add cumin seeds. 3. Add onion, cook golden. 4. Add garlic, tomato, turmeric, salt. 5. Add rice and lentils, pour in 4 cups water. 6. Pressure cook 3 whistles. 7. For tadka: heat ghee, fry mustard seeds, curry leaves, dried red chilli. Pour over khichdi. 8. Serve with pickle.",
      cookTime: "30 minutes",
      difficulty: "Easy",
      used: ["rice", "onion", "garlic"],
      missing: ["lentils", "turmeric", "cumin seeds", "ghee"],
    },
  ],
  "italian+tomato": [
    {
      name: "Pomodoro Pasta",
      description: "The definitive Italian pantry pasta — a silky tomato sauce with garlic and fresh basil that proves simplicity is everything.",
      instructions: "1. Cook pasta in heavily salted boiling water. 2. In a cold pan, combine sliced garlic and olive oil. 3. Warm over medium heat until garlic turns golden — don't rush. 4. Add tomatoes, crush gently. 5. Season generously, simmer 15 min until sauce thickens. 6. Reserve 1 cup pasta water. 7. Drain pasta, toss in sauce, use pasta water to emulsify. 8. Finish with fresh basil and good olive oil.",
      cookTime: "25 minutes",
      difficulty: "Easy",
      used: ["tomato", "garlic"],
      missing: ["pasta", "olive oil", "basil"],
    },
    {
      name: "Bruschetta al Pomodoro",
      description: "Sun-warmed tomatoes with garlic on crisp toasted bread — the honest taste of an Italian summer.",
      instructions: "1. Dice tomatoes, season with salt. Let sit 10 min to release juices. 2. Finely chop garlic and mix with tomatoes. 3. Add a generous pour of olive oil, torn basil, black pepper. 4. Slice bread thickly. Toast under grill or in dry pan until charred at edges. 5. Rub hot bread with a raw garlic clove. 6. Spoon tomato mixture over. Serve immediately.",
      cookTime: "15 minutes",
      difficulty: "Easy",
      used: ["tomato", "garlic"],
      missing: ["crusty bread", "olive oil", "basil"],
    },
  ],
  "chinese+noodles": [
    {
      name: "Garlic Noodle Stir-Fry",
      description: "Slippery noodles tossed in a glossy soy-garlic sauce with wok breath — fast, bold, and deeply satisfying.",
      instructions: "1. Cook noodles per pack instructions, drain. 2. Mix sauce: 3 tbsp soy sauce, 1 tsp sesame oil, 1 tsp sugar, pinch white pepper. 3. Heat wok until smoking. 4. Add oil, then sliced garlic — stir 30 seconds. 5. Add vegetables, toss 2 min. 6. Add noodles and sauce. Toss constantly on high heat 2–3 min. 7. Finish with sesame oil. 8. Top with sliced green onions.",
      cookTime: "15 minutes",
      difficulty: "Easy",
      used: ["noodles", "garlic"],
      missing: ["soy sauce", "sesame oil", "green onions"],
    },
    {
      name: "Dan Dan Noodles",
      description: "Sichuan street noodles in a nutty, spiced broth — warming and complex from simple ingredients.",
      instructions: "1. Cook noodles, drain. 2. Make sauce: 2 tbsp peanut butter, 2 tbsp soy sauce, 1 tbsp rice vinegar, 1 tsp chilli oil, splash hot water. Whisk until smooth. 3. In a pan, cook ground pork or mushrooms until browned. 4. Add garlic, ginger, a spoon of soy sauce. Cook 2 min. 5. Divide noodles into bowls. Pour sauce over. 6. Top with pork/mushrooms, chopped green onions, crushed peanuts.",
      cookTime: "20 minutes",
      difficulty: "Medium",
      used: ["noodles", "garlic"],
      missing: ["peanut butter", "soy sauce", "chilli oil", "rice vinegar"],
    },
  ],
};

// ─── CUISINE-SPECIFIC FALLBACK RECIPES ───────────────────────────────────────

type FallbackEntry = {
  recipes: Recipe[];
  cuisineExtras: string[];
};

const FALLBACK_DATA: Record<string, FallbackEntry> = {
  italian: {
    cuisineExtras: ["pasta", "olive oil", "parmesan", "basil"],
    recipes: [
      {
        name: "Rustic Frittata Italiana",
        description: "A hearty Italian egg dish — the perfect vehicle for any vegetables you need to use up.",
        instructions: "1. Preheat oven to 375°F. 2. Beat 6 eggs with salt, pepper, and Italian seasoning. 3. Sauté your vegetables in an oven-safe skillet for 3–4 min. 4. Pour eggs over. 5. Cook on stovetop 2 min until edges set. 6. Transfer to oven 10–12 min until fully set. 7. Top with fresh basil and a drizzle of olive oil.",
        cookTime: "25 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["eggs", "olive oil", "Italian seasoning"],
      },
      {
        name: "Aglio e Olio",
        description: "Classic Roman pasta with garlic and olive oil — four ingredients, infinite satisfaction.",
        instructions: "1. Cook spaghetti in salted water until al dente. 2. Slice garlic thinly. Warm in olive oil over medium heat until golden. 3. Add chilli flakes. 4. Drain pasta, reserve 1 cup pasta water. 5. Toss pasta in garlic oil, adding pasta water to create a silky sauce. 6. Finish with parsley.",
        cookTime: "20 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["spaghetti", "olive oil", "garlic", "chilli flakes"],
      },
    ],
  },
  indian: {
    cuisineExtras: ["garam masala", "turmeric", "cumin", "coriander", "ghee"],
    recipes: [
      {
        name: "Quick Vegetable Sabzi",
        description: "A warmly spiced Indian dry curry — whatever vegetables you have, this technique transforms them.",
        instructions: "1. Heat oil, add mustard seeds until they pop. 2. Add onions, cook golden. 3. Add garlic, ginger, green chilli — cook 2 min. 4. Add turmeric, cumin, coriander powder. 5. Add vegetables, toss to coat in spices. 6. Cover, cook until tender. 7. Finish with garam masala and fresh coriander. 8. Serve with roti or steamed rice.",
        cookTime: "25 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["turmeric", "cumin", "garam masala", "mustard seeds"],
      },
      {
        name: "Dal Tadka",
        description: "India's most beloved comfort dish — silky lentils with a sizzling aromatic tadka poured over.",
        instructions: "1. Boil red lentils with turmeric until completely soft. 2. Heat ghee in small pan. 3. Add cumin seeds until sizzling. 4. Add sliced onion, cook golden. 5. Add garlic, tomatoes, red chilli. Cook until jammy. 6. Pour hot tadka over lentils. 7. Stir and simmer 5 min. 8. Top with fresh coriander and squeeze of lemon.",
        cookTime: "30 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["red lentils", "turmeric", "cumin", "ghee"],
      },
    ],
  },
  chinese: {
    cuisineExtras: ["soy sauce", "sesame oil", "ginger", "oyster sauce"],
    recipes: [
      {
        name: "Wok-Fried Egg Rice",
        description: "The definitive Chinese leftover transformer — smoky, savory fried rice from whatever's in the fridge.",
        instructions: "1. Beat 2 eggs, scramble in smoking hot wok. Set aside. 2. Add oil, then day-old cold rice. Press flat, let it char 1 min before tossing. 3. Add your vegetables and protein. 4. Season with soy sauce, sesame oil, white pepper. 5. Return eggs, toss everything. 6. Serve immediately — topped with sliced green onions.",
        cookTime: "15 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["soy sauce", "sesame oil", "cooked rice", "green onions"],
      },
      {
        name: "Ginger Scallion Stir-Fry",
        description: "Bright, fragrant stir-fry using the Chinese pantry classic combination of ginger and scallion.",
        instructions: "1. Mix sauce: soy sauce, oyster sauce, sesame oil, cornstarch, splash water. 2. Heat wok smoking hot. 3. Add oil, ginger slices — cook 30 seconds. 4. Add vegetables hardest first. Toss on high. 5. Add protein if using. 6. Pour sauce in. Toss to coat and glaze. 7. Finish with sliced scallions and sesame seeds.",
        cookTime: "15 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["soy sauce", "oyster sauce", "sesame oil", "ginger"],
      },
    ],
  },
  mexican: {
    cuisineExtras: ["tortillas", "lime", "cumin", "jalapeño"],
    recipes: [
      {
        name: "Crispy Quesadillas",
        description: "Golden, melted quesadillas filled with whatever you have — ready in 15 minutes flat.",
        instructions: "1. Heat dry skillet over medium-high. 2. Fill one tortilla with cheese and your fillings. 3. Fold or top with second tortilla. 4. Cook 2–3 min each side until deeply golden and cheese melts. 5. Cut into wedges. 6. Serve with salsa and sour cream.",
        cookTime: "15 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["tortillas", "cheese", "salsa"],
      },
      {
        name: "Huevos Rancheros",
        description: "Classic Mexican eggs — fried on crispy tortillas, smothered in vibrant tomato salsa.",
        instructions: "1. Make salsa: blend or cook tomatoes, onion, garlic, chilli until thickened. Season well. 2. Fry tortillas in oil until crisp. 3. Fry eggs sunny-side up. 4. Plate: tortilla, warm beans, egg, salsa. 5. Top with coriander, avocado if available, squeeze of lime.",
        cookTime: "20 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["tortillas", "eggs", "lime", "cumin"],
      },
    ],
  },
  mediterranean: {
    cuisineExtras: ["olive oil", "lemon", "feta", "oregano"],
    recipes: [
      {
        name: "Greek Horiatiki-Style Salad",
        description: "The original village salad — chunky, vivid, and dressed simply with good olive oil and oregano.",
        instructions: "1. Chop tomatoes, cucumber, and red onion into large irregular chunks. 2. Add olives if available. 3. Place a block of feta on top — don't crumble it yet. 4. Drizzle generously with olive oil. 5. Season with dried oregano, salt, black pepper. 6. Serve with crusty bread to soak up the juices.",
        cookTime: "10 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["feta cheese", "olive oil", "olives", "oregano"],
      },
      {
        name: "Shakshuka",
        description: "Eggs poached in a spiced tomato-pepper sauce — a dish that belongs equally to the entire Mediterranean.",
        instructions: "1. Sauté onion and garlic in olive oil until soft. 2. Add bell peppers, cook 3 min. 3. Add tomatoes, cumin, paprika, chilli. Simmer 10 min. 4. Create wells in the sauce. 5. Crack eggs into wells. 6. Cover and cook on low until whites set but yolks still runny. 7. Top with feta, fresh herbs, serve straight from the pan.",
        cookTime: "25 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["eggs", "olive oil", "cumin", "paprika"],
      },
    ],
  },
  default: {
    cuisineExtras: ["salt", "pepper", "olive oil", "garlic"],
    recipes: [
      {
        name: "Rustic Frittata",
        description: "A hearty egg dish that works with almost any vegetables or proteins you have on hand.",
        instructions: "1. Preheat oven to 375°F. 2. Beat 6 eggs with salt and pepper. 3. Sauté your vegetables in an oven-safe skillet for 3–4 min. 4. Pour egg mixture over. 5. Cook on stovetop 2 min until edges set. 6. Transfer to oven for 10–12 min until fully set.",
        cookTime: "20 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["eggs", "olive oil"],
      },
      {
        name: "Stir-Fry Medley",
        description: "A versatile stir-fry that transforms leftover ingredients into a satisfying, quick meal.",
        instructions: "1. Chop all ingredients into similar-sized pieces. 2. Heat oil in a wok or large pan over high heat. 3. Add harder vegetables first, cook 2–3 min. 4. Add remaining ingredients. 5. Season with soy sauce, garlic, and ginger. 6. Serve over rice or noodles.",
        cookTime: "15 minutes",
        difficulty: "Easy",
        used: [],
        missing: ["soy sauce", "garlic", "ginger"],
      },
    ],
  },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function normalizeCuisine(cuisine: string | null | undefined): string {
  if (!cuisine) return "default";
  const key = cuisine.trim().toLowerCase();
  return key in FALLBACK_DATA ? key : "default";
}

function assignUsedAndMissing(
  recipes: Recipe[],
  ingredientList: string[],
  cuisineKey: string
): Recipe[] {
  const entry = FALLBACK_DATA[cuisineKey] ?? FALLBACK_DATA.default;
  const extras = entry.cuisineExtras;

  return recipes.map((r) => {
    const used = ingredientList.filter((ing) =>
      r.instructions.toLowerCase().includes(ing) ||
      r.description.toLowerCase().includes(ing)
    );

    const missing = extras.filter(
      (extra) =>
        !ingredientList.some(
          (ing) => ing.includes(extra) || extra.includes(ing)
        )
    );

    // Calculate efficiency score
    const efficiency =
      used.length + missing.length > 0
        ? used.length / (used.length + missing.length)
        : 0.5;

    return {
      ...r,
      used: used.length > 0 ? used : ingredientList.slice(0, 3),
      missing: missing.slice(0, 4),
      efficiency: Math.min(1, Math.max(0, efficiency)),
    };
  });
}

function generateFallbackResponse(
  ingredients: string,
  cuisine: string | null | undefined,
  provider: AIProvider = AIProvider.Fallback
): RecipeSuggestion {
  const ingredientList = normalizeIngredientList(ingredients);

  const cuisineKey = normalizeCuisine(cuisine);

  // Check demo mode first
  const demoKey = getDemoKey(cuisineKey, ingredientList);
  if (demoKey && DEMO_RECIPES[demoKey]) {
    const demoRecipes = assignUsedAndMissing(
      DEMO_RECIPES[demoKey],
      ingredientList,
      cuisineKey
    );
    // Sort by efficiency
    demoRecipes.sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0));

    return {
      recipes: demoRecipes,
      sustainabilityMessage: "You reduced food waste by using available ingredients.",
      ingredientsUsed: ingredientList,
      cuisine: cuisine || null,
      isFallback: provider === AIProvider.Fallback,
      provider,
      confidence: 0.9,
    };
  }

  const entry = FALLBACK_DATA[cuisineKey] ?? FALLBACK_DATA.default;
  const recipes = assignUsedAndMissing(entry.recipes, ingredientList, cuisineKey);

  // Sort by efficiency
  recipes.sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0));

  return {
    recipes,
    sustainabilityMessage: "You reduced food waste by using available ingredients.",
    ingredientsUsed: ingredientList,
    cuisine: cuisine || null,
    isFallback: provider === AIProvider.Fallback,
    provider,
    confidence: provider === AIProvider.Fallback ? 0.6 : 0.8,
  };
}

function generateFallbackRecipes(
  ingredients: string,
  cuisine: string | null | undefined
): RecipeSuggestion {
  return generateFallbackResponse(ingredients, cuisine, AIProvider.Fallback);
}

function getDemoKey(cuisineKey: string, ingredientList: string[]): string | null {
  const has = (keyword: string) =>
    ingredientList.some((i) => i.includes(keyword));

  if (cuisineKey === "indian" && has("rice")) return "indian+rice";
  if (cuisineKey === "italian" && has("tomato")) return "italian+tomato";
  if (cuisineKey === "chinese" && (has("noodle") || has("pasta"))) return "chinese+noodles";
  return null;
}

// ─── RECIPE GENERATION PIPELINE ─────────────────────────────────────────────

/**
 * Parses AI response into Recipe format
 * Handles various formats of AI output
 */
function parseAIRecipeResponse(
  text: string,
  ingredientList: string[],
  cuisine: string | null | undefined
): Recipe[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const recipes: Recipe[] = [];

  let currentRecipe: Partial<Recipe> | null = null;

  for (const line of lines) {
    // Recipe name line
    if (/^recipe\s*\d+\s*:/i.test(line) || (/^(name|title)\s*:/i.test(line) && !currentRecipe?.name)) {
      if (currentRecipe?.name) {
        recipes.push({
          name: currentRecipe.name || "Recipe",
          description: currentRecipe.description || "",
          instructions: currentRecipe.instructions || "",
          cookTime: currentRecipe.cookTime || "30 minutes",
          difficulty: currentRecipe.difficulty || "Medium",
          used: currentRecipe.used || [],
          missing: currentRecipe.missing || [],
        });
      }

      const name = line
        .replace(/^(recipe\s*\d+\s*:|name\s*:|title\s*:)/i, "")
        .trim();

      currentRecipe = {
        name: name || `AI Recipe ${recipes.length + 1}`,
        used: [],
        missing: [],
      };
    } else if (/ingredients?\s+used\s*:/i.test(line)) {
      const list = line
        .replace(/^.*?:\s*/i, "")
        .split(/,|;/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 60);
      if (currentRecipe) currentRecipe.used = list;
    } else if (/missing\s+ingredients?\s*:/i.test(line)) {
      const list = line
        .replace(/^.*?:\s*/i, "")
        .split(/,|;/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 60);
      if (currentRecipe) currentRecipe.missing = list;
    } else if (/instructions?\s*:/i.test(line)) {
      const instructions = line.replace(/^.*?:\s*/i, "").trim();
      if (currentRecipe) currentRecipe.instructions = instructions;
    } else if (/cook\s*time\s*:/i.test(line)) {
      const time = line.replace(/^.*?:\s*/i, "").trim();
      if (currentRecipe) currentRecipe.cookTime = time;
    } else if (/difficulty\s*:/i.test(line)) {
      const diff = line.replace(/^.*?:\s*/i, "").trim();
      if (currentRecipe) currentRecipe.difficulty = diff;
    } else if (/description\s*:/i.test(line)) {
      const desc = line.replace(/^.*?:\s*/i, "").trim();
      if (currentRecipe) currentRecipe.description = desc;
    } else if (
      currentRecipe &&
      !currentRecipe.instructions &&
      line.length > 10 &&
      !line.match(/^[a-z]+\s*:/i)
    ) {
      // Assume remaining text is instructions
      currentRecipe.instructions = line;
    }
  }

  // Push last recipe
  if (currentRecipe?.name) {
    recipes.push({
      name: currentRecipe.name,
      description: currentRecipe.description || "",
      instructions: currentRecipe.instructions || "",
      cookTime: currentRecipe.cookTime || "30 minutes",
      difficulty: currentRecipe.difficulty || "Medium",
      used: currentRecipe.used || [],
      missing: currentRecipe.missing || [],
    });
  }

  const limited = recipes.length > 0 ? recipes.slice(0, 2) : [];
  return withEfficiency(limited, ingredientList, cuisine);
}

/**
 * Generate recipes using OpenAI GPT (PRIMARY)
 */
async function generateWithOpenAIGPT(
  ingredients: string,
  cuisine: string | null | undefined,
  requestId?: string
): Promise<{
  recipes: Recipe[];
  confidence: number;
} | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  try {
    const ingredientList = normalizeIngredientList(ingredients);

    const prompt = cuisine
      ? `You are a professional chef. Available ingredients: ${ingredients}. Cuisine: ${cuisine}. Generate exactly 2 realistic recipes using available ingredients first and list optional missing ingredients.`
      : `You are a professional chef. Available ingredients: ${ingredients}. Generate exactly 2 realistic recipes using available ingredients first and list optional missing ingredients.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: "gpt-4o",
        max_completion_tokens: 1024,
        messages: [
          {
            role: "system",
            content:
              "Return valid JSON only. Follow the schema strictly. Do not include markdown.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "recipe_suggestion",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                recipes: {
                  type: "array",
                  minItems: 1,
                  maxItems: 2,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      description: { type: "string" },
                      instructions: { type: "string" },
                      cookTime: { type: "string" },
                      difficulty: { type: "string" },
                      used: {
                        type: "array",
                        items: { type: "string" },
                      },
                      missing: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                    required: [
                      "name",
                      "description",
                      "instructions",
                      "cookTime",
                      "difficulty",
                      "used",
                      "missing",
                    ],
                  },
                },
              },
              required: ["recipes"],
            },
          },
        },
      }),
      timeoutAfter(4000),
    ]);

    const rawJson = response.choices[0]?.message?.content?.trim() ?? "";
    if (!rawJson) return null;

    const parsedJson = JSON.parse(rawJson) as unknown;
    const parsed = OpenAIRecipeSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.warn(
        { requestId, provider: "openai", issues: parsed.error.issues },
        "OpenAI structured response failed Zod validation"
      );
      return null;
    }

    const recipes = withEfficiency(parsed.data.recipes, ingredientList, cuisine);
    if (recipes.length === 0) return null;

    logger.info(
      { requestId, provider: "openai", recipeCount: recipes.length },
      "OpenAI GPT generated recipes"
    );

    return { recipes, confidence: 0.95 };
  } catch (err) {
    logger.warn(
      { requestId, provider: "openai", error: String(err) },
      "OpenAI recipe generation failed"
    );
    return null;
  }
}

/**
 * Generate recipes using HuggingFace flan-t5 (FALLBACK)
 */
async function generateWithHuggingFace(
  ingredients: string,
  cuisine: string | null | undefined,
  requestId?: string
): Promise<{
  recipes: Recipe[];
  confidence: number;
} | null> {
  if (!config.huggingfaceApiKey) return null;

  try {
    const ingredientList = ingredients
      .split(",")
      .map((i) => i.trim().toLowerCase())
      .filter(Boolean);

    const prompt = cuisine
      ? `Generate 2 ${cuisine} recipes using: ${ingredients}`
      : `Generate 2 recipes using: ${ingredients}`;

    const response = await Promise.race([
      fetch(
        "https://api-inference.huggingface.co/models/google/flan-t5-large",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.huggingfaceApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: { max_new_tokens: 512, temperature: 0.7 },
          }),
        }
      ),
      timeoutAfter(4000),
    ]);

    if (!response.ok) return null;

    const data = (await response.json()) as
      | Array<{ generated_text: string }>
      | { generated_text: string };

    const text = Array.isArray(data)
      ? data[0]?.generated_text ?? ""
      : data.generated_text ?? "";

    if (!text) return null;

    const recipes = parseAIRecipeResponse(text, ingredientList, cuisine);
    if (recipes.length === 0) return null;

    logger.info(
      { requestId, provider: "huggingface", recipeCount: recipes.length },
      "HuggingFace generated recipes"
    );

    return { recipes, confidence: 0.75 };
  } catch (err) {
    logger.warn(
      { requestId, provider: "huggingface", error: String(err) },
      "HuggingFace recipe generation failed"
    );
    return null;
  }
}

/**
 * Generate recipes - FULL PIPELINE
 * OpenAI GPT → HuggingFace → Internal Fallback
 */
export async function generateRecipes(
  ingredients: string,
  cuisine: string | null | undefined,
  requestId?: string
): Promise<RecipeSuggestion> {
  const ingredientList = normalizeIngredientList(ingredients);
  const cacheKey = buildRecipeCacheKey(ingredientList, cuisine);

  const cached = getCachedRecipeSuggestion(cacheKey);
  if (cached) {
    logger.info(
      {
        requestId,
        cacheHit: true,
        providerUsed: cached.provider,
        fallbackUsed: cached.isFallback,
        circuitOpen: isAICircuitOpen(),
      },
      "Recipe suggestion served from cache"
    );
    return cached;
  }

  if (isAICircuitOpen()) {
    const fallback = generateFallbackResponse(ingredients, cuisine, AIProvider.Fallback);
    setCachedRecipeSuggestion(cacheKey, fallback);
    logger.warn(
      {
        requestId,
        cacheHit: false,
        providerUsed: AIProvider.Fallback,
        fallbackUsed: true,
        circuitOpen: true,
        consecutiveAIFailures,
      },
      "AI circuit breaker open; skipping providers and using fallback"
    );
    return { ...fallback, cacheHit: false };
  }

  let aiAttempted = false;

  // 1. Try OpenAI GPT (primary)
  if (config.hasOpenAI) {
    aiAttempted = true;
    const result = await generateWithOpenAIGPT(ingredients, cuisine, requestId);
    if (result && result.recipes.length > 0) {
      const suggestion: RecipeSuggestion = {
        recipes: result.recipes,
        sustainabilityMessage: "You reduced food waste by using available ingredients.",
        ingredientsUsed: ingredientList,
        cuisine: cuisine || null,
        isFallback: false,
        provider: AIProvider.OpenAI,
        confidence: result.confidence,
        cacheHit: false,
      };
      recordAISuccess();
      setCachedRecipeSuggestion(cacheKey, suggestion);
      logger.info(
        {
          requestId,
          cacheHit: false,
          providerUsed: AIProvider.OpenAI,
          fallbackUsed: false,
          circuitOpen: false,
        },
        "Recipe suggestion generated by OpenAI"
      );
      return suggestion;
    }
  }

  // 2. Try HuggingFace (fallback)
  if (config.hasHuggingFace) {
    aiAttempted = true;
    const result = await generateWithHuggingFace(ingredients, cuisine, requestId);
    if (result && result.recipes.length > 0) {
      const suggestion: RecipeSuggestion = {
        recipes: result.recipes,
        sustainabilityMessage: "You reduced food waste by using available ingredients.",
        ingredientsUsed: ingredientList,
        cuisine: cuisine || null,
        isFallback: false,
        provider: AIProvider.HuggingFace,
        confidence: result.confidence,
        cacheHit: false,
      };
      recordAISuccess();
      setCachedRecipeSuggestion(cacheKey, suggestion);
      logger.info(
        {
          requestId,
          cacheHit: false,
          providerUsed: AIProvider.HuggingFace,
          fallbackUsed: false,
          circuitOpen: false,
        },
        "Recipe suggestion generated by HuggingFace"
      );
      return suggestion;
    }
  }

  if (aiAttempted) {
    recordAIFailure();
  }

  // 3. Return internal fallback
  const fallback = generateFallbackResponse(ingredients, cuisine, AIProvider.Fallback);
  setCachedRecipeSuggestion(cacheKey, fallback);
  logger.warn(
    {
      requestId,
      cacheHit: false,
      providerUsed: AIProvider.Fallback,
      fallbackUsed: true,
      circuitOpen: isAICircuitOpen(),
      consecutiveAIFailures,
    },
    "Falling back to internal recipe database"
  );
  return { ...fallback, cacheHit: false };
}

const VISION_SYSTEM_PROMPT = `You are a food ingredient detection assistant.
The user will share a photo of their fridge, pantry shelf, kitchen counter, or grocery haul.
Your task: identify ONLY the actual food ingredients, produce, packaged foods, condiments, beverages, and cooking staples that are clearly visible in the image.

Rules:
- List only what you can actually see — do not invent or guess items not visible.
- Use simple, common names (e.g. "eggs" not "large free-range eggs", "milk" not "whole milk carton").
- Exclude non-food items (containers, appliances, shelves, utensils).
- If an item is partially visible but recognisable, include it.
- Return ONLY a plain comma-separated list of ingredient names. No numbering, no sentences, no explanations.

Example output format:
eggs, milk, cheddar cheese, spinach, tomatoes, garlic, butter, leftover rice`;

interface HFImageClassificationResponse {
  label: string;
  score: number;
}

interface HFImageClassificationOutcome {
  [key: string]: unknown;
}

// OpenAI Vision detection - PRIMARY
async function detectWithOpenAIVision(
  imageBase64: string,
  requestId?: string
): Promise<{
  ingredients: string[];
  confidence: number;
  raw: string;
} | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  try {
    const base64Data = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const mimeMatch = imageBase64.match(/^data:(image\/[a-z]+);base64,/);
    const mimeType = (mimeMatch?.[1] ?? "image/jpeg") as
      | "image/jpeg"
      | "image/png"
      | "image/gif"
      | "image/webp";

    const response = await Promise.race([
      client.chat.completions.create({
        model: "gpt-4o",
        max_completion_tokens: 256,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64Data}`,
                  detail: "high",
                },
              },
              {
                type: "text",
                text: "List all food ingredients you can see in this image.",
              },
            ],
          },
        ],
      }),
      timeoutAfter(4000),
    ]);

    const rawText = response.choices[0]?.message?.content?.trim() ?? "";
    if (!rawText) return null;

    const ingredients = parseIngredientsFromText(rawText);
    if (ingredients.length === 0) return null;

    logger.info(
      { requestId, provider: "openai", count: ingredients.length },
      "OpenAI Vision detected ingredients"
    );

    return { ingredients, confidence: 0.95, raw: rawText };
  } catch (err) {
    logger.warn(
      { requestId, provider: "openai", error: String(err) },
      "OpenAI Vision detection failed"
    );
    return null;
  }
}

// HuggingFace image classification - FALLBACK
async function detectWithHuggingFace(
  imageBase64: string,
  requestId?: string
): Promise<{
  ingredients: string[];
  confidence: number;
} | null> {
  if (!config.huggingfaceApiKey) return null;

  try {
    // Use HF image classification model
    const base64Data = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const response = await Promise.race([
      fetch(
        "https://api-inference.huggingface.co/models/google/vit-base-patch16-224",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.huggingfaceApiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: Buffer.from(base64Data, "base64"),
        }
      ),
      timeoutAfter(4000),
    ]);

    if (!response.ok) return null;

    const data = (await response.json()) as Array<HFImageClassificationResponse>;
    if (!Array.isArray(data)) return null;

    // Map image labels to ingredient names (heuristic)
    const ingredients = data
      .slice(0, 10)
      .filter((item) => item.score > 0.3)
      .map((item) => {
        const label = item.label.toLowerCase();
        // Very basic label → ingredient mapping
        if (label.includes("food")) return null;
        if (label.includes("or")) return null; // "or" categories
        return label.split(",")[0]?.trim();
      })
      .filter((s): s is string => !!s && s.length > 1 && s.length < 50)
      .slice(0, 8);

    if (ingredients.length === 0) return null;

    const avgConfidence = data.slice(0, 10).reduce((sum, d) => sum + d.score, 0) / Math.min(data.length, 10);

    logger.info(
      { requestId, provider: "huggingface", count: ingredients.length, confidence: avgConfidence },
      "HuggingFace detected ingredients"
    );

    return { ingredients, confidence: Math.min(0.7, avgConfidence) };
  } catch (err) {
    logger.warn(
      { requestId, provider: "huggingface", error: String(err) },
      "HuggingFace image detection failed"
    );
    return null;
  }
}

// Parse comma-separated ingredient text
function parseIngredientsFromText(text: string): string[] {
  return text
    .split(/,|;|\n/)
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^[-•*\d.]+\s*/, "")
        .replace(/[^a-z0-9 ()/'-]/g, "")
        .trim()
    )
    .filter((s) => s.length > 1 && s.length < 50)
    .slice(0, 20);
}

// Detect ingredients - FULL PIPELINE
export async function detectIngredientsFromImage(
  imageBase64: string,
  requestId?: string
): Promise<IngredientDetectionResult> {
  // 1. Try OpenAI Vision (primary)
  if (config.hasOpenAI) {
    const result = await detectWithOpenAIVision(imageBase64, requestId);
    if (result && result.ingredients.length > 0) {
      return {
        ingredients: result.ingredients,
        confidence: result.confidence,
        isApproximate: false,
        provider: AIProvider.OpenAI,
      };
    }
  }

  // 2. Try HuggingFace (fallback)
  if (config.hasHuggingFace) {
    const result = await detectWithHuggingFace(imageBase64, requestId);
    if (result && result.ingredients.length > 0) {
      return {
        ingredients: result.ingredients,
        confidence: result.confidence,
        isApproximate: false,
        provider: AIProvider.HuggingFace,
      };
    }
  }

  // 3. Return reliable fallback
  logger.warn(
    { requestId, reason: "all_providers_failed" },
    "Using hardcoded fallback ingredients"
  );
  return {
    ingredients: ["tomato", "onion", "garlic", "olive oil", "salt", "pepper"],
    confidence: 0.5,
    isApproximate: true,
    provider: AIProvider.Fallback,
  };
}

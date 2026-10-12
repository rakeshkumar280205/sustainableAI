import { z } from "zod";
import { logger } from "./logger.js";
import config from "../config.js";
import {
  analyzeWithOllama,
  generateWithHuggingFace as generateWithHuggingFaceProvider,
  generateWithOllama,
  generateWithOpenRouter,
} from "./providerAdapters.js";

// ─── TYPES ───────────────────────────────────────────────────────────────────

export enum AIProvider {
  OpenRouter = "openrouter",
  Ollama = "ollama",
  Gemini = "gemini",
  HuggingFace = "huggingface",
  Fallback = "fallback",
}

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_TIMEOUT_MS = readPositiveMs(process.env.GEMINI_TIMEOUT_MS, 20000);
const GEMINI_MAX_RETRIES = 2;
const HUGGINGFACE_RECIPE_TIMEOUT_MS = readPositiveMs(process.env.HUGGINGFACE_RECIPE_TIMEOUT_MS, 15000);
const CACHE_AI_RESPONSES = process.env.CACHE_AI_RESPONSES === "true";
const HUGGINGFACE_API_BASE_URL = process.env.HUGGINGFACE_API_BASE_URL || "https://router.huggingface.co/hf-inference/models";

const HUGGINGFACE_RECIPE_MODELS = readCsvEnv(
  process.env.HUGGINGFACE_RECIPE_MODELS,
  ["mistralai/Mistral-7B-Instruct-v0.2", "Qwen/Qwen2.5-7B-Instruct"]
);

// ─── TIMEOUT HELPER ──────────────────────────────────────────────────────────

function timeoutAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`AI request timed out after ${milliseconds}ms`)),
      milliseconds
    );
  });
}

function readPositiveMs(envValue: string | undefined, fallbackMs: number): number {
  const parsed = Number(envValue);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackMs;
}

function readCsvEnv(envValue: string | undefined, fallback: string[]): string[] {
  if (!envValue?.trim()) return fallback;
  const values = envValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

const HUGGINGFACE_IMAGE_TIMEOUT_MS = readPositiveMs(process.env.HUGGINGFACE_IMAGE_TIMEOUT_MS, 15000);
const HUGGINGFACE_IMAGE_MODEL = process.env.HUGGINGFACE_IMAGE_MODEL || "Salesforce/blip-image-captioning-base";
const HUGGINGFACE_IMAGE_API_URL = `${HUGGINGFACE_API_BASE_URL}/${HUGGINGFACE_IMAGE_MODEL}`;

function getHuggingFaceModelUrl(modelName: string): string {
  return `${HUGGINGFACE_API_BASE_URL}/${modelName}`;
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
  low_confidence?: boolean;
}

export interface IngredientDetectionResult {
  ingredients: string[];
  confidence: number; // 0-1
  isApproximate: boolean;
  provider: AIProvider;
  low_confidence?: boolean;
}

type HostedTextProvider = (request: {
  prompt: string;
  requestId?: string;
}) => Promise<string | null>;

let totalRecipeRequests = 0;
let totalRecipeFallbacks = 0;

function getFallbackUsageRate(): number {
  if (totalRecipeRequests === 0) return 0;
  return totalRecipeFallbacks / totalRecipeRequests;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GEMINI_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function getGeminiRetryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(5_000, seconds * 1_000);
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(5_000, Math.max(0, retryAt - Date.now()));
    }
  }

  const exponentialDelay = 250 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(5_000, exponentialDelay + jitter);
}

function classifyGeminiError(status: number): string {
  if (status === 400) return "invalid_request";
  if (status === 401) return "authentication";
  if (status === 403) return "permission_or_quota";
  if (status === 404) return "model_or_endpoint_not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_or_quota_limit";
  if (status >= 500) return "service_unavailable";
  return "provider_error";
}

function summarizeGeminiError(body: string, status: number): {
  classification: string;
  errorCode?: string;
  providerStatus?: string;
} {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        code?: number | string;
        status?: string;
      };
    };
    const code = parsed.error?.code;
    return {
      classification: classifyGeminiError(status),
      ...(code !== undefined ? { errorCode: String(code) } : {}),
      ...(parsed.error?.status ? { providerStatus: parsed.error.status } : {}),
    };
  } catch {
    return { classification: classifyGeminiError(status) };
  }
}

async function fetchGeminiRequest(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function computeCoveragePercent(used: string[], ingredientList: string[]): number {
  if (!ingredientList.length) return 0;
  const usedSet = new Set(used.map((item) => item.trim().toLowerCase()));
  const matchCount = ingredientList.filter((item) => usedSet.has(item)).length;
  return (matchCount / ingredientList.length) * 100;
}

function computeWasteReductionScore(coveragePercent: number, missingCount: number, stepCount: number): number {
  const missingPenalty = missingCount * 10;
  const complexityPenalty = Math.max(0, stepCount - 6) * 3;
  const score = coveragePercent - missingPenalty - complexityPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function inferCookTimeFromSteps(stepCount: number): string {
  const minutes = Math.max(10, Math.min(90, 8 + stepCount * 6));
  return `${minutes} minutes`;
}

function inferDifficulty(stepCount: number, missingCount: number): string {
  const complexity = stepCount + missingCount;
  if (complexity <= 6) return "easy";
  if (complexity <= 12) return "medium";
  return "hard";
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
  const aliasMap: Record<string, string> = {
    "spring onions": "green onion",
    "scallions": "green onion",
    "chilli": "chili",
    "bell pepper": "capsicum",
  };

  const seen = new Set<string>();
  return input
    .split(",")
    .map((i) => i.trim().toLowerCase())
    .map((item) => aliasMap[item] ?? item)
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

  if (!entry.value.isFallback && !CACHE_AI_RESPONSES) {
    return null;
  }

  const cloned = cloneRecipeSuggestion(entry.value);
  cloned.cacheHit = true;
  cloned.low_confidence = cloned.isFallback;
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

const GeminiRecipeSchema = z.object({
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

const GeminiRecipeStrictSchema = z.object({
  recipes: z
    .array(
      z.object({
        name: z.string().min(1),
        used_ingredients: z.array(z.string()).default([]),
        missing_ingredients: z.array(z.string()).default([]),
        steps: z.array(z.string()).min(1),
        cook_time_minutes: z.number().int().min(5).max(240),
        difficulty: z.enum(["easy", "medium", "hard"]),
        waste_reduction_score: z.number().min(0).max(100),
      })
    )
    .min(1)
    .max(2),
});

const GeminiIngredientsStrictSchema = z.object({
  ingredients: z.array(z.string()).min(1),
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
      low_confidence: provider === AIProvider.Fallback,
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
    low_confidence: provider === AIProvider.Fallback,
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
        const instructionText = currentRecipe.instructions || "";
        const stepCount = instructionText.split(/\n|\.|;/).map((s) => s.trim()).filter(Boolean).length;
        const missingCount = (currentRecipe.missing || []).length;
        recipes.push({
          name: currentRecipe.name || "Recipe",
          description: currentRecipe.description || "",
          instructions: instructionText,
          cookTime: currentRecipe.cookTime || inferCookTimeFromSteps(stepCount),
          difficulty: (currentRecipe.difficulty || inferDifficulty(stepCount, missingCount)).toLowerCase(),
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
    const instructionText = currentRecipe.instructions || "";
    const stepCount = instructionText.split(/\n|\.|;/).map((s) => s.trim()).filter(Boolean).length;
    const missingCount = (currentRecipe.missing || []).length;
    recipes.push({
      name: currentRecipe.name,
      description: currentRecipe.description || "",
      instructions: instructionText,
      cookTime: currentRecipe.cookTime || inferCookTimeFromSteps(stepCount),
      difficulty: (currentRecipe.difficulty || inferDifficulty(stepCount, missingCount)).toLowerCase(),
      used: currentRecipe.used || [],
      missing: currentRecipe.missing || [],
    });
  }

  const limited = recipes.length > 0 ? recipes.slice(0, 2) : [];
  return withEfficiency(limited, ingredientList, cuisine);
}

function safeJsonParse(text: string): unknown {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

export async function generateWithGemini(prompt: string, requestId?: string): Promise<string | null> {
  if (!config.geminiApiKey) {
    logger.warn({ requestId, provider: "gemini" }, "Gemini API key unavailable");
    return null;
  }

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
    try {
      logger.info(
        {
          requestId,
          provider: "gemini",
          model: GEMINI_MODEL,
          attempt,
          timeoutMs: GEMINI_TIMEOUT_MS,
        },
        "Calling Gemini chat completions"
      );

      const response = await Promise.race([
        fetchGeminiRequest(GEMINI_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.geminiApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3000",
            "X-Gemini-Title": "ZeroPlate Chef",
          },
          body: JSON.stringify({
            model: GEMINI_MODEL,
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
            temperature: 0.7,
            max_tokens: 800,
          }),
        }),
        timeoutAfter(GEMINI_TIMEOUT_MS),
      ]);

      if (!response.ok) {
        const body = await response.text();
        logger.warn(
          {
            requestId,
            provider: "gemini",
            model: GEMINI_MODEL,
            attempt,
            status: response.status,
            responseBodyPresent: body.length > 0,
            ...summarizeGeminiError(body, response.status),
          },
          "Gemini request returned non-OK response"
        );

        if (GEMINI_RETRYABLE_STATUSES.has(response.status) && attempt < GEMINI_MAX_RETRIES) {
          await delay(getGeminiRetryDelay(response, attempt));
          continue;
        }
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!content) {
        logger.warn(
          {
            requestId,
            provider: "gemini",
            model: GEMINI_MODEL,
            attempt,
            reason: "empty_content",
          },
          "Gemini response content was empty"
        );
        if (attempt < GEMINI_MAX_RETRIES) {
          await delay(250 * Math.pow(2, attempt));
        }
        continue;
      }

      return content;
    } catch (err) {
      const isLastAttempt = attempt >= GEMINI_MAX_RETRIES;
      logger.warn(
        {
          requestId,
          provider: "gemini",
          model: GEMINI_MODEL,
          attempt,
          retrying: !isLastAttempt,
          errorType: err instanceof Error ? err.name : "UnknownError",
        },
        "Gemini request attempt failed"
      );

      if (!isLastAttempt) {
        await delay(250 * Math.pow(2, attempt));
      }
    }
  }

  return null;
}

export async function testGeminiConnection(requestId?: string): Promise<{
  working: boolean;
  model: string;
  error?: string;
}> {
  const modelName = GEMINI_MODEL;

  if (!config.geminiApiKey) {
    const error = "GEMINI_API_KEY missing in environment";
    logger.warn({ requestId, provider: "gemini", model: modelName, error }, "Gemini health check failed before request");
    return { working: false, model: modelName, error };
  }

  const raw = await generateWithGemini("Say hello", requestId);
  if (!raw) {
    const error = "Gemini returned empty or failed response";
    return { working: false, model: modelName, error };
  }

  logger.info(
    { requestId, provider: "gemini", model: modelName, responseReceived: true },
    "Gemini connectivity test succeeded"
  );

  return { working: true, model: modelName };
}

export async function testHuggingFaceConnection(requestId?: string): Promise<{
  working: boolean;
  model?: string;
  error?: string;
}> {
  if (!config.hfFreeOnlyEnabled) {
    const error = "HF_FREE_ONLY_ENABLED is false";
    logger.info({ requestId, provider: "huggingface" }, "HuggingFace health check skipped");
    return { working: false, error };
  }

  if (!config.huggingfaceApiKey) {
    const error = "HUGGINGFACE_API_KEY missing in environment";
    logger.warn({ requestId, provider: "huggingface", error }, "HuggingFace health check failed before request");
    return { working: false, error };
  }

  let lastError = "unknown HuggingFace error";

  for (const modelName of HUGGINGFACE_RECIPE_MODELS) {
    const endpoint = getHuggingFaceModelUrl(modelName);
    try {
      const response = await Promise.race([
        fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.huggingfaceApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            inputs: "Say hello",
            parameters: {
              max_new_tokens: 700,
              temperature: 0.7,
              return_full_text: false,
            },
          }),
        }),
        timeoutAfter(HUGGINGFACE_RECIPE_TIMEOUT_MS),
      ]);

      if (!response.ok) {
        const body = await response.text();
        lastError = `status=${response.status}`;
        logger.warn(
          {
            requestId,
            provider: "huggingface",
            model: modelName,
            status: response.status,
            responseBodyPresent: body.length > 0,
          },
          "HuggingFace connectivity test returned non-OK response"
        );
        continue;
      }

      logger.info(
        { requestId, provider: "huggingface", model: modelName, status: response.status },
        "HuggingFace connectivity test succeeded"
      );
      return { working: true, model: modelName };
    } catch (err) {
      const errorMessage = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ""}` : String(err);
      lastError = errorMessage;
      logger.warn(
        { requestId, provider: "huggingface", model: modelName, error: errorMessage },
        "HuggingFace connectivity test failed"
      );
    }
  }

  return { working: false, error: lastError };
}

async function generateWithGeminiRecipes(
  ingredients: string,
  cuisine: string | null | undefined,
  requestId?: string
): Promise<{
  recipes: Recipe[];
  confidence: number;
} | null> {
  if (!config.geminiApiKey) {
    logger.warn({ requestId, provider: "gemini" }, "Gemini API key unavailable for recipe generation");
    return null;
  }

  try {
    const ingredientList = normalizeIngredientList(ingredients);
    const prompt = `You are a professional chef focused on sustainability and minimizing food waste.

Given ingredients: ${ingredientList.join(", ")}

Cuisine: ${cuisine ?? "any"}

Generate exactly 2 recipes.

Rules:
- Use at least 70% of provided ingredients
- Maximum 3 additional ingredients allowed
- Prefer common pantry items
- Avoid unnecessary ingredients
- Recipes must be realistic and cookable
- Output ONLY JSON
- No explanation text

Format:
{
  "recipes": [
    {
      "name": "...",
      "used_ingredients": [],
      "missing_ingredients": [],
      "steps": [],
      "cook_time_minutes": 0,
      "difficulty": "easy|medium|hard",
      "waste_reduction_score": 0
    }
  ]
}`;

    for (let schemaAttempt = 0; schemaAttempt <= 1; schemaAttempt += 1) {
      const text = await generateWithGemini(prompt, requestId);
      if (!text) {
        return null;
      }

      const parsed = safeJsonParse(text);
      logger.info(
        { requestId, provider: "gemini", model: GEMINI_MODEL, schemaAttempt, responseReceived: true, parsed: !!parsed },
        "Gemini recipe output received"
      );

      const strictParsed = GeminiRecipeStrictSchema.safeParse(parsed);
      if (!strictParsed.success) {
        logger.warn(
          {
            requestId,
            provider: "gemini",
            model: GEMINI_MODEL,
            schemaAttempt,
            reason: "invalid_json_structure",
          },
          "Gemini recipe response failed schema validation"
        );
        continue;
      }

      const mappedRecipes: Recipe[] = strictParsed.data.recipes.map((recipe) => ({
        name: recipe.name,
        description: recipe.steps[0] ?? "",
        instructions: recipe.steps.join("\n"),
        cookTime: `${recipe.cook_time_minutes} minutes`,
        difficulty: recipe.difficulty,
        used: recipe.used_ingredients,
        missing: recipe.missing_ingredients,
        efficiency: Math.max(recipe.waste_reduction_score, 0) / 100,
      }));

      const recipesWithScoring = mappedRecipes.map((recipe) => {
        const stepCount = recipe.instructions.split("\n").filter(Boolean).length;
        const coveragePercent = computeCoveragePercent(recipe.used, ingredientList);
        const computedScore = computeWasteReductionScore(coveragePercent, recipe.missing.length, stepCount);
        return {
          ...recipe,
          efficiency: computedScore / 100,
        };
      });

      const recipes = withEfficiency(recipesWithScoring, ingredientList, cuisine);
      if (recipes.length === 0) {
        continue;
      }

      const hasLowCoverage = recipes.some(
        (recipe) => computeCoveragePercent(recipe.used, ingredientList) < 40
      );
      if (hasLowCoverage) {
        logger.warn(
          { requestId, provider: "gemini", model: GEMINI_MODEL, reason: "coverage_below_threshold" },
          "Gemini recipe coverage below threshold"
        );
        continue;
      }

      logger.info(
        {
          requestId,
          providerUsed: "gemini",
          model: GEMINI_MODEL,
          recipeCount: recipes.length,
          ingredientCoveragePct: Math.round(
            recipes.reduce((acc, recipe) => acc + computeCoveragePercent(recipe.used, ingredientList), 0) /
            recipes.length
          ),
        },
        "Gemini generated recipes"
      );

      return { recipes, confidence: 0.95 };
    }

    return null;
  } catch (err) {
    logger.warn(
      { requestId, provider: "gemini", errorType: err instanceof Error ? err.name : "UnknownError" },
      "Gemini recipe generation failed"
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
    logger.info(
      {
        requestId,
        provider: "huggingface",
        timeoutMs: HUGGINGFACE_RECIPE_TIMEOUT_MS,
        models: HUGGINGFACE_RECIPE_MODELS,
      },
      "Entering HuggingFace Recipes"
    );

    const ingredientList = ingredients
      .split(",")
      .map((i) => i.trim().toLowerCase())
      .filter(Boolean);

    const prompt = `You are a professional chef focused on sustainability and minimizing food waste.

Ingredients: ${ingredientList.join(", ")}
Cuisine: ${cuisine ?? "any"}

Rules:
- Use at least 70% of provided ingredients
- Maximum 3 additional ingredients allowed
- Prefer common pantry items
- Avoid unnecessary ingredients
- Recipes must be realistic and cookable
- Return ONLY JSON

Output format:
{
  "recipes": [
    {
      "name": "",
      "used_ingredients": [],
      "missing_ingredients": [],
      "steps": [],
      "cook_time_minutes": 0,
      "difficulty": "easy|medium|hard",
      "waste_reduction_score": 0
    }
  ]
}`;

    for (const modelName of HUGGINGFACE_RECIPE_MODELS) {
      const response = await Promise.race([
        fetch(
          getHuggingFaceModelUrl(modelName),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.huggingfaceApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              inputs: prompt,
              parameters: {
                max_new_tokens: 700,
                temperature: 0.7,
                return_full_text: false,
              },
            }),
          }
        ),
        timeoutAfter(HUGGINGFACE_RECIPE_TIMEOUT_MS),
      ]);

      if (!response.ok) {
        const errorBody = await response.text();
        logger.warn(
          {
            requestId,
            provider: "huggingface",
            model: modelName,
            status: response.status,
            statusText: response.statusText,
            responseBodyPresent: errorBody.length > 0,
          },
          "HuggingFace recipe API returned non-OK response"
        );
        continue;
      }

      const data = (await response.json()) as
        | Array<{ generated_text: string }>
        | { generated_text: string };

      const text = Array.isArray(data)
        ? data[0]?.generated_text ?? ""
        : data.generated_text ?? "";

      if (!text) {
        logger.warn(
          { requestId, provider: "huggingface", model: modelName },
          "HuggingFace recipe API returned empty text"
        );
        continue;
      }

      const parsed = safeJsonParse(text);
      const strictParsed = GeminiRecipeStrictSchema.safeParse(parsed);
      if (!strictParsed.success) {
        logger.warn(
          {
            requestId,
            provider: "huggingface",
            model: modelName,
            reason: "invalid_json_structure",
            responseReceived: true,
          },
          "HuggingFace recipe response failed validation"
        );
        continue;
      }

      const recipes = withEfficiency(
        strictParsed.data.recipes.map((recipe) => ({
          name: recipe.name,
          description: recipe.steps[0] ?? "",
          instructions: recipe.steps.join("\n"),
          cookTime: `${recipe.cook_time_minutes} minutes`,
          difficulty: recipe.difficulty,
          used: recipe.used_ingredients,
          missing: recipe.missing_ingredients,
          efficiency: computeWasteReductionScore(
            computeCoveragePercent(recipe.used_ingredients, ingredientList),
            recipe.missing_ingredients.length,
            recipe.steps.length
          ) / 100,
        })),
        ingredientList,
        cuisine
      );

      if (recipes.length === 0) continue;

      const hasLowCoverage = recipes.some((recipe) => computeCoveragePercent(recipe.used, ingredientList) < 40);
      if (hasLowCoverage) {
        logger.warn(
          { requestId, provider: "huggingface", model: modelName, reason: "coverage_below_threshold" },
          "HuggingFace recipe coverage below threshold"
        );
        continue;
      }

      logger.info(
        { requestId, provider: "huggingface", model: modelName, recipeCount: recipes.length },
        "HuggingFace generated recipes"
      );

      return { recipes, confidence: 0.75 };
    }

    return null;
  } catch (err) {
    logger.warn(
      { requestId, provider: "huggingface", errorType: err instanceof Error ? err.name : "UnknownError" },
      "HuggingFace recipe generation failed"
    );
    return null;
  }
}

async function generateRecipesWithProvider(
  provider: AIProvider,
  generateText: HostedTextProvider,
  ingredients: string,
  cuisine: string | null | undefined,
  requestId?: string,
): Promise<{ recipes: Recipe[]; confidence: number } | null> {
  const ingredientList = normalizeIngredientList(ingredients);
  const prompt = `You are a professional chef focused on sustainability and minimizing food waste.

Given ingredients: ${ingredientList.join(", ")}
Cuisine: ${cuisine ?? "any"}

Generate exactly 2 realistic recipes. Use at least 70% of the provided ingredients and no more than 3 additional ingredients.
Return ONLY JSON in this format:
{"recipes":[{"name":"","used_ingredients":[],"missing_ingredients":[],"steps":[],"cook_time_minutes":0,"difficulty":"easy|medium|hard","waste_reduction_score":0}]}`;

  const text = await generateText({ prompt, requestId });
  if (!text) return null;
  const parsed = GeminiRecipeStrictSchema.safeParse(safeJsonParse(text));
  if (!parsed.success) {
    logger.warn(
      { requestId, provider, reason: "invalid_json_structure" },
      "Provider recipe response failed validation",
    );
    return null;
  }

  const recipes = withEfficiency(
    parsed.data.recipes.map((recipe) => ({
      name: recipe.name,
      description: recipe.steps[0] ?? "",
      instructions: recipe.steps.join("\n"),
      cookTime: `${recipe.cook_time_minutes} minutes`,
      difficulty: recipe.difficulty,
      used: recipe.used_ingredients,
      missing: recipe.missing_ingredients,
      efficiency: recipe.waste_reduction_score / 100,
    })),
    ingredientList,
    cuisine,
  );

  if (!recipes.length || recipes.some((recipe) => computeCoveragePercent(recipe.used, ingredientList) < 40)) {
    return null;
  }
  return { recipes, confidence: provider === AIProvider.OpenRouter ? 0.9 : 0.75 };
}

/**
 * Generate recipes - FULL PIPELINE
 * Gemini → HuggingFace → Internal Fallback
 */
export async function generateRecipes(
  ingredients: string,
  cuisine: string | null | undefined,
  requestId?: string
): Promise<RecipeSuggestion> {
  totalRecipeRequests += 1;
  const ingredientList = normalizeIngredientList(ingredients);
  const cacheKey = buildRecipeCacheKey(ingredientList, cuisine);

  const cached = getCachedRecipeSuggestion(cacheKey);
  if (cached) {
    if (cached.isFallback) {
      totalRecipeFallbacks += 1;
    }
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
    if (config.aiStrictMode) {
      const err = new Error("AI providers unavailable — check configuration") as Error & { status?: number };
      err.status = 503;
      throw err;
    }

    totalRecipeFallbacks += 1;
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
  const providerTried: AIProvider[] = [];

  // 1. OpenRouter free router (primary hosted provider)
  if (config.hasOpenRouter) {
    aiAttempted = true;
    providerTried.push(AIProvider.OpenRouter);
    const result = await generateRecipesWithProvider(
      AIProvider.OpenRouter,
      generateWithOpenRouter,
      ingredients,
      cuisine,
      requestId,
    );
    if (result && result.recipes.length > 0) {
      const coveragePct = Math.round(
        result.recipes.reduce((acc, recipe) => acc + computeCoveragePercent(recipe.used, ingredientList), 0) /
        result.recipes.length
      );
      const suggestion: RecipeSuggestion = {
        recipes: result.recipes,
        sustainabilityMessage: "You reduced food waste by using available ingredients.",
        ingredientsUsed: ingredientList,
        cuisine: cuisine || null,
        isFallback: false,
        provider: AIProvider.OpenRouter,
        confidence: result.confidence,
        cacheHit: false,
        low_confidence: false,
      };
      recordAISuccess();
      setCachedRecipeSuggestion(cacheKey, suggestion);
      logger.info(
        {
          requestId,
          providerFailureReason: null,
          ingredientCoveragePct: coveragePct,
          fallbackTriggered: false,
          fallbackUsageRate: Number(getFallbackUsageRate().toFixed(3)),
          cacheHit: false,
          providerUsed: AIProvider.OpenRouter,
          fallbackUsed: false,
          circuitOpen: false,
        },
        "Recipe suggestion generated by OpenRouter free router"
      );
      return suggestion;
    }
  } else {
    logger.warn({ requestId }, "Skipping OpenRouter because OPENROUTER_API_KEY is unavailable");
  }

  // 2. Hugging Face free inference allowance
  if (config.hasHuggingFace) {
    aiAttempted = true;
    providerTried.push(AIProvider.HuggingFace);
    const result = await generateRecipesWithProvider(
      AIProvider.HuggingFace,
      generateWithHuggingFaceProvider,
      ingredients,
      cuisine,
      requestId,
    );
    if (result && result.recipes.length > 0) {
      const coveragePct = Math.round(
        result.recipes.reduce((acc, recipe) => acc + computeCoveragePercent(recipe.used, ingredientList), 0) /
        result.recipes.length
      );
      const suggestion: RecipeSuggestion = {
        recipes: result.recipes,
        sustainabilityMessage: "You reduced food waste by using available ingredients.",
        ingredientsUsed: ingredientList,
        cuisine: cuisine || null,
        isFallback: true,
        provider: AIProvider.HuggingFace,
        confidence: result.confidence,
        cacheHit: false,
        low_confidence: true,
      };
      recordAISuccess();
      setCachedRecipeSuggestion(cacheKey, suggestion);
      logger.info(
        {
          requestId,
          providerFailureReason: null,
          ingredientCoveragePct: coveragePct,
          fallbackTriggered: false,
          fallbackUsageRate: Number(getFallbackUsageRate().toFixed(3)),
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

  // 3. Local Ollama; unavailable or missing models are skipped.
  if (config.hasOllama) {
    aiAttempted = true;
    providerTried.push(AIProvider.Ollama);
    const result = await generateRecipesWithProvider(
      AIProvider.Ollama,
      generateWithOllama,
      ingredients,
      cuisine,
      requestId,
    );
    if (result && result.recipes.length > 0) {
      const suggestion: RecipeSuggestion = {
        recipes: result.recipes,
        sustainabilityMessage: "You reduced food waste by using available ingredients.",
        ingredientsUsed: ingredientList,
        cuisine: cuisine || null,
        isFallback: true,
        provider: AIProvider.Ollama,
        confidence: result.confidence,
        cacheHit: false,
        low_confidence: true,
      };
      recordAISuccess();
      setCachedRecipeSuggestion(cacheKey, suggestion);
      return suggestion;
    }
  }

  if (aiAttempted) {
    recordAIFailure();
  }

  if (config.aiStrictMode) {
    logger.error(
      {
        requestId,
        providerTried,
        errorReason: aiAttempted ? "providers_failed_or_empty" : "no_ai_provider_configured",
      },
      "Strict mode is enabled and providers are unavailable"
    );
    const err = new Error("AI providers unavailable — check configuration") as Error & { status?: number };
    err.status = 503;
    throw err;
  }

  // 4. Return internal deterministic fallback
  totalRecipeFallbacks += 1;
  const fallback = generateFallbackResponse(ingredients, cuisine, AIProvider.Fallback);
  setCachedRecipeSuggestion(cacheKey, fallback);
  logger.warn(
    {
      requestId,
      providerTried,
      errorReason: aiAttempted ? "providers_failed_or_empty" : "no_ai_provider_configured",
      fallbackUsed: true,
      fallbackTriggered: true,
      fallbackUsageRate: Number(getFallbackUsageRate().toFixed(3)),
      cacheHit: false,
      providerUsed: AIProvider.Fallback,
      circuitOpen: isAICircuitOpen(),
      consecutiveAIFailures,
    },
    "Falling back to internal recipe database"
  );
  return { ...fallback, cacheHit: false, low_confidence: true };
}

interface HFTextGenerationResponse {
  generated_text?: string;
  summary_text?: string;
}

async function extractIngredientsFromCaptionWithHuggingFace(
  caption: string,
  requestId?: string
): Promise<string[] | null> {
  if (!config.huggingfaceApiKey) return null;

  const extractionPrompt = `Extract visible food ingredients from this caption.
Return ONLY JSON in this format:
{"ingredients":["item1","item2"]}

Caption: ${caption}`;

  for (const modelName of HUGGINGFACE_RECIPE_MODELS) {
    const response = await Promise.race([
      fetch(getHuggingFaceModelUrl(modelName), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.huggingfaceApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: extractionPrompt,
          parameters: {
            max_new_tokens: 220,
            temperature: 0.2,
            return_full_text: false,
          },
        }),
      }),
      timeoutAfter(HUGGINGFACE_IMAGE_TIMEOUT_MS),
    ]);

    if (!response.ok) {
      const body = await response.text();
      logger.warn(
        { requestId, provider: "huggingface", model: modelName, status: response.status, responseBodyPresent: body.length > 0 },
        "HuggingFace ingredient extraction API returned non-OK response"
      );
      continue;
    }

    const data = (await response.json()) as HFTextGenerationResponse[] | HFTextGenerationResponse;
    const text = Array.isArray(data)
      ? data[0]?.generated_text ?? data[0]?.summary_text ?? ""
      : data.generated_text ?? data.summary_text ?? "";

    const parsed = safeJsonParse(text);
    const strictParsed = GeminiIngredientsStrictSchema.safeParse(parsed);
    if (!strictParsed.success) {
      continue;
    }

    return strictParsed.data.ingredients
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .filter((item, idx, arr) => arr.indexOf(item) === idx)
      .slice(0, 12);
  }

  return null;
}

async function detectWithGeminiVision(
  imageBase64: string,
  mimeType?: string,
  requestId?: string
): Promise<{
  ingredients: string[];
  confidence: number;
  raw: string;
} | null> {
  if (!config.geminiApiKey) {
    logger.warn({ requestId, provider: "gemini" }, "Gemini API key unavailable for vision detection");
    return null;
  }

  try {
    const base64Data = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const mimeMatch = imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    const resolvedMimeType = mimeType ?? mimeMatch?.[1];
    if (!resolvedMimeType) {
      logger.warn({ requestId, provider: "gemini", reason: "missing_mime_type" }, "Gemini vision skipped due to missing MIME type");
      return null;
    }

    const prompt = `You are an AI food vision system.

Analyze this image and extract ONLY visible ingredients.

Rules:
- Return ONLY valid JSON
- No explanation text
- No markdown
- No extra words

Format:
{
  "ingredients": ["item1", "item2", "item3"]
}`;

    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
      try {
        logger.info(
          { requestId, provider: "gemini", model: GEMINI_MODEL, attempt, timeoutMs: GEMINI_TIMEOUT_MS },
          "Entering Gemini Vision"
        );

        const response = await Promise.race([
          fetchGeminiRequest(GEMINI_API_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.geminiApiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "http://localhost:3000",
              "X-Gemini-Title": "ZeroPlate Chef",
            },
            body: JSON.stringify({
              model: GEMINI_MODEL,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: prompt },
                    {
                      type: "image_url",
                      image_url: { url: `data:${resolvedMimeType};base64,${base64Data}` },
                    },
                  ],
                },
              ],
              temperature: 0.2,
              max_tokens: 800,
            }),
          }),
          timeoutAfter(GEMINI_TIMEOUT_MS),
        ]);

        if (!response.ok) {
          const body = await response.text();
          logger.warn(
            {
              requestId,
              provider: "gemini",
              model: GEMINI_MODEL,
              attempt,
              status: response.status,
              responseBodyPresent: body.length > 0,
              ...summarizeGeminiError(body, response.status),
            },
            "Gemini vision request returned non-OK response"
          );

          if (GEMINI_RETRYABLE_STATUSES.has(response.status) && attempt < GEMINI_MAX_RETRIES) {
            await delay(getGeminiRetryDelay(response, attempt));
          }
          continue;
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content?.trim() ?? "";
        const parsed = safeJsonParse(text);
        logger.info({ provider: "gemini", model: GEMINI_MODEL, responseReceived: true, parsed: !!parsed, requestId }, "Gemini vision output debug");

        const strictParsed = GeminiIngredientsStrictSchema.safeParse(parsed);
        if (!strictParsed.success) {
          throw new Error("Gemini returned invalid structure");
        }

        const ingredients = strictParsed.data.ingredients
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
          .filter((item, idx, arr) => arr.indexOf(item) === idx)
          .slice(0, 12);

        if (!ingredients.length) {
          throw new Error("Gemini returned empty ingredient list");
        }

        logger.info(
          { requestId, providerUsed: "gemini", model: GEMINI_MODEL, ingredientCount: ingredients.length, fallbackTriggered: false },
          "Gemini Vision detected ingredients"
        );

        return { ingredients, confidence: 0.95, raw: text };
      } catch (err) {
        const isLastAttempt = attempt >= GEMINI_MAX_RETRIES;
        logger.warn(
          {
            requestId,
            provider: "gemini",
            model: GEMINI_MODEL,
            attempt,
            retrying: !isLastAttempt,
            reason: String(err),
          },
          "Gemini vision attempt failed"
        );

        if (!isLastAttempt) {
          await delay(250 * Math.pow(2, attempt));
        }
      }
    }

    return null;
  } catch (err) {
    logger.warn(
      { requestId, provider: "gemini", errorType: err instanceof Error ? err.name : "UnknownError" },
      "Gemini failed"
    );
    logger.warn(
      { requestId, provider: "gemini", errorType: err instanceof Error ? err.name : "UnknownError" },
      "Gemini vision detection failed"
    );
    return null;
  }
}

// HuggingFace image classification - FALLBACK
async function detectWithHuggingFace(
  imageBase64: string,
  mimeType?: string,
  requestId?: string
): Promise<{
  ingredients: string[];
  confidence: number;
} | null> {
  if (!config.huggingfaceApiKey) {
    logger.warn({ requestId, provider: "huggingface" }, "HuggingFace API key unavailable for image detection");
    return null;
  }

  try {
    logger.info(
      {
        requestId,
        provider: "huggingface",
        timeoutMs: HUGGINGFACE_IMAGE_TIMEOUT_MS,
        model: HUGGINGFACE_IMAGE_MODEL,
      },
      "Entering HuggingFace"
    );

    const base64Data = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    if (!mimeType) {
      logger.warn({ requestId, provider: "huggingface", reason: "missing_mime_type" }, "Skipping HuggingFace vision due to missing MIME type");
      return null;
    }

    const response = await Promise.race([
      fetch(
        HUGGINGFACE_IMAGE_API_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.huggingfaceApiKey}`,
            "Content-Type": "application/octet-stream",
          },
          body: Buffer.from(base64Data, "base64"),
        }
      ),
      timeoutAfter(HUGGINGFACE_IMAGE_TIMEOUT_MS),
    ]);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.warn(
        {
          requestId,
          provider: "huggingface",
          status: response.status,
          statusText: response.statusText,
          responseBodyPresent: errorBody.length > 0,
        },
        "HuggingFace image API returned non-OK response"
      );
      return null;
    }

    const data = (await response.json()) as HFTextGenerationResponse[] | HFTextGenerationResponse;
    const caption = Array.isArray(data)
      ? data[0]?.generated_text ?? data[0]?.summary_text ?? ""
      : data.generated_text ?? data.summary_text ?? "";

    if (!caption) {
      logger.warn(
        {
          requestId,
          provider: "huggingface",
          responseType: typeof data,
        },
        "HuggingFace image caption response was empty"
      );
      return null;
    }

    const ingredients = await extractIngredientsFromCaptionWithHuggingFace(caption, requestId);
    if (!ingredients || ingredients.length === 0) {
      logger.warn(
        { requestId, provider: "huggingface", caption: caption.slice(0, 400) },
        "HuggingFace caption to ingredients extraction failed"
      );
      return null;
    }

    logger.info(
      { requestId, providerUsed: "huggingface", count: ingredients.length, confidence: 0.65, fallbackTriggered: false },
      "HuggingFace detected ingredients"
    );

    return { ingredients, confidence: 0.65 };
  } catch (err) {
    logger.warn(
      { requestId, provider: "huggingface", errorType: err instanceof Error ? err.name : "UnknownError" },
      "HuggingFace image detection failed"
    );
    return null;
  }
}

async function detectWithProvider(
  provider: AIProvider,
  generateText: (request: {
    prompt: string;
    requestId?: string;
    imageBase64: string;
    mimeType?: string;
  }) => Promise<string | null>,
  imageBase64: string,
  mimeType: string | undefined,
  requestId?: string,
): Promise<{ ingredients: string[]; confidence: number } | null> {
  if (!mimeType) return null;
  const text = await generateText({
    prompt: "Identify only the visible food ingredients. Return JSON: {\"ingredients\":[\"item\"]}.",
    requestId,
    imageBase64,
    mimeType,
  });
  const parsed = GeminiIngredientsStrictSchema.safeParse(safeJsonParse(text || ""));
  if (!parsed.success) return null;
  const ingredients = parsed.data.ingredients
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 12);
  return ingredients.length
    ? { ingredients, confidence: provider === AIProvider.OpenRouter ? 0.9 : 0.7 }
    : null;
}

// Detect ingredients - FULL PIPELINE
export async function detectIngredientsFromImage(
  imageBase64: string,
  mimeType?: string,
  requestId?: string
): Promise<IngredientDetectionResult> {
  const providerTried: AIProvider[] = [];

  // 1. OpenRouter free router (primary)
  if (config.hasOpenRouter) {
    providerTried.push(AIProvider.OpenRouter);
    const result = await detectWithProvider(
      AIProvider.OpenRouter,
      (request) => generateWithOpenRouter(request),
      imageBase64,
      mimeType,
      requestId,
    );
    if (result && result.ingredients.length > 0) {
      return {
        ingredients: result.ingredients,
        confidence: result.confidence,
        isApproximate: false,
        provider: AIProvider.OpenRouter,
        low_confidence: false,
      };
    }
  } else {
    logger.warn({ requestId }, "Skipping OpenRouter vision because OPENROUTER_API_KEY is unavailable");
  }

  // 2. Hugging Face free inference allowance (fallback)
  if (config.hasHuggingFace) {
    providerTried.push(AIProvider.HuggingFace);
    const result = await detectWithProvider(
      AIProvider.HuggingFace,
      (request) => generateWithHuggingFaceProvider(request),
      imageBase64,
      mimeType,
      requestId,
    );
    if (result && result.ingredients.length > 0) {
      return {
        ingredients: result.ingredients,
        confidence: result.confidence,
        isApproximate: false,
        provider: AIProvider.HuggingFace,
        low_confidence: true,
      };
    }
  } else {
    logger.warn({ requestId }, "Skipping HuggingFace because hasHuggingFace=false");
  }

  // 3. Local Ollama vision model (fallback)
  if (config.hasOllama) {
    providerTried.push(AIProvider.Ollama);
    const result = await detectWithProvider(
      AIProvider.Ollama,
      (request) => analyzeWithOllama(request),
      imageBase64,
      mimeType,
      requestId,
    );
    if (result && result.ingredients.length > 0) {
      return {
        ingredients: result.ingredients,
        confidence: result.confidence,
        isApproximate: true,
        provider: AIProvider.Ollama,
        low_confidence: true,
      };
    }
  }

  // 4. Return reliable fallback
  if (config.aiStrictMode) {
    logger.error(
      {
        requestId,
        providerTried,
        errorReason: "all_providers_failed_or_empty",
      },
      "Strict mode is enabled and providers are unavailable for image detection"
    );
    const err = new Error("AI providers unavailable — check configuration") as Error & { status?: number };
    err.status = 503;
    throw err;
  }

  logger.warn(
    {
      requestId,
      providerTried,
      errorReason: "all_providers_failed_or_empty",
      fallbackUsed: true,
      reason: "all_providers_failed",
    },
    "Using hardcoded fallback ingredients"
  );
  return {
    ingredients: ["tomato", "onion", "garlic", "olive oil", "salt", "pepper"],
    confidence: 0.5,
    isApproximate: true,
    provider: AIProvider.Fallback,
    low_confidence: true,
  };
}

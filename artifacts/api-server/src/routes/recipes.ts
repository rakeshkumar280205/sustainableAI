import { Router, type IRouter } from "express";
import { RecipeHistoryModel, isConnected } from "../db/index.js";
import {
  GenerateRecipesBody,
  GenerateRecipesResponse,
  DetectIngredientsResponse,
  DeleteRecipeHistoryResponse,
  GetRecipeHistoryResponse,
  GetRecipeStatsResponse,
} from "@zeroplate/api-zod";
import { generateRecipes, detectIngredientsFromImage } from "../lib/aiService.js";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { logger } from "../lib/logger.js";
import { imageUpload, isValidImageBuffer } from "../middlewares/imageUpload.js";
import { apiKeyAuth } from "../middlewares/apiKeyAuth.js";
import { aiRouteLimiter } from "../middlewares/aiRateLimit.js";
import { ErrorEnvelopeSchema, sendValidatedResponse, validateResponse } from "../lib/responseValidation.js";

const router: IRouter = Router();

/**
 * Normalize and deduplicate ingredients
 * - Handles both string and array input
 * - Trims whitespace
 * - Converts to lowercase for consistency
 * - Deduplicates
 */
function normalizeIngredients(input: string | string[]): string[] {
  const items = Array.isArray(input)
    ? input
    : input.split(",");

  const normalized = items
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  // Deduplicate using a Set while preserving order
  const seen = new Set<string>();
  return normalized.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

router.post("/recipes", apiKeyAuth, aiRouteLimiter, asyncHandler(async (req, res): Promise<void> => {
  const requestId = (req as any).id;
  const parsed = GenerateRecipesBody.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ requestId, errors: parsed.error.errors }, "Recipe generation validation failed");
    sendValidatedResponse(res, 400, ErrorEnvelopeSchema, {
      success: false,
      data: null,
      error: {
        message: "Invalid ingredients or cuisine format",
        details: parsed.error.message,
      },
    }, "POST /recipes validation", requestId);
    return;
  }

  const { ingredients, cuisine } = parsed.data;
  const normalizedIngredients = normalizeIngredients(ingredients);

  if (normalizedIngredients.length === 0) {
    logger.warn({ requestId }, "Recipe generation attempted with empty ingredients");
    sendValidatedResponse(res, 400, ErrorEnvelopeSchema, {
      success: false,
      data: null,
      error: {
        message: "Please enter at least one ingredient",
      },
    }, "POST /recipes empty ingredients", requestId);
    return;
  }

  const ingredientsText = normalizedIngredients.join(", ");

  const result = await generateRecipes(ingredientsText, cuisine ?? null, requestId);

  const responsePayload = {
    success: true,
    data: result,
    error: null,
  };

  const validatedResponse = validateResponse(
    GenerateRecipesResponse,
    responsePayload,
    "POST /recipes response",
    requestId,
  );

  if (!validatedResponse) {
    res.status(500).json({
      success: false,
      data: null,
      error: { message: "Internal server error" },
    });
    return;
  }

  const totalMissing = result.recipes.reduce(
    (acc: number, recipe: { missing: string[] }) => acc + recipe.missing.length,
    0,
  );

  try {
    if (isConnected()) {
      await RecipeHistoryModel.create({
        ingredients: ingredientsText,
        cuisine: cuisine ?? null,
        recipeCount: result.recipes.length,
        missingCount: totalMissing,
      });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to save recipe history (non-critical)");
    // History storage is non-critical — don't throw
  }

  logger.info(
    {
      requestId,
      ingredientCount: result.ingredientsUsed.length,
      cuisine: cuisine ?? "any",
      provider: result.provider,
      isFallback: result.isFallback,
      confidence: result.confidence,
      recipeCount: result.recipes.length,
    },
    "Successfully generated recipes"
  );

  res.json(responsePayload);
}));

router.post(
  "/recipes/detect-ingredients",
  apiKeyAuth,
  aiRouteLimiter,
  imageUpload.single("image"),
  asyncHandler(async (req, res): Promise<void> => {
    const requestId = (req as any).id;

    if (!req.file) {
      logger.warn({ requestId }, "Image detection attempted without file");
      sendValidatedResponse(res, 400, ErrorEnvelopeSchema, {
        success: false,
        data: null,
        error: {
          message: "Please upload an image to detect ingredients",
        },
      }, "POST /recipes/detect-ingredients missing file", requestId);
      return;
    }

    if (!isValidImageBuffer(req.file.buffer)) {
      logger.warn({ requestId, mimetype: req.file.mimetype }, "Invalid image format uploaded");
      sendValidatedResponse(res, 400, ErrorEnvelopeSchema, {
        success: false,
        data: null,
        error: {
          message: "Invalid image format",
        },
      }, "POST /recipes/detect-ingredients invalid image", requestId);
      return;
    }

    // Convert buffer to base64 for AI processing
    const imageBase64 = req.file.buffer.toString("base64");
    const result = await detectIngredientsFromImage(imageBase64, requestId);

    const validatedResponse = validateResponse(
      DetectIngredientsResponse,
      {
        success: true,
        data: result,
        error: null,
      },
      "POST /recipes/detect-ingredients response",
      requestId,
    );

    if (!validatedResponse) {
      res.status(500).json({
        success: false,
        data: null,
        error: { message: "Internal server error" },
      });
      return;
    }

    logger.info(
      {
        requestId,
        ingredientCount: result.ingredients.length,
        confidence: result.confidence,
        provider: result.provider,
        isApproximate: result.isApproximate,
      },
      "Successfully detected ingredients from image"
    );

    res.json({
      success: true,
      data: result,
      error: null,
    });
  })
);

router.delete("/recipes/history/:id", apiKeyAuth, asyncHandler(async (req, res): Promise<void> => {
  const requestId = (req as any).id;
  if (!isConnected()) {
    logger.warn({ requestId }, "Delete history attempted with database unavailable");
    sendValidatedResponse(res, 503, ErrorEnvelopeSchema, {
      success: false,
      data: null,
      error: {
        message: "Database is currently unavailable. Please try again.",
      },
    }, "DELETE /recipes/history/:id unavailable", requestId);
    return;
  }

  const id = req.params.id as string;

  const deleted = await RecipeHistoryModel.findByIdAndDelete(id);

  if (!deleted) {
    logger.warn({ requestId, id }, "Attempted to delete non-existent history item");
    sendValidatedResponse(res, 404, ErrorEnvelopeSchema, {
      success: false,
      data: null,
      error: {
        message: "History item not found",
      },
    }, "DELETE /recipes/history/:id not found", requestId);
    return;
  }

  logger.info({ requestId, id }, "Successfully deleted recipe history item");
  const validatedResponse = validateResponse(
    DeleteRecipeHistoryResponse,
    {
      success: true,
      data: { deleted: true },
      error: null,
    },
    "DELETE /recipes/history/:id response",
    requestId,
  );

  if (!validatedResponse) {
    res.status(500).json({
      success: false,
      data: null,
      error: { message: "Internal server error" },
    });
    return;
  }

  res.json(validatedResponse);
}));

router.get("/recipes/history", asyncHandler(async (req, res): Promise<void> => {
  const requestId = (req as any).id;
  if (!isConnected()) {
    logger.info({ requestId }, "History requested with database unavailable, returning empty");
    const validatedResponse = validateResponse(
      GetRecipeHistoryResponse,
      {
        success: true,
        data: { history: [] },
        error: null,
      },
      "GET /recipes/history fallback response",
      requestId,
    );

    if (!validatedResponse) {
      res.status(500).json({
        success: false,
        data: null,
        error: { message: "Internal server error" },
      });
      return;
    }

    res.json(validatedResponse);
    return;
  }

  const history = await RecipeHistoryModel.find()
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  logger.info({ requestId, count: history.length }, "Retrieved recipe history");

  const validatedResponse = validateResponse(
    GetRecipeHistoryResponse,
    {
      success: true,
      data: {
        history: history.map((h: any) => ({
          id: h._id?.toString() ?? "",
          ingredients: h.ingredients,
          cuisine: h.cuisine ?? null,
          recipeCount: h.recipeCount,
          missingCount: h.missingCount,
          createdAt: h.createdAt.toISOString(),
        })),
      },
      error: null,
    },
    "GET /recipes/history response",
    requestId,
  );

  if (!validatedResponse) {
    res.status(500).json({
      success: false,
      data: null,
      error: { message: "Internal server error" },
    });
    return;
  }

  res.json(validatedResponse);
}));

router.get("/recipes/stats", asyncHandler(async (req, res): Promise<void> => {
  const requestId = (req as any).id;
  if (!isConnected()) {
    logger.info({ requestId }, "Stats requested with database unavailable, returning zeroes");
    const validatedResponse = validateResponse(
      GetRecipeStatsResponse,
      {
        success: true,
        data: {
          totalSearches: 0,
          totalIngredientsUsed: 0,
          mostUsedIngredients: [],
          wasteReductionScore: 0,
        },
        error: null,
      },
      "GET /recipes/stats fallback response",
      requestId,
    );

    if (!validatedResponse) {
      res.status(500).json({
        success: false,
        data: null,
        error: { message: "Internal server error" },
      });
      return;
    }

    res.json(validatedResponse);
    return;
  }

  const recentHistory = await RecipeHistoryModel.find()
    .sort({ createdAt: -1 })
    .limit(50)
    .select("ingredients")
    .lean();

  const totalSearches = await RecipeHistoryModel.countDocuments();

  const ingredientCounts: Record<string, number> = {};
  let totalIngredientsUsed = 0;

  for (const row of recentHistory) {
    const items = row.ingredients
      .split(",")
      .map((i: string) => i.trim().toLowerCase())
      .filter(Boolean);

    totalIngredientsUsed += items.length;

    for (const item of items) {
      ingredientCounts[item] = (ingredientCounts[item] ?? 0) + 1;
    }
  }

  const mostUsedIngredients = Object.entries(ingredientCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  const wasteReductionScore = Math.min(100, Math.round(totalIngredientsUsed * 3));

  logger.info(
    { requestId, totalSearches, totalIngredientsUsed, ingredientCount: mostUsedIngredients.length },
    "Retrieved recipe statistics"
  );

  const validatedResponse = validateResponse(
    GetRecipeStatsResponse,
    {
      success: true,
      data: {
        totalSearches,
        totalIngredientsUsed,
        mostUsedIngredients,
        wasteReductionScore,
      },
      error: null,
    },
    "GET /recipes/stats response",
    requestId,
  );

  if (!validatedResponse) {
    res.status(500).json({
      success: false,
      data: null,
      error: { message: "Internal server error" },
    });
    return;
  }

  res.json(validatedResponse);
}));

export default router;

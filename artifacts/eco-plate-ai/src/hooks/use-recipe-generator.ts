import { useState, useRef } from "react";
import { useGenerateRecipes, useDetectIngredients } from "@zeroplate/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { dedupeIngredients, parseIngredientsString } from "@/utils/ingredients";
import { estimateSavedGrams, getSmartInsight, findBestRecipeIndex } from "@/utils/sustainability";

export const CUISINE_OPTIONS = [
  { value: "any", label: "Any cuisine" },
  { value: "Italian", label: "Italian" },
  { value: "Indian", label: "Indian" },
  { value: "Chinese", label: "Chinese" },
  { value: "Mexican", label: "Mexican" },
  { value: "Mediterranean", label: "Mediterranean" },
  { value: "Japanese", label: "Japanese" },
  { value: "Thai", label: "Thai" },
  { value: "French", label: "French" },
];

export enum AIProvider {
  OpenRouter = "openrouter",
  HuggingFace = "huggingface",
  Ollama = "ollama",
  Fallback = "fallback",
}

export interface Recipe {
  name: string;
  description: string;
  instructions: string;
  cookTime: string;
  difficulty: string;
  used: string[];
  missing: string[];
  efficiency?: number;
}

export interface RecipeData {
  recipes: Recipe[];
  sustainabilityMessage: string;
  ingredientsUsed: string[];
  cuisine: string | null;
  isFallback: boolean;
  provider: AIProvider;
  confidence?: number;
  low_confidence?: boolean;
}

export interface IngredientDetectionResult {
  ingredients: string[];
  confidence: number;
  isApproximate: boolean;
  provider: AIProvider;
  low_confidence?: boolean;
}

interface ApiError {
  message: string;
  details?: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
}

export function useRecipeGenerator() {
  const [ingredients, setIngredients] = useState("");
  const [cuisine, setCuisine] = useState("any");
  const [detectedApproximate, setDetectedApproximate] = useState(false);
  const [recipeData, setRecipeData] = useState<RecipeData | null>(null);
  const [detectionProvider, setDetectionProvider] = useState<AIProvider | null>(null);
  const [detectionConfidence, setDetectionConfidence] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { toast } = useToast();
  const generateMutation = useGenerateRecipes();
  const detectMutation = useDetectIngredients();

  // ── Actions ──────────────────────────────────────────────────────────────

  async function runGenerate() {
    if (!ingredients.trim()) return;
    const deduped = dedupeIngredients(ingredients);
    setIngredients(deduped);

    // Convert to array format for strict API contract
    const ingredientsArray = parseIngredientsString(deduped);

    try {
      const response = (await generateMutation.mutateAsync({
        data: {
          ingredients: ingredientsArray,
          cuisine: cuisine === "any" ? null : cuisine,
        },
      })) as ApiEnvelope<RecipeData>;

      if (!response?.success) {
        toast({
          title: "Recipe generation failed",
          description: response?.error?.message ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }

      if (!response.data) {
        toast({
          title: "Using fallback recipes",
          description: "AI returned no structured result, so we fell back to curated recipes.",
        });
        setRecipeData(null);
        return;
      }

      const recipeResponse = response.data;
      setRecipeData(recipeResponse);

      // Show provider indicator toast
      const providerName =
        recipeResponse.provider === AIProvider.OpenRouter
          ? "✨ OpenRouter"
          : recipeResponse.provider === AIProvider.HuggingFace
            ? "🤗 HuggingFace"
            : recipeResponse.provider === AIProvider.Ollama
              ? "🖥️ Ollama"
              : "💾 Fallback";

      const confidencePercent = recipeResponse.confidence
        ? Math.round(recipeResponse.confidence * 100)
        : 0;

      toast({
        title: `Recipes generated with ${providerName}`,
        description: `Confidence: ${confidencePercent}%`,
      });
    } catch (err) {
      toast({
        title: "Recipe generation failed",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runGenerate();
  }

  async function handleImageFile(file: File) {
    // Validate file size (max 5MB)
    const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
    if (file.size > MAX_FILE_SIZE) {
      toast({
        title: "Image too large",
        description: "Please upload an image smaller than 5MB.",
        variant: "destructive",
      });
      return;
    }

    try {
      // Create FormData for multipart upload
      const response = (await detectMutation.mutateAsync({
        data: { image: file },
      })) as ApiEnvelope<IngredientDetectionResult>;

      if (!response?.success) {
        toast({
          title: "Image detection failed",
          description: response?.error?.message ?? "Please try again with a different image.",
          variant: "destructive",
        });
        return;
      }

      if (!response.data) {
        toast({
          title: "Using fallback ingredients",
          description: "AI returned no result, so we used a safe starter list.",
        });
        return;
      }

      const detectionResult = response.data;
      const detected = detectionResult.ingredients.join(", ");

      // Track detection provider and confidence
      setDetectionProvider(detectionResult.provider);
      setDetectionConfidence(detectionResult.confidence);

      setIngredients((prev) =>
        prev.trim() ? dedupeIngredients(`${prev}, ${detected}`) : detected
      );
      setDetectedApproximate(detectionResult.isApproximate);

      // Show provider indicator
      const providerName =
        detectionResult.provider === AIProvider.OpenRouter
          ? "✨ OpenRouter Vision"
          : detectionResult.provider === AIProvider.HuggingFace
            ? "🤗 HuggingFace"
            : detectionResult.provider === AIProvider.Ollama
              ? "🖥️ Ollama Vision"
              : "💾 Fallback";

      const confidencePercent = Math.round(detectionResult.confidence * 100);

      toast({
        title: `Detected with ${providerName}`,
        description: `${detectionResult.ingredients.length} ingredients found (${confidencePercent}% confidence)${detectionResult.isApproximate ? " - approximate" : ""}`,
      });
    } catch {
      // Graceful fallback when image detection fails
      const fallback = "tomato, onion, garlic, olive oil, salt, pepper";
      setIngredients((prev) =>
        prev.trim() ? dedupeIngredients(`${prev}, ${fallback}`) : fallback
      );
      setDetectedApproximate(true);
      setDetectionProvider(AIProvider.Fallback);
      setDetectionConfidence(0.5);
      toast({
        title: "Detection had trouble with your image",
        description: "Added some common ingredients as a starting point. Feel free to adjust them.",
        variant: "default",
      });
    }
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleImageFile(file);
    if (e.target) e.target.value = "";
  }

  function handleTryAnotherCuisine() {
    const others = CUISINE_OPTIONS.filter((o) => o.value !== cuisine && o.value !== "any");
    const next = others[Math.floor(Math.random() * others.length)];
    if (next) {
      setCuisine(next.value);
      toast({
        title: `Switched to ${next.label}`,
        description: "Click Generate to see new recipes.",
      });
    }
  }

  function handleReset() {
    setIngredients("");
    setDetectedApproximate(false);
    setRecipeData(null);
    setDetectionProvider(null);
    setDetectionConfidence(null);
    generateMutation.reset();
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const data = recipeData;
  const isPending = generateMutation.isPending || detectMutation.isPending;
  const isDetecting = detectMutation.isPending;

  const usedCount = data?.ingredientsUsed.length ?? 0;
  const totalMissing =
    data?.recipes.reduce((acc, r) => acc + (r.missing?.length ?? 0), 0) ?? 0;
  const { low: savedLow, high: savedHigh } = estimateSavedGrams(usedCount);
  const smartInsight = data ? getSmartInsight(usedCount, totalMissing) : "";
  const bestRecipeIndex = data ? findBestRecipeIndex(data.recipes) : -1;

  return {
    // State
    ingredients,
    setIngredients,
    cuisine,
    setCuisine,
    detectedApproximate,
    fileInputRef,

    // AI Provider info
    recipeProvider: data?.provider,
    recipeConfidence: data?.confidence,
    detectionProvider,
    detectionConfidence,

    // Mutations
    data,
    isPending,
    isDetecting,
    isGenerating: generateMutation.isPending,

    // Handlers
    handleSubmit,
    runGenerate,
    handleImageChange,
    handleTryAnotherCuisine,
    handleReset,

    // Derived
    usedCount,
    totalMissing,
    savedLow,
    savedHigh,
    smartInsight,
    bestRecipeIndex,
  };
}

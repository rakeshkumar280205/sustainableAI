import { beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = {
    generateWithOpenRouter: vi.fn(),
    generateWithHuggingFace: vi.fn(),
    generateWithOllama: vi.fn(),
    analyzeWithOllama: vi.fn(),
};

vi.mock("../src/config.js", () => ({
    default: {
        hasOpenRouter: true,
        hasHuggingFace: true,
        hasOllama: true,
        hasGemini: false,
        openrouterApiKey: "openrouter-test-key",
        huggingfaceApiKey: "hf-test-key",
        hfFreeOnlyEnabled: true,
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaModel: "qwen2.5vl:3b",
        ollamaVisionModel: "qwen2.5vl:3b",
        ollamaTimeoutMs: 120000,
        ollamaEnabled: true,
        aiStrictMode: false,
        geminiApiKey: "",
    },
}));

vi.mock("../src/lib/providerAdapters.js", () => providerMocks);
vi.mock("../src/lib/logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { generateRecipes } = await import("../src/lib/aiService.js");

const validResponse = JSON.stringify({
    recipes: [
        {
            name: "Tomato Pasta",
            used_ingredients: ["tomato", "pasta"],
            missing_ingredients: [],
            steps: ["Cook pasta with tomato."],
            cook_time_minutes: 20,
            difficulty: "easy",
            waste_reduction_score: 90,
        },
    ],
});

describe("provider orchestration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        providerMocks.generateWithOpenRouter.mockResolvedValue(null);
        providerMocks.generateWithHuggingFace.mockResolvedValue(null);
        providerMocks.generateWithOllama.mockResolvedValue(null);
    });

    it("transitions from OpenRouter failure to Hugging Face", async () => {
        providerMocks.generateWithHuggingFace.mockResolvedValue(validResponse);

        const result = await generateRecipes("tomato, pasta", "italian", "hf-chain");

        expect(providerMocks.generateWithOpenRouter).toHaveBeenCalled();
        expect(providerMocks.generateWithHuggingFace).toHaveBeenCalled();
        expect(result.provider).toBe("huggingface");
        expect(result.isFallback).toBe(true);
    });

    it("transitions from Hugging Face failure to Ollama", async () => {
        providerMocks.generateWithOllama.mockResolvedValue(validResponse);

        const result = await generateRecipes("potato, onion", "indian", "ollama-chain");

        expect(providerMocks.generateWithOpenRouter).toHaveBeenCalled();
        expect(providerMocks.generateWithHuggingFace).toHaveBeenCalled();
        expect(providerMocks.generateWithOllama).toHaveBeenCalled();
        expect(result.provider).toBe("ollama");
        expect(result.isFallback).toBe(true);
    });

    it("returns deterministic fallback when all providers fail", async () => {
        const result = await generateRecipes("beans, rice", "mexican", "fallback-chain");

        expect(result.provider).toBe("fallback");
        expect(result.isFallback).toBe(true);
        expect(result.low_confidence).toBe(true);
    });
});

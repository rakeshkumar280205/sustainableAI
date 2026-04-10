import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/aiService.js", () => ({
    generateRecipes: vi.fn(),
    detectIngredientsFromImage: vi.fn(),
}));

vi.stubEnv("NODE_ENV", "development");

const { default: app } = await import("../src/app.js");
const { generateRecipes } = await import("../src/lib/aiService.js");

describe("API server", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns a validated health envelope", async () => {
        const response = await request(app).get("/api/healthz");

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            error: null,
            data: {
                status: "ok",
                environment: "development",
            },
        });
    });

    it("rejects invalid recipe requests", async () => {
        const response = await request(app)
            .post("/api/recipes")
            .send({ cuisine: "italian" })
            .set("Content-Type", "application/json");

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            success: false,
            data: null,
            error: {
                message: "Invalid ingredients or cuisine format",
            },
        });
    });

    it("returns a validated recipe generation envelope", async () => {
        vi.mocked(generateRecipes).mockResolvedValue({
            recipes: [
                {
                    name: "Tomato Pasta",
                    description: "A simple pasta dish.",
                    instructions: "Cook the pasta and mix with sauce.",
                    cookTime: "20 minutes",
                    difficulty: "Easy",
                    used: ["tomato", "pasta"],
                    missing: ["basil"],
                },
            ],
            sustainabilityMessage: "Use ingredients you already have to reduce waste.",
            ingredientsUsed: ["tomato", "pasta"],
            cuisine: "italian",
            isFallback: false,
            provider: "openai",
            confidence: 0.92,
            cacheHit: false,
        });

        const response = await request(app)
            .post("/api/recipes")
            .send({ ingredients: "tomato, pasta", cuisine: "italian" })
            .set("Content-Type", "application/json");

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            error: null,
            data: {
                provider: "openai",
                isFallback: false,
                confidence: 0.92,
                recipes: [
                    {
                        name: "Tomato Pasta",
                        difficulty: "Easy",
                    },
                ],
            },
        });
    });
});

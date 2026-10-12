import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
    default: {
        geminiApiKey: "test-key",
        hasGemini: true,
        hasHuggingFace: false,
        aiStrictMode: false,
    },
}));

vi.mock("../src/lib/logger.js", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

const { generateWithGemini, generateRecipes } = await import("../src/lib/aiService.js");

function response(status: number, body: unknown, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

describe("Gemini integration", () => {
    beforeEach(() => {
        vi.stubEnv("GEMINI_TIMEOUT_MS", "1000");
        vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it("returns generated content from the OpenAI-compatible response", async () => {
        vi.mocked(fetch).mockResolvedValueOnce(
            response(200, {
                choices: [{ message: { content: "Generated recipe content" } }],
            }),
        );

        const result = await generateWithGemini("Make a recipe", "success-test");

        expect(result).toBe("Generated recipe content");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    Authorization: "Bearer test-key",
                    "Content-Type": "application/json",
                }),
            }),
        );
        const request = vi.mocked(fetch).mock.calls[0]?.[1];
        expect(JSON.parse(String(request?.body))).toMatchObject({
            model: "gemini-3.8-flash",
            messages: [{ role: "user", content: "Make a recipe" }],
        });
    });

    it("retries a transient 503 only within the bounded retry policy", async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(response(503, { error: { code: 503, status: "UNAVAILABLE" } }))
            .mockResolvedValueOnce(response(503, { error: { code: "503" } }))
            .mockResolvedValueOnce(
                response(200, { choices: [{ message: { content: "Recovered response" } }] }),
            );

        const result = await generateWithGemini("Retry this request", "retry-test");

        expect(result).toBe("Recovered response");
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("returns clearly marked fallback data after exhausted Gemini retries", async () => {
        vi.mocked(fetch).mockResolvedValue(
            response(503, { error: { code: 503, status: "UNAVAILABLE" } }),
        );

        const result = await generateRecipes("tomato, pasta", "italian", "fallback-test");

        expect(result).toMatchObject({
            provider: "fallback",
            isFallback: true,
            low_confidence: true,
        });
    });

    it.each([401, 403])(
        "does not retry permanent HTTP %s failures",
        async (status) => {
            vi.mocked(fetch).mockResolvedValueOnce(
                response(status, { error: { code: status, status: "PERMISSION_DENIED" } }),
            );

            const result = await generateWithGemini("Do not retry this", `permanent-${status}`);

            expect(result).toBeNull();
            expect(fetch).toHaveBeenCalledTimes(1);
        },
    );
});

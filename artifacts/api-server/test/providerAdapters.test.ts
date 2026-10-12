import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
    default: {
        openrouterApiKey: "openrouter-test-key",
        huggingfaceApiKey: "hf-test-key",
        hfFreeOnlyEnabled: true,
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaModel: "qwen2.5vl:3b",
        ollamaVisionModel: "qwen2.5vl:3b",
        ollamaEnabled: true,
        ollamaTimeoutMs: 120000,
    },
}));

vi.mock("../src/lib/logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
    generateWithOpenRouter,
    generateWithHuggingFace,
    generateWithOllama,
    analyzeWithOllama,
} = await import("../src/lib/providerAdapters.js");

function response(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("provider adapters", () => {
    beforeEach(() => vi.spyOn(globalThis, "fetch"));
    afterEach(() => vi.restoreAllMocks());

    it("uses OpenRouter free routing for text and image requests", async () => {
        vi.mocked(fetch).mockImplementation(async () =>
            response(200, { choices: [{ message: { content: "ok" } }] }),
        );

        const text = await generateWithOpenRouter({ prompt: "hello", requestId: "text" });
        const image = await generateWithOpenRouter({
            prompt: "identify ingredients",
            imageBase64: "data:image/jpeg;base64,abc",
            mimeType: "image/jpeg",
            requestId: "image",
        });

        expect(text).toBe("ok");
        expect(image).toBe("ok");
        expect(fetch).toHaveBeenCalledTimes(2);
        const imageBody = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
        expect(imageBody.model).toBe("openrouter/free");
        expect(imageBody.messages[0].content[1].image_url.url).toBe("data:image/jpeg;base64,abc");
    });

    it("bounds transient retries and does not retry authentication failures", async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(response(503, { error: { code: 503 } }))
            .mockResolvedValueOnce(response(503, { error: { code: 503 } }))
            .mockResolvedValueOnce(response(401, { error: { code: 401 } }));

        const result = await generateWithOpenRouter({ prompt: "hello" });

        expect(result).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("uses Ollama's native images field and configured vision model", async () => {
        vi.mocked(fetch).mockImplementation(async (input) => {
            return typeof input === "string" && input.endsWith("/api/tags")
                ? response(200, { models: [{ name: "qwen2.5vl:3b" }] })
                : response(200, { message: { content: "ingredients" } });
        });

        const result = await analyzeWithOllama({
            prompt: "identify ingredients",
            imageBase64: "data:image/jpeg;base64,abc",
            mimeType: "image/jpeg",
        });

        expect(result).toBe("ingredients");
        const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
        expect(body.model).toBe("qwen2.5vl:3b");
        expect(body.messages[0].images).toEqual(["abc"]);
    });

    it("skips Ollama inference when the configured model is missing", async () => {
        vi.mocked(fetch).mockImplementation(async () => {
            return response(200, { models: [] });
        });

        const result = await generateWithOllama({ prompt: "hello" });

        expect(result).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry a timed-out Ollama generation", async () => {
        let calls = 0;
        vi.mocked(fetch).mockImplementation(async () => {
            calls += 1;
            return calls === 1
                ? response(200, { models: [{ name: "qwen2.5vl:3b" }] })
                : response(503, { error: { code: 503 } });
        });

        const result = await generateWithOllama({ prompt: "hello" });

        expect(result).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("returns null for an invalid hosted-provider response", async () => {
        vi.mocked(fetch).mockResolvedValue(response(200, {}));
        const result = await generateWithHuggingFace({ prompt: "hello" });
        expect(result).toBeNull();
    });
});

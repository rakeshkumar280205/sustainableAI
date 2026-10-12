import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
    default: {
        openrouterApiKey: null,
        huggingfaceApiKey: "hf-test-key",
        hfFreeOnlyEnabled: false,
        ollamaEnabled: false,
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaModel: "qwen2.5vl:3b",
        ollamaVisionModel: "qwen2.5vl:3b",
        ollamaTimeoutMs: 120000,
    },
}));

vi.mock("../src/lib/logger.js", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { generateWithHuggingFace } = await import("../src/lib/providerAdapters.js");

describe("disabled Hugging Face provider", () => {
    afterEach(() => vi.restoreAllMocks());

    it("makes no network request when free-only mode is disabled", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        const result = await generateWithHuggingFace({ prompt: "Reply exactly with OK." });

        expect(result).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

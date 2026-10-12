import config from "../config.js";
import { logger } from "./logger.js";

export type ProviderName = "openrouter" | "huggingface" | "ollama";

export interface ProviderRequest {
  prompt: string;
  requestId?: string;
  imageBase64?: string;
  mimeType?: string;
  systemPrompt?: string;
}

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openrouter/free";
const HUGGINGFACE_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";
const HUGGINGFACE_MODEL = process.env.HUGGINGFACE_TEXT_MODEL || process.env.HUGGINGFACE_MODEL || "Qwen/Qwen2.5-7B-Instruct";
const MAX_RETRIES = 1;
const HOSTED_TIMEOUT_MS = 15_000;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class ProviderRequestError extends Error {
  readonly provider: ProviderName;
  readonly status?: number;
  readonly classification: string;
  readonly retryable: boolean;

  constructor(provider: ProviderName, classification: string, status?: number, retryable = false) {
    super(`${provider} request failed`);
    this.name = "ProviderRequestError";
    this.provider = provider;
    this.classification = classification;
    this.status = status;
    this.retryable = retryable;
  }
}

function classify(status: number): string {
  if (status === 401) return "authentication";
  if (status === 403) return "permission_or_quota";
  if (status === 404) return "model_or_endpoint_not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_or_quota_limit";
  if (status >= 500) return "service_unavailable";
  return "provider_error";
}

function dataUri(request: ProviderRequest): string {
  const base64 = request.imageBase64?.includes(",")
    ? request.imageBase64
    : `data:${request.mimeType || "image/jpeg"};base64,${request.imageBase64 || ""}`;
  return base64;
}

function messages(request: ProviderRequest, ollama = false): Array<Record<string, unknown>> {
  const content = request.imageBase64
    ? [
        { type: "text", text: request.prompt },
        ...(ollama
          ? []
          : [{ type: "image_url", image_url: { url: dataUri(request) } }]),
      ]
    : request.prompt;
  const userMessage: Record<string, unknown> = { role: "user", content };
  if (ollama && request.imageBase64) userMessage.images = [request.imageBase64.includes(",") ? request.imageBase64.split(",")[1] : request.imageBase64];
  return [
    ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
    userMessage,
  ];
}

async function requestJson(
  provider: ProviderName,
  url: string,
  init: RequestInit,
  requestId?: string,
  timeoutMs = HOSTED_TIMEOUT_MS,
): Promise<unknown> {
  const maxRetries = provider === "ollama" ? 0 : MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text();
        const retryable = RETRYABLE.has(response.status);
        logger.warn(
          {
            requestId,
            provider,
            status: response.status,
            classification: classify(response.status),
            retryable,
            attempt,
            responseBodyPresent: body.length > 0,
          },
          "Provider request returned a non-OK response",
        );
        if (retryable && attempt < maxRetries) continue;
        throw new ProviderRequestError(provider, classify(response.status), response.status, retryable);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      const timedOut = error instanceof Error && error.name === "AbortError";
      logger.warn(
        { requestId, provider, classification: timedOut ? "timeout" : "service_unavailable", attempt },
        "Provider request failed",
      );
      if (attempt >= maxRetries) {
        throw new ProviderRequestError(provider, timedOut ? "timeout" : "service_unavailable", undefined, true);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProviderRequestError(provider, "service_unavailable", undefined, true);
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part): part is { text: string } => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || null;
}

function extractOpenAIContent(data: unknown): string | null {
  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  return extractTextContent(content);
}

function logResponseMetadata(provider: ProviderName, data: unknown, requestId?: string): void {
  const typed = data as {
    model?: unknown;
    choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  };
  const choice = typed.choices?.[0];
  const content = choice?.message?.content;
  const normalized = extractTextContent(content);
  logger.info(
    {
      requestId,
      provider,
      returnedModel: typeof typed.model === "string" ? typed.model : undefined,
      choicesCount: Array.isArray(typed.choices) ? typed.choices.length : 0,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
      contentType: Array.isArray(content) ? "array" : typeof content,
      contentLength: normalized?.length ?? 0,
      refusalPresent: typeof choice?.message?.refusal === "string" && choice.message.refusal.length > 0,
      usage: typed.usage && {
        promptTokens: typeof typed.usage.prompt_tokens === "number" ? typed.usage.prompt_tokens : undefined,
        completionTokens: typeof typed.usage.completion_tokens === "number" ? typed.usage.completion_tokens : undefined,
        totalTokens: typeof typed.usage.total_tokens === "number" ? typed.usage.total_tokens : undefined,
      },
    },
    "Provider response metadata",
  );
}

async function ollamaModelInstalled(model: string, requestId?: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${(config.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/$/, "")}/api/tags`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data = await response.json() as { models?: Array<{ name?: unknown; model?: unknown }> };
    return Array.isArray(data.models) && data.models.some((entry) => entry.name === model || entry.model === model);
  } catch (error) {
    logger.info(
      { requestId, provider: "ollama", classification: error instanceof Error && error.name === "AbortError" ? "timeout" : "unavailable" },
      "Ollama model availability check failed",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function chatProvider(
  provider: ProviderName,
  request: ProviderRequest,
  url: string,
  model: string,
  apiKey?: string | null,
): Promise<string | null> {
  if (provider !== "ollama" && !apiKey) return null;
  if (provider === "ollama" && !config.ollamaEnabled) return null;
  if (provider === "ollama" && !(await ollamaModelInstalled(model, request.requestId))) return null;
  try {
    const data = await requestJson(
      provider,
      url,
      {
        method: "POST",
        headers: {
          ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          "Content-Type": "application/json",
          ...(provider === "openrouter"
            ? { "HTTP-Referer": "http://localhost:3000", "X-Title": "sustainableAI" }
            : {}),
        },
        body: JSON.stringify({
          model,
          messages: messages(request, provider === "ollama"),
          stream: false,
          temperature: 0.4,
          max_tokens: 800,
        }),
      },
      request.requestId,
      provider === "ollama" ? config.ollamaTimeoutMs : HOSTED_TIMEOUT_MS,
    );
    if (provider !== "ollama") logResponseMetadata(provider, data, request.requestId);
    return extractOpenAIContent(provider === "ollama" ? { choices: [{ message: { content: (data as { message?: { content?: string } })?.message?.content } }] } : data);
  } catch {
    return null;
  }
}

export function generateWithOpenRouter(request: ProviderRequest): Promise<string | null> {
  return chatProvider("openrouter", request, OPENROUTER_ENDPOINT, OPENROUTER_MODEL, config.openrouterApiKey);
}

export function generateWithHuggingFace(request: ProviderRequest): Promise<string | null> {
  if (!config.hfFreeOnlyEnabled) return Promise.resolve(null);
  return chatProvider("huggingface", request, HUGGINGFACE_ENDPOINT, HUGGINGFACE_MODEL, config.huggingfaceApiKey);
}

export function generateWithOllama(request: ProviderRequest): Promise<string | null> {
  return chatProvider("ollama", request, `${(config.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/$/, "")}/api/chat`, config.ollamaModel || "qwen2.5vl:3b");
}

export function analyzeWithOllama(request: ProviderRequest): Promise<string | null> {
  return chatProvider(
    "ollama",
    request,
    `${(config.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/$/, "")}/api/chat`,
    config.ollamaVisionModel || "qwen2.5vl:3b",
  );
}

export const providerModels = {
  openrouter: OPENROUTER_MODEL,
  huggingface: HUGGINGFACE_MODEL,
  ollama: config.ollamaModel,
  ollamaVision: config.ollamaVisionModel,
} as const;

"""OpenRouter free-model vision provider."""

from __future__ import annotations

import httpx

from config import get_settings
from image_utils import to_base64_data_uri
from .base import (
    BaseVisionProvider,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


class OpenRouterVisionProvider(BaseVisionProvider):
    """Call OpenRouter's OpenAI-compatible multimodal chat endpoint."""

    endpoint = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        timeout_seconds: float = 30.0,
        referer: str = "http://localhost:5173",
        title: str = "sustainableAI",
    ) -> None:
        configuration = get_settings()
        super().__init__("openrouter", timeout_seconds)
        self.api_key = api_key if api_key is not None else configuration.openrouter_api_key
        self.model = model or configuration.openrouter_model
        self.referer = referer
        self.title = title
        self.enabled = bool(self.api_key and self.api_key.strip())

    async def analyze(
        self,
        image_bytes: bytes,
        prompt: str,
        system_prompt: str | None = None,
    ) -> str:
        if not self.api_key:
            raise ProviderUnavailableError("OpenRouter API key is not configured")

        messages = self._system_message(system_prompt)
        messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": to_base64_data_uri(image_bytes)},
                    },
                ],
            }
        )
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": self.referer,
            "X-Title": self.title,
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    self.endpoint,
                    headers=headers,
                    json={"model": self.model, "messages": messages, "stream": False},
                )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError("OpenRouter request timed out") from exc
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError("OpenRouter connection failed") from exc

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 429:
                raise ProviderRateLimitError("OpenRouter rate limit exceeded") from exc
            if status in (408, 504):
                raise ProviderTimeoutError(f"OpenRouter request timed out (HTTP {status})") from exc
            raise ProviderUnavailableError(
                f"OpenRouter request failed with HTTP {status}"
            ) from exc

        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ProviderUnavailableError("OpenRouter returned an invalid response") from exc
        if not isinstance(content, str) or not content.strip():
            raise ProviderUnavailableError("OpenRouter returned an empty response")
        return content.strip()

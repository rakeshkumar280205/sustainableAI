"""Hugging Face Serverless vision provider."""

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


class HuggingFaceVisionProvider(BaseVisionProvider):
    """Call Hugging Face's OpenAI-compatible vision chat endpoint."""

    endpoint = "https://router.huggingface.co/hf-inference/v1/chat/completions"

    def __init__(
        self,
        token: str | None = None,
        model: str | None = None,
        timeout_seconds: float = 45.0,
    ) -> None:
        configuration = get_settings()
        super().__init__("huggingface", timeout_seconds)
        self.token = token if token is not None else configuration.hf_token
        self.model = model or configuration.hf_model
        self.enabled = bool(self.token and self.token.strip())

    async def analyze(
        self,
        image_bytes: bytes,
        prompt: str,
        system_prompt: str | None = None,
    ) -> str:
        if not self.token:
            raise ProviderUnavailableError("Hugging Face token is not configured")

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
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    self.endpoint,
                    headers={
                        "Authorization": f"Bearer {self.token}",
                        "Content-Type": "application/json",
                    },
                    json={"model": self.model, "messages": messages, "stream": False},
                )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError("Hugging Face request timed out") from exc
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError("Hugging Face connection failed") from exc

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 429:
                raise ProviderRateLimitError("Hugging Face rate limit exceeded") from exc
            if status in (408, 504):
                raise ProviderTimeoutError(
                    f"Hugging Face request timed out (HTTP {status})"
                ) from exc
            raise ProviderUnavailableError(
                f"Hugging Face request failed with HTTP {status}"
            ) from exc

        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ProviderUnavailableError("Hugging Face returned an invalid response") from exc
        if not isinstance(content, str) or not content.strip():
            raise ProviderUnavailableError("Hugging Face returned an empty response")
        return content.strip()

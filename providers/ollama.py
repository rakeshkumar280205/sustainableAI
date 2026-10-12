"""Local Ollama vision provider."""

from __future__ import annotations

import httpx

from config import get_settings
from image_utils import to_raw_base64
from .base import (
    BaseVisionProvider,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


class OllamaVisionProvider(BaseVisionProvider):
    """Call a locally running Ollama daemon using its native chat API."""

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        timeout_seconds: float = 60.0,
    ) -> None:
        configuration = get_settings()
        super().__init__("ollama", timeout_seconds)
        self.base_url = (base_url or configuration.ollama_base_url).rstrip("/")
        self.model = model or configuration.ollama_model
        self.endpoint = f"{self.base_url}/api/chat"
        self._health_checked = False
        self.enabled = bool(self.base_url)

    async def health_check(self) -> bool:
        """Check that the Ollama daemon responds on its tags endpoint."""

        try:
            async with httpx.AsyncClient(timeout=min(self.timeout_seconds, 5.0)) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                response.raise_for_status()
                payload = response.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
                raise ProviderUnavailableError("Ollama health response was malformed")
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError("Ollama health check timed out") from exc
        except httpx.HTTPStatusError as exc:
            raise ProviderUnavailableError(
                f"Ollama health check failed with HTTP {exc.response.status_code}"
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError("Ollama health connection failed") from exc
        except ValueError as exc:
            raise ProviderUnavailableError("Ollama health response was not valid JSON") from exc
        self._health_checked = True
        return True

    async def analyze(
        self,
        image_bytes: bytes,
        prompt: str,
        system_prompt: str | None = None,
    ) -> str:
        if not self._health_checked:
            await self.health_check()

        messages: list[dict[str, object]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append(
            {
                "role": "user",
                "content": prompt,
                "images": [to_raw_base64(image_bytes)],
            }
        )

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    self.endpoint,
                    json={"model": self.model, "messages": messages, "stream": False},
                )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError("Ollama request timed out") from exc
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError("Ollama connection failed") from exc

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 429:
                raise ProviderRateLimitError("Ollama rate limit exceeded") from exc
            if status in (408, 504):
                raise ProviderTimeoutError(f"Ollama request timed out (HTTP {status})") from exc
            if status in (400, 404):
                raise ProviderUnavailableError(
                    f"Ollama model may not be available: {self.model}"
                ) from exc
            raise ProviderUnavailableError(
                f"Ollama request failed with HTTP {status}"
            ) from exc

        try:
            content = response.json()["message"]["content"]
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderUnavailableError("Ollama returned an invalid response") from exc
        if not isinstance(content, str) or not content.strip():
            raise ProviderUnavailableError("Ollama returned an empty response")
        return content.strip()

"""Common provider contracts and transport failure types."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class ProviderError(Exception):
    """Base error raised by a vision provider."""


class ProviderRateLimitError(ProviderError):
    """The provider rejected the request because of rate limiting."""


class ProviderUnavailableError(ProviderError):
    """The provider or requested model is unavailable."""


class ProviderTimeoutError(ProviderError):
    """The provider did not respond before its deadline."""


class BaseVisionProvider(ABC):
    """Abstract asynchronous interface implemented by every vision tier."""

    name: str
    timeout_seconds: float

    def __init__(self, name: str, timeout_seconds: float = 30.0) -> None:
        self.name = name
        self.timeout_seconds = timeout_seconds
        self.enabled = True

    @abstractmethod
    async def analyze(
        self,
        image_bytes: bytes,
        prompt: str,
        system_prompt: str | None = None,
    ) -> str:
        """Analyze an image and return the provider's textual response."""

    def _system_message(self, system_prompt: str | None) -> list[dict[str, Any]]:
        if not system_prompt:
            return []
        return [{"role": "system", "content": system_prompt}]

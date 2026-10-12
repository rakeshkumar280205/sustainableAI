"""Sequential, observable, multi-tier vision fallback orchestration."""

from __future__ import annotations

import logging
import time
import asyncio
from pathlib import Path
from typing import Any, Sequence

from image_utils import load_and_preprocess_image
from providers.base import (
    BaseVisionProvider,
    ProviderError,
)

logger = logging.getLogger(__name__)


class AllProvidersFailedError(RuntimeError):
    """Raised when every configured provider fails, with a per-tier audit trail."""

    def __init__(self, audit_trail: list[dict[str, Any]]) -> None:
        self.audit_trail = audit_trail
        summary = "; ".join(
            f"{entry['provider']}: {entry['error']}" for entry in audit_trail
        )
        super().__init__(f"All vision providers failed: {summary}")


class VisionFallbackPipeline:
    """Run an ordered provider chain and fail over on provider errors."""

    def __init__(self, providers: Sequence[BaseVisionProvider]) -> None:
        if not providers:
            raise ValueError("At least one vision provider is required")
        self.providers = [provider for provider in providers if provider.enabled]
        if not self.providers:
            raise ValueError("At least one enabled vision provider is required")

    async def run(
        self,
        image_input: str | bytes | Path,
        prompt: str,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        """Process an image and return the first successful provider response."""

        image_bytes, _ = await load_and_preprocess_image(image_input)
        audit_trail: list[dict[str, Any]] = []

        for tier, provider in enumerate(self.providers, start=1):
            started = time.perf_counter()
            logger.info("Executing vision tier %d: %s", tier, provider.name)
            try:
                response = await provider.analyze(image_bytes, prompt, system_prompt)
            except ProviderError as exc:
                latency = time.perf_counter() - started
                error = f"{type(exc).__name__}: {str(exc)[:300]}"
                audit_trail.append(
                    {
                        "tier": tier,
                        "provider": provider.name,
                        "category": type(exc).__name__,
                        "latency_seconds": round(latency, 4),
                        "error": error,
                    }
                )
                logger.warning(
                    "Vision tier %d failed (%s) after %.3fs; trying next tier: %s",
                    tier,
                    provider.name,
                    latency,
                    error,
                )
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                latency = time.perf_counter() - started
                category = f"Unexpected{type(exc).__name__}"
                error = f"{category}: provider implementation failed"
                audit_trail.append(
                    {
                        "tier": tier,
                        "provider": provider.name,
                        "category": category,
                        "latency_seconds": round(latency, 4),
                        "error": error,
                    }
                )
                logger.error(
                    "Unexpected error in vision tier %d (%s), type=%s; trying next tier",
                    tier,
                    provider.name,
                    type(exc).__name__,
                )
                continue

            latency = time.perf_counter() - started
            logger.info(
                "Vision tier %d succeeded (%s) in %.3fs",
                tier,
                provider.name,
                latency,
            )
            return {
                "status": "success",
                "provider_used": provider.name,
                "latency_seconds": round(latency, 4),
                "response": response,
            }

        raise AllProvidersFailedError(audit_trail)

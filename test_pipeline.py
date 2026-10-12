"""Standalone smoke test for the three-tier vision pipeline.

Run with:
    python test_pipeline.py

The fallback check injects an invalid OpenRouter key only into the provider
instance. It never edits .env or the process environment.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from PIL import Image, ImageDraw

from pipeline import AllProvidersFailedError, VisionFallbackPipeline
from providers import (
    HuggingFaceVisionProvider,
    OllamaVisionProvider,
    OpenRouterVisionProvider,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)


def create_dummy_image(path: Path) -> None:
    """Create a deterministic 400x400 test image with labeled shapes."""

    image = Image.new("RGB", (400, 400), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((35, 35, 175, 175), fill="tomato", outline="black", width=3)
    draw.ellipse((220, 45, 355, 180), fill="gold", outline="black", width=3)
    draw.rectangle((75, 240, 325, 330), fill="green", outline="black", width=3)
    draw.text((145, 185), "food", fill="black")
    image.save(path, format="PNG")


async def run_case(label: str, pipeline: VisionFallbackPipeline, image: Path) -> None:
    """Run one pipeline case and print a concise result."""

    print(f"\n--- {label} ---")
    try:
        result = await pipeline.run(
            image,
            "Identify the visible food ingredients. Return a concise list and explain uncertainty.",
            "You are a careful food ingredient recognition assistant.",
        )
    except AllProvidersFailedError as exc:
        print(f"ALL PROVIDERS FAILED: {exc}")
        for entry in exc.audit_trail:
            print(
                f"  tier={entry['tier']} provider={entry['provider']} "
                f"latency={entry['latency_seconds']:.3f}s error={entry['error']}"
            )
        return

    print(
        f"provider={result['provider_used']} "
        f"latency={result['latency_seconds']:.3f}s"
    )
    print(f"response={result['response']}")


async def main() -> None:
    """Create a test image and exercise normal and forced-fallback paths."""

    image_path = Path(__file__).with_name("dummy_vision_test.png")
    create_dummy_image(image_path)
    try:
        providers = [
            OpenRouterVisionProvider(),
            OllamaVisionProvider(),
            HuggingFaceVisionProvider(),
        ]
        await run_case(
            "normal ordered execution",
            VisionFallbackPipeline(providers),
            image_path,
        )

        await run_case(
            "simulated OpenRouter failure and automatic failover",
            VisionFallbackPipeline(
                [
                    OpenRouterVisionProvider(api_key="invalid-test-key"),
                    OllamaVisionProvider(),
                    HuggingFaceVisionProvider(),
                ]
            ),
            image_path,
        )
    finally:
        image_path.unlink(missing_ok=True)


if __name__ == "__main__":
    asyncio.run(main())

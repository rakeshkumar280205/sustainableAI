"""Deterministic unit tests for the Python vision fallback subsystem."""

from __future__ import annotations

import asyncio
import base64
import io
import unittest
from unittest.mock import patch

import httpx
from PIL import Image, ImageDraw

from image_utils import (
    ImageInputError,
    load_and_preprocess_image,
    to_base64_data_uri,
    to_raw_base64,
)
from pipeline import AllProvidersFailedError, VisionFallbackPipeline
from providers.base import (
    BaseVisionProvider,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from providers.openrouter import OpenRouterVisionProvider
from providers.huggingface import HuggingFaceVisionProvider
from providers.ollama import OllamaVisionProvider


class _Provider(BaseVisionProvider):
    def __init__(self, name: str, result: str | Exception) -> None:
        super().__init__(name)
        self.result = result
        self.calls = 0

    async def analyze(
        self,
        image_bytes: bytes,
        prompt: str,
        system_prompt: str | None = None,
    ) -> str:
        self.calls += 1
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class _FakeStreamResponse:
    def __init__(self, status_code: int, headers: dict[str, str], body: bytes) -> None:
        self.response = httpx.Response(
            status_code,
            headers=headers,
            content=body,
            request=httpx.Request("GET", "http://example.test/image"),
        )

    @property
    def is_redirect(self) -> bool:
        return self.response.is_redirect

    @property
    def status_code(self) -> int:
        return self.response.status_code

    @property
    def headers(self) -> httpx.Headers:
        return self.response.headers

    def raise_for_status(self) -> None:
        self.response.raise_for_status()

    async def aiter_bytes(self):
        yield self.response.content


class _StreamContext:
    def __init__(self, response: _FakeStreamResponse) -> None:
        self.response = response

    async def __aenter__(self) -> _FakeStreamResponse:
        return self.response

    async def __aexit__(self, *args: object) -> None:
        return None


class _FakeClient:
    def __init__(self, response: httpx.Response | _FakeStreamResponse) -> None:
        self.response = response

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    def stream(self, method: str, url: str) -> _StreamContext:
        return _StreamContext(self.response)  # type: ignore[arg-type]

    async def get(self, url: str) -> httpx.Response:
        return self.response  # type: ignore[return-value]

    async def post(self, *args: object, **kwargs: object) -> httpx.Response:
        return self.response  # type: ignore[return-value]


class ImageUtilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_rgba_is_converted_and_resized(self) -> None:
        source = io.BytesIO()
        Image.new("RGBA", (3000, 1000), (255, 0, 0, 128)).save(source, "PNG")
        jpeg, mime = await load_and_preprocess_image(source.getvalue())

        self.assertEqual(mime, "image/jpeg")
        with Image.open(io.BytesIO(jpeg)) as result:
            self.assertEqual(result.mode, "RGB")
            self.assertLessEqual(max(result.size), 2048)

    async def test_remote_urls_are_rejected_before_network_access(self) -> None:
        for source in (
            "http://public.example/image.png",
            "http://127.0.0.1/image.png",
            "http://[::ffff:127.0.0.1]/image.png",
            "file:///tmp/image.png",
            "http://user:password@public.example/image.png",
        ):
            with self.subTest(source=source):
                with self.assertRaises(ImageInputError):
                    await load_and_preprocess_image(source)

    async def test_invalid_image_data_is_rejected(self) -> None:
        with self.assertRaises(ImageInputError):
            await load_and_preprocess_image(b"not-an-image")

    async def test_supported_modes_and_aspect_ratio_are_preserved(self) -> None:
        for mode in ("RGB", "RGBA", "L", "P"):
            with self.subTest(mode=mode):
                image = Image.new(mode, (100, 50))
                if mode == "P":
                    image.putpalette([255, 0, 0] * 256)
                source = io.BytesIO()
                image.save(source, "PNG")
                jpeg, _ = await load_and_preprocess_image(source.getvalue())
                with Image.open(io.BytesIO(jpeg)) as result:
                    self.assertEqual(result.mode, "RGB")
                    self.assertEqual(result.size, (100, 50))

    async def test_exif_orientation_is_applied(self) -> None:
        image = Image.new("RGB", (20, 10), "white")
        ImageDraw.Draw(image).rectangle((0, 0, 4, 9), fill="black")
        exif = image.getexif()
        exif[274] = 6
        source = io.BytesIO()
        image.save(source, "JPEG", exif=exif)

        jpeg, _ = await load_and_preprocess_image(source.getvalue())

        with Image.open(io.BytesIO(jpeg)) as result:
            self.assertEqual(result.size, (10, 20))

    async def test_encodings_have_provider_specific_prefixes(self) -> None:
        payload = b"jpeg"
        data_uri = to_base64_data_uri(payload)
        raw = to_raw_base64(payload)
        self.assertTrue(data_uri.startswith("data:image/jpeg;base64,"))
        self.assertEqual(raw, base64.b64encode(payload).decode("ascii"))
        self.assertNotIn("data:", raw)


class ProviderAndPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_ollama_health_and_model_failures(self) -> None:
        request = httpx.Request("GET", "http://localhost:11434/api/tags")
        healthy = _FakeClient(httpx.Response(200, json={"models": []}, request=request))
        provider = OllamaVisionProvider(base_url="http://localhost:11434", model="vision:test")
        with patch("providers.ollama.httpx.AsyncClient", return_value=healthy):
            self.assertTrue(await provider.health_check())
        self.assertTrue(provider._health_checked)

        missing_model = _FakeClient(
            httpx.Response(
                404,
                request=httpx.Request("POST", "http://localhost:11434/api/chat"),
            )
        )
        with patch("providers.ollama.httpx.AsyncClient", return_value=missing_model):
            with self.assertRaises(ProviderUnavailableError):
                await provider.analyze(b"jpeg", "inspect")

    async def test_ollama_health_timeout_and_connection_errors_are_distinct(self) -> None:
        for error, expected in (
            (httpx.ReadTimeout("slow"), ProviderTimeoutError),
            (httpx.ConnectError("offline"), ProviderUnavailableError),
        ):
            with self.subTest(error=type(error).__name__):
                provider = OllamaVisionProvider(base_url="http://localhost:11434")
                with patch("providers.ollama.httpx.AsyncClient", side_effect=error):
                    with self.assertRaises(expected):
                        await provider.health_check()

    async def test_missing_cloud_credentials_are_filtered(self) -> None:
        openrouter = OpenRouterVisionProvider(api_key="")
        huggingface = HuggingFaceVisionProvider(token="")
        ollama = OllamaVisionProvider(base_url="http://localhost:11434")

        pipeline = VisionFallbackPipeline([openrouter, huggingface, ollama])

        self.assertEqual([provider.name for provider in pipeline.providers], ["ollama"])

    async def test_provider_status_mapping(self) -> None:
        for status, expected in (
            (400, ProviderUnavailableError),
            (401, ProviderUnavailableError),
            (403, ProviderUnavailableError),
            (404, ProviderUnavailableError),
            (408, ProviderTimeoutError),
            (429, ProviderRateLimitError),
            (500, ProviderUnavailableError),
            (502, ProviderUnavailableError),
            (503, ProviderUnavailableError),
            (504, ProviderTimeoutError),
        ):
            with self.subTest(status=status):
                response = httpx.Response(status, request=httpx.Request("POST", "https://example.test"))
                fake_client = _FakeClient(response)
                with patch("providers.openrouter.httpx.AsyncClient", return_value=fake_client):
                    with self.assertRaises(expected):
                        await OpenRouterVisionProvider(api_key="test").analyze(b"jpeg", "inspect")
                with patch("providers.huggingface.httpx.AsyncClient", return_value=fake_client):
                    with self.assertRaises(expected):
                        await HuggingFaceVisionProvider(token="test").analyze(b"jpeg", "inspect")

    async def test_provider_malformed_and_empty_responses_fail_safely(self) -> None:
        for provider, module, kwargs in (
            (OpenRouterVisionProvider(api_key="test"), "providers.openrouter", {}),
            (HuggingFaceVisionProvider(token="test"), "providers.huggingface", {}),
        ):
            with self.subTest(provider=provider.name):
                for payload in ({}, {"choices": []}, {"choices": [{"message": {"content": ""}}]}):
                    response = httpx.Response(
                        200,
                        json=payload,
                        request=httpx.Request("POST", "https://example.test"),
                    )
                    with patch(f"{module}.httpx.AsyncClient", return_value=_FakeClient(response)):
                        with self.assertRaises(ProviderUnavailableError):
                            await provider.analyze(b"jpeg", "inspect")

    async def test_first_success_stops_chain(self) -> None:
        first = _Provider("first", "ok")
        second = _Provider("second", "not-called")
        image = Image.new("RGB", (10, 10), "white")
        buffer = io.BytesIO()
        image.save(buffer, "PNG")

        result = await VisionFallbackPipeline([first, second]).run(buffer.getvalue(), "inspect")

        self.assertEqual(result["provider_used"], "first")
        self.assertEqual(second.calls, 0)

    async def test_all_failures_preserve_order_and_categories(self) -> None:
        image = Image.new("RGB", (10, 10), "white")
        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        providers = [
            _Provider("rate", ProviderRateLimitError("limited")),
            _Provider("timeout", ProviderTimeoutError("slow")),
            _Provider("unexpected", RuntimeError("secret=should-not-be-recorded")),
        ]

        with self.assertRaises(AllProvidersFailedError) as context:
            await VisionFallbackPipeline(providers).run(buffer.getvalue(), "inspect")

        audit = context.exception.audit_trail
        self.assertEqual([entry["provider"] for entry in audit], ["rate", "timeout", "unexpected"])
        self.assertEqual(audit[0]["category"], "ProviderRateLimitError")
        self.assertEqual(audit[1]["category"], "ProviderTimeoutError")
        self.assertEqual(audit[2]["category"], "UnexpectedRuntimeError")
        self.assertNotIn("secret=", str(context.exception))

    async def test_cancellation_propagates(self) -> None:
        image = Image.new("RGB", (10, 10), "white")
        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        provider = _Provider("cancelled", asyncio.CancelledError())

        with self.assertRaises(asyncio.CancelledError):
            await VisionFallbackPipeline([provider]).run(buffer.getvalue(), "inspect")


if __name__ == "__main__":
    unittest.main()

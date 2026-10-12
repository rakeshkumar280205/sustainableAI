"""Image loading, normalization, and provider-specific encoding helpers."""

from __future__ import annotations

import base64
import warnings
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageOps
from PIL import UnidentifiedImageError

MAX_IMAGE_DIMENSION = 2048
MAX_IMAGE_PIXELS = 20_000_000
JPEG_QUALITY = 85


class ImageInputError(ValueError):
    """Raised when an image source is invalid or unsafe to process."""


async def _read_source(source: str | bytes | Path) -> bytes:
    if isinstance(source, bytes):
        return source
    if isinstance(source, Path):
        return source.read_bytes()
    if len(source) >= 2 and source[1] == ":" and source[0].isalpha():
        return Path(source).read_bytes()
    parsed = urlparse(source)
    if parsed.scheme in {"http", "https"}:
        raise ImageInputError(
            "Remote image URLs are disabled; provide local image bytes or a local path"
        )
    if parsed.scheme:
        raise ImageInputError("Only local image paths and image bytes are supported")
    return Path(source).read_bytes()


async def load_and_preprocess_image(source: str | bytes | Path) -> tuple[bytes, str]:
    """Load an image, apply EXIF orientation, resize, and return JPEG bytes."""

    raw_bytes = await _read_source(source)
    try:
        with Image.open(BytesIO(raw_bytes)) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ImageInputError("Image dimensions exceed the pixel limit")
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                image.load()
                oriented = ImageOps.exif_transpose(image)
            normalized = oriented.convert("RGB")
            normalized.thumbnail(
                (MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION),
                Image.Resampling.LANCZOS,
            )
            output = BytesIO()
            normalized.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            return output.getvalue(), "image/jpeg"
    except ImageInputError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImageInputError("Image dimensions are unsafe to decode") from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageInputError("Image data is invalid or unsupported") from exc


def to_base64_data_uri(jpeg_bytes: bytes) -> str:
    """Encode JPEG bytes as a data URI for OpenAI-compatible APIs."""

    encoded = base64.b64encode(jpeg_bytes).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def to_raw_base64(jpeg_bytes: bytes) -> str:
    """Encode JPEG bytes without a data-URI prefix for Ollama."""

    return base64.b64encode(jpeg_bytes).decode("ascii")

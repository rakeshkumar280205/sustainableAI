"""Typed configuration for the multi-provider vision pipeline."""

from functools import lru_cache

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-backed settings for all vision providers."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    openrouter_api_key: str | None = None
    openrouter_model: str = "google/gemma-3-27b-it:free"
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2-vision:latest"
    hf_token: str | None = None
    hf_model: str = "Qwen/Qwen2.5-VL-7B-Instruct"

    @computed_field
    @property
    def openrouter_enabled(self) -> bool:
        """Return whether an OpenRouter credential is configured."""

        return bool(self.openrouter_api_key and self.openrouter_api_key.strip())

    @computed_field
    @property
    def ollama_enabled(self) -> bool:
        """Return whether the local Ollama tier has a configured endpoint."""

        return bool(self.ollama_base_url and self.ollama_base_url.strip())

    @computed_field
    @property
    def huggingface_enabled(self) -> bool:
        """Return whether a Hugging Face token is configured."""

        return bool(self.hf_token and self.hf_token.strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load and cache process configuration."""

    return Settings()


settings = get_settings()

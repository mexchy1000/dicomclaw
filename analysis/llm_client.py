"""OpenRouter LLM client for text and vision queries."""
from __future__ import annotations

import base64
import os
import time
import logging

import requests

logger = logging.getLogger("llm_client")

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
TEXT_MODEL = os.environ.get("OPENROUTER_MODEL", "anthropic/claude-sonnet-4")
VISION_MODEL = os.environ.get("VISION_MODEL", "google/gemini-2.5-flash-preview")


def query_llm(messages: list[dict], model: str | None = None, temperature: float = 0.1, max_tokens: int = 4096) -> str:
    """Send a chat completion request to OpenRouter."""
    if model is None:
        model = TEXT_MODEL
    api_key = API_KEY or os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        return "Error: No OPENROUTER_API_KEY set"

    url = f"{BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/DICOMclaw",
        "X-Title": "DICOMclaw",
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    max_retries = 5
    for attempt in range(max_retries):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            if "choices" not in data or not data["choices"]:
                # API returned 200 but no choices — might be an error payload
                err_msg = data.get("error", {}).get("message", "") if isinstance(data.get("error"), dict) else str(data.get("error", ""))
                logger.warning("API returned no choices: %s", str(data)[:500])
                if attempt < max_retries - 1:
                    time.sleep(5)
                    continue
                return f"API Error: No response from model. {err_msg}"
            content = data["choices"][0]["message"]["content"] or ""
            return content
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            if status == 429 and attempt < max_retries - 1:
                wait = 30
                try:
                    err_data = e.response.json()
                    wait = err_data.get("error", {}).get("metadata", {}).get("retry_after_seconds", 30)
                except Exception:
                    pass
                wait = min(max(wait, 10), 120)
                logger.warning("Rate limited (429), retry %d/%d after %ds", attempt + 1, max_retries, wait)
                time.sleep(wait)
                continue
            error_body = ""
            try:
                error_body = e.response.text[:500]
            except Exception:
                pass
            return f"API Error ({status}): {error_body}"
        except requests.exceptions.Timeout:
            if attempt < max_retries - 1:
                time.sleep(5)
                continue
            return "API Error: Request timed out after retries"
        except Exception as e:
            return f"API Error: {e}"

    return "API Error: Max retries exhausted"


def encode_image(image_path: str) -> str:
    """Base64-encode an image file."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def query_vision(prompt: str, image_paths: list[str], model: str | None = None) -> str:
    """Query a vision model with text prompt and images."""
    if model is None:
        model = VISION_MODEL

    content: list[dict] = [{"type": "text", "text": prompt}]
    for img_path in image_paths:
        if not os.path.exists(img_path):
            continue
        b64 = encode_image(img_path)
        ext = os.path.splitext(img_path)[1].lower()
        mime = "image/png" if ext == ".png" else "image/jpeg"
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"},
        })

    messages = [{"role": "user", "content": content}]
    return query_llm(messages, model=model, temperature=0.1)

import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from inference.app import app

UPSTREAM = "https://speech.example.com"


def _context(model_type_seen):
    async def resolve(api_key, model, model_type="inference", sandbox=False):
        model_type_seen.append(model_type)
        return {
            "deployment": {
                "id": "dep-1",
                "engine": "speaches",
                "endpoint": UPSTREAM,
                "inference_model": "Systran/faster-whisper-tiny" if model == "stt" else None,
                "configuration": {},
            },
            "user_id_context": "u1",
            "org_id": "o1",
        }
    return resolve


@pytest.fixture
def upstream():
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        if request.url.path == "/v1/audio/transcriptions":
            return httpx.Response(200, json={"text": "what is my balance"})
        if request.url.path == "/v1/audio/speech":
            return httpx.Response(200, content=b"RIFFfakewav", headers={"content-type": "audio/wav"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model_types = []
    with patch("inference.core.service.GatewayService.resolve_context", side_effect=_context(model_types)), \
         patch("inference.core.pipeline.api_gateway_client.check_quota", AsyncMock()), \
         patch("inference.core.handlers.audio.RequestLogger.log", AsyncMock()), \
         patch("inference.core.service.http_client.get_client", return_value=client):
        yield seen, model_types


async def _post(path, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://inf") as c:
        return await c.post(path, headers={"Authorization": "Bearer sk-test"}, **kwargs)


@pytest.mark.asyncio
async def test_transcription_forwards_file_and_returns_text(upstream):
    seen, model_types = upstream
    resp = await _post(
        "/v1/audio/transcriptions",
        files={"file": ("q.webm", b"\x1aEfakeaudio", "audio/webm")},
        data={"model": "stt", "language": "en"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"text": "what is my balance"}
    assert model_types == ["audio_generation"]
    sent = seen[0]
    assert str(sent.url) == f"{UPSTREAM}/v1/audio/transcriptions"
    assert sent.headers["content-type"].startswith("multipart/form-data; boundary=")
    body = sent.content
    assert b'name="model"\r\n\r\nSystran/faster-whisper-tiny' in body
    assert b'name="language"\r\n\r\nen' in body
    assert b'filename="q.webm"' in body and b"\x1aEfakeaudio" in body


@pytest.mark.asyncio
async def test_speech_returns_audio_bytes(upstream):
    seen, model_types = upstream
    resp = await _post("/v1/audio/speech", json={"model": "tts", "input": "Your balance is 500", "voice": "af_heart"})

    assert resp.status_code == 200
    assert resp.content == b"RIFFfakewav"
    assert resp.headers["content-type"] == "audio/wav"
    assert model_types == ["audio_generation"]
    assert str(seen[0].url) == f"{UPSTREAM}/v1/audio/speech"
    assert json.loads(seen[0].content) == {"model": "tts", "input": "Your balance is 500", "voice": "af_heart"}


@pytest.mark.asyncio
async def test_transcription_without_file_is_400(upstream):
    resp = await _post("/v1/audio/transcriptions", data={"model": "stt"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_speech_without_input_is_400(upstream):
    resp = await _post("/v1/audio/speech", json={"model": "tts"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_upstream_4xx_is_passed_through(upstream):
    def handler(request):
        return httpx.Response(422, json={"detail": "bad voice"})

    with patch("inference.core.service.http_client.get_client",
               return_value=httpx.AsyncClient(transport=httpx.MockTransport(handler))):
        resp = await _post("/v1/audio/speech", json={"model": "tts", "input": "hi", "voice": "nope"})
    assert resp.status_code == 422

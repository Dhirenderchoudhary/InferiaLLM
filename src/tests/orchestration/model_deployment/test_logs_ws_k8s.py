"""Tests for the k8s branch of the log-streaming WebSocket.

The adapter's own streaming is covered in test_k8s_log_streaming.py. These
cover the endpoint around it: that a k8s subscription reaches the adapter with
the right arguments, that lines are framed the way the dashboard expects, and
that a subscription missing its instance is refused rather than hanging.

The client only names a deployment. What to stream comes from the server-side
stream-info lookup, which also checks the caller's org; it is stubbed here.
"""
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from orchestration.models.model_deployment import deployment_server
from orchestration.provisioning.engine import registry


class FakeAdapter:
    """Records how it was called and replays a fixed set of lines."""

    def __init__(self, lines):
        self._lines = lines
        self.calls = []

    async def stream_logs(self, *, instance, namespace="default", **_):
        self.calls.append({"instance": instance, "namespace": namespace})
        for line in self._lines:
            yield line


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(deployment_server.router, prefix="/v1")
    return app


def _subscribe(instance="inferia-worker-abc", **extra):
    return {
        "type": "subscribe_logs",
        "provider": "k8s",
        "instance": instance,
        **extra,
    }


def _ask(**extra):
    """What the browser sends: a deployment id, plus anything it chooses to add."""
    return {"type": "subscribe_logs", "deployment_id": "d1", **extra}


def _serve(monkeypatch, result):
    """Stub the stream-info lookup; ``result`` is a subscription or an exception."""
    asked = []

    async def _info(deployment_id, request):
        asked.append(deployment_id)
        if isinstance(result, Exception):
            raise result
        if isinstance(result, dict) and result.get("type") == "subscribe_logs":
            return {"subscription": result}
        return result

    monkeypatch.setattr(deployment_server, "get_deployment_log_stream_info", _info)
    return asked


def test_lines_are_framed_as_log_messages(monkeypatch):
    adapter = FakeAdapter(["first", "second"])
    monkeypatch.setattr(registry, "get_adapter", lambda _p: adapter)
    _serve(monkeypatch, _subscribe())

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json(_ask())
        assert ws.receive_json() == {"type": "log", "data": "first"}
        assert ws.receive_json() == {"type": "log", "data": "second"}


def test_adapter_gets_the_instance_and_namespace(monkeypatch):
    adapter = FakeAdapter(["x"])
    monkeypatch.setattr(registry, "get_adapter", lambda _p: adapter)
    _serve(monkeypatch, _subscribe(instance="sts-1", namespace="models"))

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json(_ask())
        ws.receive_json()

    assert adapter.calls == [{"instance": "sts-1", "namespace": "models"}]


def test_namespace_defaults_when_absent(monkeypatch):
    adapter = FakeAdapter(["x"])
    monkeypatch.setattr(registry, "get_adapter", lambda _p: adapter)
    _serve(monkeypatch, _subscribe())

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json(_ask())
        ws.receive_json()

    assert adapter.calls[0]["namespace"] == "default"


def test_missing_instance_is_refused(monkeypatch):
    adapter = FakeAdapter(["never sent"])
    monkeypatch.setattr(registry, "get_adapter", lambda _p: adapter)
    _serve(monkeypatch, {"type": "subscribe_logs", "provider": "k8s"})

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json(_ask())
        message = ws.receive_json()

    assert message["type"] == "error"
    assert "instance" in message["message"].lower()
    assert adapter.calls == []


def test_first_message_must_be_a_subscription(monkeypatch):
    monkeypatch.setattr(registry, "get_adapter", lambda _p: FakeAdapter([]))

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json({"type": "something_else"})
        message = ws.receive_json()

    assert message["type"] == "error"


def test_adapter_failure_is_reported_not_swallowed(monkeypatch):
    class Failing:
        async def stream_logs(self, **_):
            raise RuntimeError("no pod found for sts-1 in default")
            yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(registry, "get_adapter", lambda _p: Failing())
    _serve(monkeypatch, _subscribe())

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json(_ask())
        message = ws.receive_json()

    assert message["type"] == "error"
    assert "no pod found" in message["message"]


def test_names_the_client_sends_are_ignored(monkeypatch):
    adapter = FakeAdapter(["x"])
    monkeypatch.setattr(registry, "get_adapter", lambda _p: adapter)
    asked = _serve(monkeypatch, _subscribe(instance="sts-1"))

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json(_ask(provider="k8s", instance="someone-elses-pod",
                          namespace="kube-system"))
        ws.receive_json()

    assert asked == ["d1"]
    assert adapter.calls == [{"instance": "sts-1", "namespace": "default"}]


def test_a_deployment_the_caller_cannot_see_is_refused(monkeypatch):
    adapter = FakeAdapter(["never sent"])
    monkeypatch.setattr(registry, "get_adapter", lambda _p: adapter)
    _serve(monkeypatch, HTTPException(status_code=404, detail="Deployment/Pool not found"))

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json(_ask(provider="k8s", instance="someone-elses-pod"))
        message = ws.receive_json()

    assert message == {"type": "error", "message": "Deployment not found"}
    assert adapter.calls == []


def test_a_deployment_with_nothing_to_stream_says_why(monkeypatch):
    adapter = FakeAdapter(["never sent"])
    monkeypatch.setattr(registry, "get_adapter", lambda _p: adapter)
    _serve(monkeypatch, {"error": "No nodes assigned to this deployment yet."})

    with TestClient(_app()).websocket_connect("/v1/deployment/ws") as ws:
        ws.send_json(_ask())
        message = ws.receive_json()

    assert message == {"type": "error",
                       "message": "No nodes assigned to this deployment yet."}
    assert adapter.calls == []

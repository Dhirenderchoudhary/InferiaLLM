"""Module-level singleton state for the model_cache service.

Mirrors the ``nodes_api.configure`` pattern: callers call ``configure(...)``
once at startup to inject dependencies; route handlers call ``get(name)``
to retrieve them.  ``_reset()`` is a test helper that clears state between
test cases.
"""
from __future__ import annotations

_state: dict = {}


def configure(
    *,
    repo=None,
    paths=None,
    settings=None,
    http_client=None,
    downloader=None,
    eviction=None,
) -> None:
    """Inject dependencies into the module singleton.

    Only non-``None`` values overwrite existing state, so partial
    reconfiguration is safe.
    """
    _state.update(
        {
            k: v
            for k, v in dict(
                repo=repo,
                paths=paths,
                settings=settings,
                http_client=http_client,
                downloader=downloader,
                eviction=eviction,
            ).items()
            if v is not None
        }
    )


def get(name: str):
    """Return the dependency registered under *name*, or ``None``."""
    return _state.get(name)


def egress_allowed(settings=None) -> bool:
    """Whether this install may reach huggingface.co and registry.ollama.ai.

    Pass *settings* to ask about an explicitly injected object rather than the
    configured singleton. True for a settings object without the field, so an
    install that never sets it keeps the connected behaviour.
    """
    s = settings if settings is not None else _state.get("settings")
    return bool(getattr(s, "model_egress", True))


def _reset() -> None:
    """Clear all state.  **Test helper only — do not call in production.**"""
    _state.clear()

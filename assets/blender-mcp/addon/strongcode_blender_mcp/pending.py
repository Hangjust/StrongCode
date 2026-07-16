from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .protocol import JsonObject, JsonValue


@dataclass(slots=True)  # noqa: MUTABLE_OK
class PendingCall:  # noqa: MUTABLE_OK
    """Mutable handoff from the socket worker to Blender's main-thread timer."""

    operation: str
    payload: JsonObject
    completed: threading.Event = field(default_factory=threading.Event)
    result: JsonValue = None
    error: str | None = None
    cancelled: bool = False
    started: bool = False
    state_lock: threading.Lock = field(default_factory=threading.Lock)

from __future__ import annotations

import os
import types
from pathlib import Path
from typing import Final

from .runtime import ListenerRuntime


bl_info = {
    "name": "StrongCode Blender MCP",
    "author": "StrongCode",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "Preferences > Add-ons",
    "description": "Authenticated local StrongCode MCP bridge",
    "category": "Interface",
}

TIMER_INTERVAL_SECONDS: Final = 0.05
PROFILE_ENV: Final = "STRONGCODE_BLENDER_MCP_PROFILE"
_runtime: ListenerRuntime | None = None


def _profile_path(bpy_module: types.ModuleType) -> Path:
    configured = os.environ.get(PROFILE_ENV)
    if configured:
        return Path(configured).resolve()
    return Path(bpy_module.utils.user_resource(
        "CONFIG", path="strongcode_blender_mcp", create=True
    )).resolve()


def _timer() -> float:
    global _runtime
    import bpy

    if _runtime is None:
        from .operations import BlenderOperations
        _runtime = ListenerRuntime(_profile_path(bpy), BlenderOperations(bpy))
        _runtime.start()
    _runtime.pump()
    return TIMER_INTERVAL_SECONDS


def register() -> None:
    import bpy

    if bpy.app.background or bpy.app.timers.is_registered(_timer):
        return
    bpy.app.timers.register(_timer, first_interval=0.1, persistent=True)


def unregister() -> None:
    global _runtime
    import bpy

    if bpy.app.timers.is_registered(_timer):
        bpy.app.timers.unregister(_timer)
    if _runtime is not None:
        _runtime.stop()
        _runtime = None

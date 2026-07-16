from __future__ import annotations

import base64
import contextlib
import io
import tempfile
import traceback
import types
from dataclasses import dataclass
from itertools import islice
from pathlib import Path
from typing import Final

from .protocol import JsonObject, JsonValue, canonical_json


MAX_CODE_BYTES: Final = 64 * 1024
MAX_CAPTURE_BYTES: Final = 64 * 1024
MAX_EMITTED_TEXT_BYTES: Final = 1024
MAX_OPERATION_RESULT_BYTES: Final = 6 * 1024 * 1024
MAX_SCREENSHOT_BYTES: Final = 4 * 1024 * 1024
MAX_SCREENSHOT_WIDTH: Final = 1920
MAX_SCREENSHOT_HEIGHT: Final = 1080
MAX_SCENE_OBJECTS: Final = 1000
EXECUTE_BLENDER_CODE_WARNING: Final = (
    "This tool executes unsandboxed Python inside Blender. Only run trusted code."
)


@dataclass(frozen=True, slots=True)
class OperationInputError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class OperationExecutionError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


class BoundedWriter(io.TextIOBase):
    """Collects execution output without allowing unbounded memory growth."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._parts: list[str] = []
        self._size = 0

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        encoded = text.encode("utf-8")
        remaining = self._limit - self._size
        if remaining > 0:
            accepted = encoded[:remaining].decode("utf-8", errors="ignore")
            self._parts.append(accepted)
            self._size += len(accepted.encode("utf-8"))
        return len(text)

    def value(self) -> str:
        return "".join(self._parts)


def bounded_utf8(text: str, limit: int = MAX_EMITTED_TEXT_BYTES) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text
    return encoded[:limit].decode("utf-8", errors="ignore")


class BlenderOperations:
    def __init__(self, bpy_module: types.ModuleType) -> None:
        self._bpy = bpy_module

    def dispatch(self, operation: str, payload: JsonObject) -> JsonValue:
        match operation:  # noqa: MATCH_OK
            case "get_scene_info":
                result = self._scene_info(payload)
            case "get_object_info":
                result = self._object_info(payload)
            case "get_viewport_screenshot":
                result = self._viewport_screenshot(payload)
            case "execute_blender_code":
                result = self._execute_code(payload)
            case _:
                raise OperationInputError(reason="unsupported operation")
        if len(canonical_json(result)) > MAX_OPERATION_RESULT_BYTES:
            raise OperationExecutionError(reason="operation result exceeds size limit")
        return result

    def _scene_info(self, payload: JsonObject) -> JsonObject:
        if payload:
            raise OperationInputError(reason="get_scene_info takes no input")
        scene = self._bpy.context.scene
        total_objects = len(scene.objects)
        objects = [self._object_summary(item) for item in islice(scene.objects, MAX_SCENE_OBJECTS)]
        return {
            "name": bounded_utf8(scene.name),
            "frame": scene.frame_current,
            "frameStart": scene.frame_start,
            "frameEnd": scene.frame_end,
            "renderEngine": bounded_utf8(scene.render.engine),
            "objects": objects,
            "totalObjects": total_objects,
            "truncated": total_objects > MAX_SCENE_OBJECTS,
        }

    def _object_info(self, payload: JsonObject) -> JsonObject:
        if set(payload) != {"name"}:
            raise OperationInputError(reason="get_object_info requires only name")
        name = payload.get("name")
        if not isinstance(name, str) or not name or len(name.encode("utf-8")) > 256:
            raise OperationInputError(reason="object name is invalid")
        item = self._bpy.data.objects.get(name)
        if item is None:
            raise OperationInputError(reason=f"object not found: {name}")
        result = self._object_summary(item)
        if item.type == "MESH":
            result["mesh"] = {
                "vertices": len(item.data.vertices),
                "polygons": len(item.data.polygons),
                "materials": len(item.data.materials),
            }
        return result

    @staticmethod
    def _object_summary(item: types.SimpleNamespace) -> JsonObject:
        return {
            "name": bounded_utf8(item.name),
            "type": bounded_utf8(item.type),
            "location": list(item.location),
            "rotation": list(item.rotation_euler),
            "scale": list(item.scale),
            "visible": not item.hide_viewport,
        }

    def _viewport_screenshot(self, payload: JsonObject) -> JsonObject:
        if not set(payload).issubset({"width", "height"}):
            raise OperationInputError(reason="screenshot input fields are invalid")
        width = payload.get("width", 800)
        height = payload.get("height", 600)
        if (
            not isinstance(width, int) or isinstance(width, bool)
            or not isinstance(height, int) or isinstance(height, bool)
            or not 64 <= width <= MAX_SCREENSHOT_WIDTH
            or not 64 <= height <= MAX_SCREENSHOT_HEIGHT
        ):
            raise OperationInputError(reason="screenshot dimensions are out of bounds")
        scene = self._bpy.context.scene
        render = scene.render
        previous = (
            render.filepath,
            render.resolution_x,
            render.resolution_y,
            render.resolution_percentage,
            render.image_settings.file_format,
        )
        with tempfile.TemporaryDirectory(prefix="strongcode-blender-") as directory:
            path = Path(directory) / "viewport.png"
            try:
                render.filepath = str(path)
                render.resolution_x = width
                render.resolution_y = height
                render.resolution_percentage = 100
                render.image_settings.file_format = "PNG"
                self._render_viewport()
                image = path.read_bytes()
            finally:
                (
                    render.filepath,
                    render.resolution_x,
                    render.resolution_y,
                    render.resolution_percentage,
                    render.image_settings.file_format,
                ) = previous
        if len(image) > MAX_SCREENSHOT_BYTES:
            raise OperationExecutionError(reason="viewport screenshot exceeds size limit")
        result: JsonObject = {
            "mimeType": "image/png",
            "width": width,
            "height": height,
            "data": base64.b64encode(image).decode("ascii"),
        }
        return result

    def _render_viewport(self) -> None:
        context = self._bpy.context
        for window in context.window_manager.windows:
            for area in window.screen.areas:
                if area.type != "VIEW_3D":
                    continue
                region = next((item for item in area.regions if item.type == "WINDOW"), None)
                if region is None:
                    continue
                with context.temp_override(window=window, area=area, region=region):
                    self._bpy.ops.render.opengl(write_still=True, view_context=True)
                return
        raise OperationExecutionError(reason="no visible 3D viewport is available")

    def _execute_code(self, payload: JsonObject) -> JsonObject:
        if set(payload) != {"code"}:
            raise OperationInputError(reason="execute_blender_code requires only code")
        code = payload.get("code")
        if not isinstance(code, str) or len(code.encode("utf-8")) > MAX_CODE_BYTES:
            raise OperationInputError(reason="code is empty or exceeds the size limit")
        stdout = BoundedWriter(MAX_CAPTURE_BYTES)
        stderr = BoundedWriter(MAX_CAPTURE_BYTES)
        namespace = {"__name__": "__strongcode_blender_exec__", "bpy": self._bpy}
        try:
            compiled = compile(code, "<strongcode-blender-code>", "exec")
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exec(compiled, namespace, namespace)
        except Exception as error:  # noqa: BROAD_EXCEPT_OK
            detail = "".join(traceback.format_exception_only(type(error), error)).strip()
            raise OperationExecutionError(reason=detail[:4096]) from error
        return {"stdout": stdout.value(), "stderr": stderr.value(), "warning": EXECUTE_BLENDER_CODE_WARNING}

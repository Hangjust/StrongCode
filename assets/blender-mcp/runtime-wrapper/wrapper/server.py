from __future__ import annotations

import argparse
import importlib.metadata
import json
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Callable
from typing import Final, Protocol

from .client import BlenderClient
from .protocol import JsonObject, JsonValue


TOOLS_SENTINEL: Final = "__STRONGCODE_BLENDER_TOOLS_V1__"
PINNED_MCP_VERSION: Final = "1.28.1"
MAX_MCP_RESULT_BYTES: Final = 6 * 1024 * 1024
BLENDER_TOOLS: Final = (
    "get_scene_info",
    "get_object_info",
    "get_viewport_screenshot",
    "execute_blender_code",
)


@dataclass(frozen=True, slots=True)
class SdkVersionError(Exception):
    installed: str

    def __str__(self) -> str:
        return f"MCP SDK {PINNED_MCP_VERSION} is required; found {self.installed}"


@dataclass(frozen=True, slots=True)
class ResultSizeError(Exception):
    size: int

    def __str__(self) -> str:
        return f"serialized MCP result exceeds {MAX_MCP_RESULT_BYTES} bytes: {self.size}"


def require_pinned_sdk() -> None:
    installed = importlib.metadata.version("mcp")
    if installed != PINNED_MCP_VERSION:
        raise SdkVersionError(installed=installed)


class McpServer(Protocol):
    def tool(self) -> Callable[[Callable[..., str]], Callable[..., str]]: ...

    def run(self, transport: str = "stdio") -> None: ...


def _call(config_path: Path, operation: str, payload: JsonObject) -> str:
    with BlenderClient(config_path) as client:
        result: JsonValue = client.request(operation, payload)
    serialized = json.dumps(result, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    size = len(serialized.encode("utf-8"))
    if size > MAX_MCP_RESULT_BYTES:
        raise ResultSizeError(size=size)
    return serialized


def build_server(config_path: Path) -> McpServer:
    require_pinned_sdk()
    from mcp.server.fastmcp import FastMCP

    server = FastMCP("StrongCode Blender MCP", log_level="ERROR")

    @server.tool()
    def get_scene_info() -> str:
        """Return the current Blender scene and object summary."""
        return _call(config_path, "get_scene_info", {})

    @server.tool()
    def get_object_info(object_name: str) -> str:
        """Return transform and mesh metadata for one named Blender object."""
        return _call(config_path, "get_object_info", {"name": object_name})

    @server.tool()
    def get_viewport_screenshot(width: int = 800, height: int = 600) -> str:
        """Capture the active 3D viewport as a bounded base64 PNG."""
        return _call(config_path, "get_viewport_screenshot", {"width": width, "height": height})

    @server.tool()
    def execute_blender_code(code: str) -> str:
        """Execute trusted Python in Blender. This operation is unsandboxed."""
        return _call(config_path, "execute_blender_code", {"code": code})

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="StrongCode Blender MCP stdio wrapper")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args(argv)
    if arguments.self_test:
        print(f"{TOOLS_SENTINEL}{json.dumps(BLENDER_TOOLS, separators=(',', ':'))}")
        return 0
    if arguments.config is None:
        parser.error("--config is required")
    build_server(arguments.config.resolve()).run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

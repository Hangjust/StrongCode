from __future__ import annotations

import contextlib
import importlib
import importlib.metadata
import io
import json
import sys
import types
import unittest
from pathlib import Path


ASSET_ROOT = Path(__file__).resolve().parents[2] / "assets" / "blender-mcp"
RUNTIME_WRAPPER_ROOT = ASSET_ROOT / "runtime-wrapper"
sys.path.insert(0, str(ASSET_ROOT / "addon"))


class Vector(list[float]):
    pass


class FakeObject:
    def __init__(self, name: str, object_type: str = "MESH") -> None:
        self.name = name
        self.type = object_type
        self.location = Vector([1.0, 2.0, 3.0])
        self.rotation_euler = Vector([0.1, 0.2, 0.3])
        self.scale = Vector([1.0, 1.0, 1.0])
        self.hide_viewport = False
        self.data = types.SimpleNamespace(vertices=[1, 2], polygons=[1], materials=[1])


class FakeTimers:
    def __init__(self) -> None:
        self.callback = None

    def register(self, callback, **_kwargs) -> None:
        self.callback = callback

    def unregister(self, callback) -> None:
        if self.callback is callback:
            self.callback = None

    def is_registered(self, callback) -> bool:
        return self.callback is callback


def fake_bpy(
    background: bool = False,
    objects: list[FakeObject] | None = None,
    image: bytes = b"PNG fixture",
) -> types.ModuleType:
    module = types.ModuleType("bpy")
    timers = FakeTimers()
    cube = FakeObject("Cube")
    scene_objects = [cube] if objects is None else objects
    render = types.SimpleNamespace(
        engine="BLENDER_EEVEE_NEXT",
        filepath="before.png",
        resolution_x=320,
        resolution_y=240,
        resolution_percentage=50,
        image_settings=types.SimpleNamespace(file_format="JPEG"),
    )
    scene = types.SimpleNamespace(
        name="Scene",
        frame_current=1,
        frame_start=1,
        frame_end=250,
        render=render,
        objects=scene_objects,
    )
    module.app = types.SimpleNamespace(background=background, timers=timers)
    region = types.SimpleNamespace(type="WINDOW")
    area = types.SimpleNamespace(type="VIEW_3D", regions=[region])
    window = types.SimpleNamespace(screen=types.SimpleNamespace(areas=[area]))

    @contextlib.contextmanager
    def temp_override(**_kwargs):
        yield

    module.context = types.SimpleNamespace(
        scene=scene,
        window_manager=types.SimpleNamespace(windows=[window]),
        temp_override=temp_override,
    )

    def render_viewport(**_kwargs) -> None:
        Path(render.filepath).write_bytes(image)

    module.ops = types.SimpleNamespace(render=types.SimpleNamespace(opengl=render_viewport))
    module.utils = types.SimpleNamespace(user_resource=lambda *_args, **_kwargs: "unused")
    module.data = types.SimpleNamespace(objects={"Cube": cube})
    return module


class OperationAndLifecycleTests(unittest.TestCase):
    def tearDown(self) -> None:
        for name in list(sys.modules):
            if name == "strongcode_blender_mcp" or name.startswith("strongcode_blender_mcp."):
                del sys.modules[name]
        sys.modules.pop("bpy", None)

    def test_scene_and_object_operations_read_bpy_data(self) -> None:
        # Given
        bpy = fake_bpy()
        sys.modules["bpy"] = bpy
        operations = importlib.import_module("strongcode_blender_mcp.operations")
        dispatcher = operations.BlenderOperations(bpy)

        # When
        scene = dispatcher.dispatch("get_scene_info", {})
        cube = dispatcher.dispatch("get_object_info", {"name": "Cube"})

        # Then
        self.assertEqual(scene["name"], "Scene")
        self.assertEqual(scene["objects"][0]["name"], "Cube")
        self.assertEqual(cube["mesh"], {"vertices": 2, "polygons": 1, "materials": 1})

    def test_execute_code_is_bounded_and_explicitly_unsandboxed(self) -> None:
        # Given
        bpy = fake_bpy()
        sys.modules["bpy"] = bpy
        operations = importlib.import_module("strongcode_blender_mcp.operations")
        dispatcher = operations.BlenderOperations(bpy)

        # When
        result = dispatcher.dispatch("execute_blender_code", {"code": "print(bpy.context.scene.name)"})

        # Then
        self.assertEqual(result["stdout"], "Scene\n")
        self.assertIn("unsandboxed", operations.EXECUTE_BLENDER_CODE_WARNING.lower())
        with self.assertRaises(operations.OperationInputError):
            dispatcher.dispatch("execute_blender_code", {"code": "x" * (operations.MAX_CODE_BYTES + 1)})

        multibyte = dispatcher.dispatch(
            "execute_blender_code",
            {"code": f"print('é' * {operations.MAX_CAPTURE_BYTES})"},
        )
        self.assertLessEqual(len(multibyte["stdout"].encode("utf-8")), operations.MAX_CAPTURE_BYTES)

    def test_scene_info_caps_objects_and_utf8_strings(self) -> None:
        # Given
        objects = [FakeObject(f"Object-{index}-" + "é" * 3000) for index in range(1001)]
        for item in objects:
            item.type = "界" * 3000
        bpy = fake_bpy(objects=objects)
        bpy.context.scene.name = "界" * 3000
        bpy.context.scene.render.engine = "é" * 3000
        sys.modules["bpy"] = bpy
        operations = importlib.import_module("strongcode_blender_mcp.operations")

        # When
        result = operations.BlenderOperations(bpy).dispatch("get_scene_info", {})

        # Then
        self.assertEqual(len(result["objects"]), 1000)
        self.assertEqual(result["totalObjects"], 1001)
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["name"].encode("utf-8")), operations.MAX_EMITTED_TEXT_BYTES)
        self.assertTrue(all(
            len(item["name"].encode("utf-8")) <= operations.MAX_EMITTED_TEXT_BYTES
            for item in result["objects"]
        ))
        serialized = json.dumps(result, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        self.assertLessEqual(len(serialized.encode("utf-8")), operations.MAX_OPERATION_RESULT_BYTES)

    def test_viewport_screenshot_is_bounded_and_restores_render_settings(self) -> None:
        # Given
        bpy = fake_bpy()
        sys.modules["bpy"] = bpy
        operations = importlib.import_module("strongcode_blender_mcp.operations")
        dispatcher = operations.BlenderOperations(bpy)
        before = (
            bpy.context.scene.render.filepath,
            bpy.context.scene.render.resolution_x,
            bpy.context.scene.render.resolution_y,
            bpy.context.scene.render.resolution_percentage,
            bpy.context.scene.render.image_settings.file_format,
        )

        # When
        screenshot = dispatcher.dispatch("get_viewport_screenshot", {"width": 640, "height": 480})

        # Then
        self.assertEqual(screenshot["mimeType"], "image/png")
        self.assertEqual(screenshot["width"], 640)
        self.assertEqual(screenshot["height"], 480)
        self.assertEqual((
            bpy.context.scene.render.filepath,
            bpy.context.scene.render.resolution_x,
            bpy.context.scene.render.resolution_y,
            bpy.context.scene.render.resolution_percentage,
            bpy.context.scene.render.image_settings.file_format,
        ), before)
        with self.assertRaises(operations.OperationInputError):
            dispatcher.dispatch("get_viewport_screenshot", {"width": 4000, "height": 480})

    def test_screenshot_serialized_result_stays_within_operation_budget(self) -> None:
        # Given
        sys.modules["bpy"] = fake_bpy(image=b"x" * (4 * 1024 * 1024))
        operations = importlib.import_module("strongcode_blender_mcp.operations")

        # When
        result = operations.BlenderOperations(sys.modules["bpy"]).dispatch(
            "get_viewport_screenshot", {"width": 800, "height": 600}
        )

        # Then
        serialized = json.dumps(result, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        self.assertLessEqual(len(serialized.encode("utf-8")), operations.MAX_OPERATION_RESULT_BYTES)

        sys.modules["bpy"] = fake_bpy(image=b"x" * (operations.MAX_SCREENSHOT_BYTES + 1))
        with self.assertRaises(operations.OperationExecutionError):
            operations.BlenderOperations(sys.modules["bpy"]).dispatch(
                "get_viewport_screenshot", {"width": 800, "height": 600}
            )

    def test_wrapper_rejects_oversized_final_serialized_result(self) -> None:
        # Given
        sys.path.insert(0, str(RUNTIME_WRAPPER_ROOT))
        wrapper_server = importlib.import_module("wrapper.server")

        class OversizedClient:
            def __init__(self, _config_path: Path) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                pass

            def request(self, _operation: str, _payload: dict[str, object]) -> str:
                return "x" * (wrapper_server.MAX_MCP_RESULT_BYTES + 1)

        original = wrapper_server.BlenderClient
        wrapper_server.BlenderClient = OversizedClient

        # When / Then
        try:
            with self.assertRaises(wrapper_server.ResultSizeError):
                wrapper_server._call(Path("config.json"), "get_scene_info", {})
        finally:
            wrapper_server.BlenderClient = original

    def test_wrapper_registers_exactly_four_tools(self) -> None:
        # Given
        registered: list[str] = []

        class FakeFastMCP:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            def tool(self):
                def decorate(function):
                    registered.append(function.__name__)
                    return function
                return decorate

        mcp = types.ModuleType("mcp")
        server_package = types.ModuleType("mcp.server")
        fastmcp = types.ModuleType("mcp.server.fastmcp")
        fastmcp.FastMCP = FakeFastMCP
        sys.modules["mcp"] = mcp
        sys.modules["mcp.server"] = server_package
        sys.modules["mcp.server.fastmcp"] = fastmcp
        sys.path.insert(0, str(RUNTIME_WRAPPER_ROOT))
        wrapper_server = importlib.import_module("wrapper.server")

        # When
        original_version = importlib.metadata.version
        importlib.metadata.version = lambda name: "1.28.1" if name == "mcp" else original_version(name)
        try:
            wrapper_server.build_server(Path("config.json"))
        finally:
            importlib.metadata.version = original_version

        # Then
        self.assertEqual(registered, list(wrapper_server.BLENDER_TOOLS))

    def test_wrapper_rejects_an_unpinned_mcp_sdk(self) -> None:
        # Given
        sys.path.insert(0, str(RUNTIME_WRAPPER_ROOT))
        wrapper_server = importlib.import_module("wrapper.server")
        original_version = importlib.metadata.version
        importlib.metadata.version = lambda name: "9.9.9" if name == "mcp" else original_version(name)

        # When / Then
        try:
            with self.assertRaises(wrapper_server.SdkVersionError):
                wrapper_server.require_pinned_sdk()
        finally:
            importlib.metadata.version = original_version

    def test_wrapper_self_test_uses_installer_sentinel(self) -> None:
        # Given
        sys.path.insert(0, str(RUNTIME_WRAPPER_ROOT))
        wrapper_server = importlib.import_module("wrapper.server")
        output = io.StringIO()

        # When
        with contextlib.redirect_stdout(output):
            result = wrapper_server.main(["--self-test"])

        # Then
        self.assertEqual(result, 0)
        self.assertEqual(
            output.getvalue(),
            '__STRONGCODE_BLENDER_TOOLS_V1__["get_scene_info","get_object_info",'
            '"get_viewport_screenshot","execute_blender_code"]\n',
        )

    def test_register_uses_timer_only_for_gui_and_unregister_cleans_it(self) -> None:
        # Given
        bpy = fake_bpy()
        sys.modules["bpy"] = bpy
        addon = importlib.import_module("strongcode_blender_mcp")

        # When
        addon.register()

        # Then
        self.assertIsNotNone(bpy.app.timers.callback)
        addon.unregister()
        self.assertIsNone(bpy.app.timers.callback)

    def test_register_does_not_start_in_background_mode(self) -> None:
        # Given
        bpy = fake_bpy(background=True)
        sys.modules["bpy"] = bpy
        addon = importlib.import_module("strongcode_blender_mcp")

        # When
        addon.register()

        # Then
        self.assertIsNone(bpy.app.timers.callback)


if __name__ == "__main__":
    unittest.main()

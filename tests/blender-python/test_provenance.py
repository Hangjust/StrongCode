from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path


ASSET_ROOT = Path(__file__).resolve().parents[2] / "assets" / "blender-mcp"
WORKSPACE_ROOT = ASSET_ROOT.parents[1]
RUNTIME_WRAPPER_ROOT = ASSET_ROOT / "runtime-wrapper"


class ProvenanceTests(unittest.TestCase):
    def test_derivative_manifest_hashes_every_bundled_python_asset(self) -> None:
        # Given
        provenance = json.loads((ASSET_ROOT / "provenance.json").read_text(encoding="utf-8"))
        expected_paths = sorted(
            path.relative_to(ASSET_ROOT).as_posix()
            for path in ASSET_ROOT.rglob("*.py")
            if "__pycache__" not in path.parts and "official-derivative" not in path.parts
        )

        # When
        derivatives = sorted(provenance["derivatives"], key=lambda item: item["path"])

        # Then
        self.assertEqual([item["path"] for item in derivatives], expected_paths)
        for derivative in derivatives:
            content = (ASSET_ROOT / derivative["path"]).read_bytes()
            self.assertEqual(derivative["sha256"], hashlib.sha256(content).hexdigest())
            self.assertEqual(derivative["licensePath"], "LICENSE")

    def test_official_manifest_hashes_authenticated_derivative_python_assets(self) -> None:
        # Given
        root = ASSET_ROOT / "official-derivative"
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        expected = {
            "connection.py": manifest["assets"]["connectionSha256"],
            "strongcode_auth.py": manifest["assets"]["authenticationSha256"],
        }

        # When / Then
        self.assertEqual(sorted(path.name for path in root.glob("*.py")), sorted(expected))
        for filename, digest in expected.items():
            self.assertEqual(hashlib.sha256((root / filename).read_bytes()).hexdigest(), digest)

    def test_runtime_wrapper_directory_contains_only_runtime_assets(self) -> None:
        # Given / When
        children = sorted(path.name for path in RUNTIME_WRAPPER_ROOT.iterdir())

        # Then
        self.assertEqual(children, ["strongcode-blender-wrapper.py", "wrapper"])
        self.assertTrue((RUNTIME_WRAPPER_ROOT / "wrapper" / "server.py").is_file())

    def test_assets_and_tests_contain_no_generated_python_bytecode(self) -> None:
        # Given / When
        generated = sorted(
            path.relative_to(WORKSPACE_ROOT).as_posix()
            for root in (WORKSPACE_ROOT / "assets", WORKSPACE_ROOT / "tests")
            for path in root.rglob("*")
            if path.name == "__pycache__" or path.suffix == ".pyc"
        )

        # Then
        self.assertEqual(generated, [])


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import socket
import struct
import sys
import unittest
from pathlib import Path


ASSET_ROOT = Path(__file__).resolve().parents[2] / "assets" / "blender-mcp"
sys.path.insert(0, str(ASSET_ROOT / "addon"))
sys.path.insert(0, str(ASSET_ROOT / "runtime-wrapper"))

from strongcode_blender_mcp import protocol as addon_protocol  # noqa: E402
from wrapper import protocol as wrapper_protocol  # noqa: E402


class ProtocolTests(unittest.TestCase):
    def test_canonical_json_matches_both_protocol_peers(self) -> None:
        # Given
        value = {"z": [3, True, None], "a": "snowman: \u2603"}

        # When
        addon_bytes = addon_protocol.canonical_json(value)
        wrapper_bytes = wrapper_protocol.canonical_json(value)

        # Then
        self.assertEqual(addon_bytes, wrapper_bytes)
        self.assertEqual(addon_bytes, b'{"a":"snowman: \\u2603","z":[3,true,null]}')

    def test_protocol_peer_sources_are_identical(self) -> None:
        # Given
        addon_root = ASSET_ROOT / "addon" / "strongcode_blender_mcp"
        wrapper_root = ASSET_ROOT / "runtime-wrapper" / "wrapper"

        # When / Then
        for filename in ("protocol.py", "channel.py"):
            self.assertEqual((addon_root / filename).read_bytes(), (wrapper_root / filename).read_bytes())

    def test_receive_frame_rejects_oversized_length_before_body(self) -> None:
        # Given
        sender, receiver = socket.socketpair()
        self.addCleanup(sender.close)
        self.addCleanup(receiver.close)
        sender.sendall(struct.pack(">I", addon_protocol.MAX_FRAME_BYTES + 1))

        # When / Then
        with self.assertRaises(addon_protocol.FrameError):
            addon_protocol.receive_frame(receiver)

    def test_receive_frame_rejects_noncanonical_json(self) -> None:
        # Given
        sender, receiver = socket.socketpair()
        self.addCleanup(sender.close)
        self.addCleanup(receiver.close)
        payload = b'{"z": 1, "a": 2}'
        sender.sendall(struct.pack(">I", len(payload)) + payload)

        # When / Then
        with self.assertRaises(addon_protocol.FrameError):
            addon_protocol.receive_frame(receiver)

    def test_secure_channel_rejects_replayed_sequence(self) -> None:
        # Given
        sender, receiver = socket.socketpair()
        self.addCleanup(sender.close)
        self.addCleanup(receiver.close)
        key = b"k" * 32
        outgoing = wrapper_protocol.SecureChannel(sender, key, "session")
        incoming = addon_protocol.SecureChannel(receiver, key, "session")
        outgoing.send("request", "get_scene_info", {})
        frame = wrapper_protocol.receive_frame(receiver)
        wrapper_protocol.send_frame(sender, frame)
        wrapper_protocol.send_frame(sender, frame)

        # When
        incoming.receive("request")

        # Then
        with self.assertRaises(addon_protocol.AuthenticationError):
            incoming.receive("request")

    def test_secure_channel_rejects_tampered_payload_mac(self) -> None:
        # Given
        sender, receiver = socket.socketpair()
        self.addCleanup(sender.close)
        self.addCleanup(receiver.close)
        channel = wrapper_protocol.SecureChannel(sender, b"s" * 32, "session")
        channel.send("request", "get_object_info", {"name": "Cube"})
        frame = wrapper_protocol.receive_frame(receiver)
        frame["payload"] = {"name": "Camera"}
        wrapper_protocol.send_frame(sender, frame)

        # When / Then
        verifier = addon_protocol.SecureChannel(receiver, b"s" * 32, "session")
        with self.assertRaises(addon_protocol.AuthenticationError):
            verifier.receive("request")


if __name__ == "__main__":
    unittest.main()

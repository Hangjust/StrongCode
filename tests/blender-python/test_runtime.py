from __future__ import annotations

import base64
import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock


ASSET_ROOT = Path(__file__).resolve().parents[2] / "assets" / "blender-mcp"
sys.path.insert(0, str(ASSET_ROOT / "addon"))
sys.path.insert(0, str(ASSET_ROOT / "runtime-wrapper"))

from strongcode_blender_mcp.protocol import receive_frame, send_frame  # noqa: E402
from strongcode_blender_mcp import runtime as runtime_module  # noqa: E402
from strongcode_blender_mcp.runtime import ListenerRuntime, ProfileBusyError  # noqa: E402
from wrapper.client import BlenderClient, RemoteOperationError  # noqa: E402
from wrapper.protocol import (  # noqa: E402
    AuthenticationError as ClientAuthenticationError,
    Credential,
    server_authenticate,
)


class RecordingDispatcher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def dispatch(self, operation: str, payload: dict[str, object]) -> object:
        self.calls.append((operation, payload))
        return {"operation": operation, "payload": payload}


def write_config(profile: Path, secret: bytes = b"x" * 32) -> None:
    profile.mkdir()
    encoded = base64.urlsafe_b64encode(secret).decode("ascii").rstrip("=")
    (profile / "config.json").write_text(
        json.dumps({"schemaVersion": 1, "profileId": "test-profile", "secret": encoded}),
        encoding="utf-8",
    )


class RuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.profile = Path(self.temporary.name) / "profile"
        write_config(self.profile)
        self.dispatcher = RecordingDispatcher()
        self.runtime = ListenerRuntime(self.profile, self.dispatcher)
        self.runtime.start()
        self.addCleanup(self.runtime.stop)

    def test_listener_uses_ephemeral_loopback_and_private_rendezvous(self) -> None:
        # Given / When
        rendezvous_path = self.profile / "rendezvous.json"
        rendezvous = json.loads(rendezvous_path.read_text(encoding="utf-8"))

        # Then
        self.assertEqual(self.runtime.endpoint[0], "127.0.0.1")
        self.assertNotEqual(self.runtime.endpoint[1], 9876)
        self.assertEqual(rendezvous["port"], self.runtime.endpoint[1])
        self.assertNotIn("host", rendezvous)
        self.assertEqual(rendezvous["profileId"], "test-profile")
        self.assertNotIn("secret", rendezvous)

    def test_authenticated_client_dispatches_after_mutual_confirmation(self) -> None:
        # Given
        result: list[object] = []
        errors: list[BaseException] = []
        complete = threading.Event()

        def call() -> None:
            try:
                with BlenderClient(self.profile) as client:
                    result.append(client.request("get_scene_info", {}))
            except BaseException as error:
                errors.append(error)
            finally:
                complete.set()

        worker = threading.Thread(target=call)
        worker.start()

        # When
        deadline = time.monotonic() + 3.0
        while not complete.wait(0.01) and time.monotonic() < deadline:
            self.runtime.pump()
        worker.join(timeout=1.0)

        # Then
        self.assertTrue(complete.is_set(), "authenticated request did not complete")
        self.assertEqual(errors, [])
        self.assertEqual(result, [{"operation": "get_scene_info", "payload": {}}])
        self.assertEqual(self.dispatcher.calls, [("get_scene_info", {})])

    def test_authentication_failure_closes_before_dispatch(self) -> None:
        # Given
        connection = socket.create_connection(self.runtime.endpoint, timeout=1.0)
        self.addCleanup(connection.close)
        send_frame(connection, {
            "operation": "auth.client_hello",
            "protocol": 1,
            "sessionId": self.runtime.session_id,
            "profileId": "test-profile",
            "clientNonce": "00" * 32,
            "proof": "00" * 32,
        })

        # When
        with self.assertRaises(EOFError):
            receive_frame(connection)

        # Then
        self.assertEqual(self.dispatcher.calls, [])

    def test_second_runtime_cannot_own_same_profile_lock(self) -> None:
        # Given
        second = ListenerRuntime(self.profile, RecordingDispatcher())

        # When / Then
        with self.assertRaises(ProfileBusyError):
            second.start()

    def test_rendezvous_write_failure_fully_unwinds_startup(self) -> None:
        # Given
        self.runtime.stop()
        failed = ListenerRuntime(self.profile, RecordingDispatcher())

        # When
        with mock.patch.object(runtime_module, "atomic_write_json", side_effect=OSError("write failed")):
            with self.assertRaises(OSError):
                failed.start()

        # Then
        self._assert_failed_start_unwound(failed)
        replacement = ListenerRuntime(self.profile, RecordingDispatcher())
        replacement.start()
        self.addCleanup(replacement.stop)

    def test_socket_creation_failure_fully_unwinds_startup(self) -> None:
        # Given
        self.runtime.stop()
        failed = ListenerRuntime(self.profile, RecordingDispatcher())

        # When
        with mock.patch.object(runtime_module.socket, "socket", side_effect=OSError("socket failed")):
            with self.assertRaises(OSError):
                failed.start()

        # Then
        self._assert_failed_start_unwound(failed)
        replacement = ListenerRuntime(self.profile, RecordingDispatcher())
        replacement.start()
        self.addCleanup(replacement.stop)

    def test_worker_start_failure_fully_unwinds_startup(self) -> None:
        # Given
        self.runtime.stop()
        failed = ListenerRuntime(self.profile, RecordingDispatcher())

        # When
        with mock.patch.object(runtime_module.threading, "Thread") as thread:
            thread.return_value.start.side_effect = RuntimeError("thread failed")
            with self.assertRaises(RuntimeError):
                failed.start()

        # Then
        self._assert_failed_start_unwound(failed)
        replacement = ListenerRuntime(self.profile, RecordingDispatcher())
        replacement.start()
        self.addCleanup(replacement.stop)

    def test_stalled_unauthenticated_peer_does_not_consume_operational_slot(self) -> None:
        # Given
        stalled = socket.create_connection(self.runtime.endpoint, timeout=1.0)
        self.addCleanup(stalled.close)
        result: list[object] = []
        errors: list[BaseException] = []
        complete = threading.Event()

        def call() -> None:
            try:
                with BlenderClient(self.profile) as client:
                    result.append(client.request("get_scene_info", {}))
            except BaseException as error:
                errors.append(error)
            finally:
                complete.set()

        worker = threading.Thread(target=call)
        worker.start()

        # When
        deadline = time.monotonic() + 3.0
        while not complete.wait(0.01) and time.monotonic() < deadline:
            self.runtime.pump()
        worker.join(timeout=1.0)

        # Then
        self.assertTrue(complete.is_set(), "authenticated client was blocked by a stalled handshake")
        self.assertEqual(errors, [])
        self.assertEqual(result, [{"operation": "get_scene_info", "payload": {}}])

    def test_second_concurrent_client_is_rejected_while_first_stays_usable(self) -> None:
        # Given
        first = BlenderClient(self.profile)
        first.__enter__()
        self.addCleanup(first.__exit__, None, None, None)
        second = BlenderClient(self.profile)

        # When / Then
        try:
            second.__enter__()
            with self.assertRaises((EOFError, OSError)):
                second.request("get_scene_info", {})
        finally:
            second.__exit__(None, None, None)

        result: list[object] = []
        errors: list[BaseException] = []
        complete = threading.Event()

        def call() -> None:
            try:
                result.append(first.request("get_scene_info", {}))
            except BaseException as error:
                errors.append(error)
            finally:
                complete.set()

        worker = threading.Thread(target=call)
        worker.start()

        deadline = time.monotonic() + 3.0
        while not complete.wait(0.01) and time.monotonic() < deadline:
            self.runtime.pump()
        worker.join(timeout=1.0)

        self.assertTrue(complete.is_set(), "first client stopped responding")
        self.assertEqual(errors, [])
        self.assertEqual(result, [{"operation": "get_scene_info", "payload": {}}])

    def test_stop_closes_an_active_authentication_connection(self) -> None:
        # Given
        connection = socket.create_connection(self.runtime.endpoint, timeout=1.0)
        connection.settimeout(2.0)
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            with self.runtime._connections_lock:
                if self.runtime._connections:
                    break
            threading.Event().wait(0.01)

        # When
        self.runtime.stop()

        # Then
        try:
            received = connection.recv(1)
        except ConnectionResetError:
            received = b""
        connection.close()
        self.assertEqual(received, b"")

    def test_stop_does_not_leave_a_connection_accepted_during_shutdown(self) -> None:
        # Given
        self.runtime.stop()
        runtime = ListenerRuntime(self.profile, RecordingDispatcher())
        runtime._credential = runtime_module.Credential(profile_id="test-profile", secret=b"x" * 32)
        runtime.session_id = "44" * 32
        accepted, peer = socket.socketpair()
        self.addCleanup(peer.close)
        allow_accept = threading.Event()
        accept_started = threading.Event()

        class DeferredListener:
            def accept(self):
                accept_started.set()
                allow_accept.wait(1.0)
                return accepted, ("127.0.0.1", 1)

            def close(self) -> None:
                return

        runtime._listener = DeferredListener()
        serve_thread = threading.Thread(target=runtime._serve)

        class JoinGate:
            def join(self) -> None:
                allow_accept.set()
                serve_thread.join()

        runtime._worker = JoinGate()
        serve_thread.start()
        self.assertTrue(accept_started.wait(1.0))

        # When
        runtime.stop()

        # Then
        with runtime._connections_lock:
            self.assertEqual(runtime._connections, set())
            self.assertEqual(runtime._connection_threads, set())
        peer.settimeout(1.0)
        self.assertEqual(peer.recv(1), b"")

    def test_client_closes_socket_when_server_authentication_fails(self) -> None:
        # Given
        self.runtime.stop()
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        peer_closed: list[bool] = []
        rendezvous = {
            "schemaVersion": 1,
            "protocol": 1,
            "port": listener.getsockname()[1],
            "pid": 1,
            "profileId": "test-profile",
            "sessionId": "22" * 32,
        }
        (self.profile / "rendezvous.json").write_text(json.dumps(rendezvous), encoding="utf-8")

        def reject_client() -> None:
            connection, _address = listener.accept()
            with connection:
                receive_frame(connection)
                send_frame(connection, {
                    "operation": "auth.server_challenge",
                    "serverNonce": "11" * 32,
                    "proof": "00" * 32,
                })
                connection.settimeout(2.0)
                peer_closed.append(connection.recv(1) == b"")

        worker = threading.Thread(target=reject_client)
        worker.start()

        # When / Then
        with self.assertRaises(ClientAuthenticationError):
            with BlenderClient(self.profile):
                self.fail("authentication unexpectedly succeeded")
        worker.join(timeout=3.0)
        listener.close()
        self.assertEqual(peer_closed, [True])

    def test_started_dispatch_is_not_reported_timed_out_before_completion(self) -> None:
        # Given
        self.runtime.stop()
        started = threading.Event()
        release = threading.Event()

        class BlockingDispatcher:
            def dispatch(self, operation: str, payload: dict[str, object]) -> object:
                started.set()
                release.wait(1.0)
                return {"operation": operation, "payload": payload}

        runtime = ListenerRuntime(self.profile, BlockingDispatcher())
        runtime.start()
        self.addCleanup(runtime.stop)
        original_timeout = runtime_module.REQUEST_TIMEOUT_SECONDS
        runtime_module.REQUEST_TIMEOUT_SECONDS = 0.05
        self.addCleanup(setattr, runtime_module, "REQUEST_TIMEOUT_SECONDS", original_timeout)
        complete = threading.Event()
        result: list[object] = []

        def call() -> None:
            try:
                with BlenderClient(self.profile) as client:
                    result.append(client.request("get_scene_info", {}))
            finally:
                complete.set()

        client_thread = threading.Thread(target=call)
        client_thread.start()
        deadline = time.monotonic() + 1.0
        while runtime._pending.empty() and time.monotonic() < deadline:
            threading.Event().wait(0.01)
        pump_thread = threading.Thread(target=runtime.pump)
        pump_thread.start()
        self.assertTrue(started.wait(1.0))

        # When
        threading.Event().wait(0.1)

        # Then
        self.assertFalse(complete.is_set())
        release.set()
        pump_thread.join(timeout=1.0)
        client_thread.join(timeout=1.0)
        self.assertEqual(result, [{"operation": "get_scene_info", "payload": {}}])

    def test_stop_retains_profile_lock_until_started_dispatch_finishes(self) -> None:
        # Given
        self.runtime.stop()
        started = threading.Event()
        release = threading.Event()
        stop_complete = threading.Event()

        class BlockingDispatcher:
            def dispatch(self, operation: str, payload: dict[str, object]) -> object:
                started.set()
                release.wait(2.0)
                return {"operation": operation, "payload": payload}

        runtime = ListenerRuntime(self.profile, BlockingDispatcher())
        runtime.start()
        client_thread = threading.Thread(target=self._request_ignoring_disconnect)
        client_thread.start()
        deadline = time.monotonic() + 1.0
        while runtime._pending.empty() and time.monotonic() < deadline:
            threading.Event().wait(0.01)
        pump_thread = threading.Thread(target=runtime.pump)
        pump_thread.start()
        self.assertTrue(started.wait(1.0))

        def stop() -> None:
            runtime.stop()
            stop_complete.set()

        stop_thread = threading.Thread(target=stop)
        stop_thread.start()

        # When / Then
        threading.Event().wait(0.1)
        self.assertFalse(stop_complete.is_set())
        with self.assertRaises(ProfileBusyError):
            ListenerRuntime(self.profile, RecordingDispatcher()).start()
        release.set()
        pump_thread.join(timeout=1.0)
        client_thread.join(timeout=1.0)
        stop_thread.join(timeout=1.0)
        self.assertTrue(stop_complete.is_set())

    def test_queued_timeout_is_cancelled_before_dispatch(self) -> None:
        # Given
        original_timeout = runtime_module.REQUEST_TIMEOUT_SECONDS
        runtime_module.REQUEST_TIMEOUT_SECONDS = 0.05
        self.addCleanup(setattr, runtime_module, "REQUEST_TIMEOUT_SECONDS", original_timeout)
        complete = threading.Event()
        errors: list[BaseException] = []

        def call() -> None:
            try:
                with BlenderClient(self.profile) as client:
                    client.request("execute_blender_code", {"code": "print('late')"})
            except BaseException as error:
                errors.append(error)
            finally:
                complete.set()

        worker = threading.Thread(target=call)
        worker.start()

        # When
        self.assertTrue(complete.wait(1.0))
        worker.join(timeout=1.0)
        handled = self.runtime.pump()

        # Then
        self.assertEqual(handled, 0)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], RemoteOperationError)
        self.assertEqual(self.dispatcher.calls, [])

    def _request_ignoring_disconnect(self) -> None:
        try:
            with BlenderClient(self.profile) as client:
                client.request("get_scene_info", {})
        except (ClientAuthenticationError, EOFError, OSError):
            return

    def _assert_failed_start_unwound(self, runtime: ListenerRuntime) -> None:
        self.assertIsNone(runtime._listener)
        self.assertIsNone(runtime._worker)
        self.assertIsNone(runtime._credential)
        self.assertEqual(runtime.endpoint, ("127.0.0.1", 0))
        self.assertEqual(runtime.session_id, "")
        self.assertFalse((self.profile / "rendezvous.json").exists())

    def test_request_mac_failure_disconnects_before_context_exit(self) -> None:
        # Given
        self.runtime.stop()
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        session_id = "33" * 32
        rendezvous = {
            "schemaVersion": 1,
            "protocol": 1,
            "port": listener.getsockname()[1],
            "pid": 1,
            "profileId": "test-profile",
            "sessionId": session_id,
        }
        (self.profile / "rendezvous.json").write_text(json.dumps(rendezvous), encoding="utf-8")
        peer_closed: list[bool] = []

        def corrupt_response() -> None:
            connection, _address = listener.accept()
            with connection:
                channel = server_authenticate(
                    connection, Credential(profile_id="test-profile", secret=b"x" * 32), session_id
                )
                channel.receive("request")
                send_frame(connection, {
                    "direction": "response",
                    "operation": "get_scene_info",
                    "payload": {"ok": True, "result": {}},
                    "sequence": 1,
                    "sessionId": session_id,
                    "mac": "00" * 32,
                })
                connection.settimeout(2.0)
                peer_closed.append(connection.recv(1) == b"")

        worker = threading.Thread(target=corrupt_response)
        worker.start()
        client = BlenderClient(self.profile)
        client.__enter__()

        # When / Then
        with self.assertRaises(ClientAuthenticationError):
            client.request("get_scene_info", {})
        self.assertIsNone(client._connection)
        worker.join(timeout=3.0)
        listener.close()
        self.assertEqual(peer_closed, [True])


if __name__ == "__main__":
    unittest.main()

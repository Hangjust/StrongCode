from __future__ import annotations

import os
import queue
import secrets
import socket
import threading
from pathlib import Path
from typing import Final, Protocol

from .pending import PendingCall
from .profile import ProfileBusyError, ProfileLock, atomic_write_json, load_credential
from .protocol import (
    AuthenticationError,
    FrameError,
    Credential,
    JsonObject,
    JsonValue,
    SecureChannel,
    server_authenticate,
)


LOOPBACK: Final = "127.0.0.1"
REQUEST_TIMEOUT_SECONDS: Final = 180.0
SOCKET_TIMEOUT_SECONDS: Final = 190.0
MAX_CONNECTIONS: Final = 1
MAX_HANDSHAKES: Final = 4
SUPPORTED_OPERATIONS: Final = frozenset({
    "get_scene_info",
    "get_object_info",
    "get_viewport_screenshot",
    "execute_blender_code",
})


class Dispatcher(Protocol):
    def dispatch(self, operation: str, payload: JsonObject) -> JsonValue: ...

class ListenerRuntime:
    """Owns one profile-locked listener and a main-thread dispatch queue."""

    def __init__(self, profile_path: Path, dispatcher: Dispatcher) -> None:
        self._profile_path = profile_path
        self._dispatcher = dispatcher
        self._lock = ProfileLock(profile_path / "profile.lock")
        self._listener: socket.socket | None = None
        self._worker: threading.Thread | None = None
        self._stopping = threading.Event()
        self._pending: queue.Queue[PendingCall] = queue.Queue(maxsize=8)
        self._handshake_slots = threading.BoundedSemaphore(MAX_HANDSHAKES)
        self._connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self._connections: set[socket.socket] = set()
        self._connection_threads: set[threading.Thread] = set()
        self._connections_lock = threading.Lock()
        self._credential: Credential | None = None
        self.session_id = ""
        self.endpoint = (LOOPBACK, 0)

    def start(self) -> None:
        if self._listener is not None:
            return
        credential = load_credential(self._profile_path / "config.json")
        self._lock.acquire()
        listener: socket.socket | None = None
        rendezvous = self._profile_path / "rendezvous.json"
        started = False
        try:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind((LOOPBACK, 0))
            listener.listen(MAX_HANDSHAKES)
            listener.settimeout(0.25)
            self._credential = credential
            self._listener = listener
            self.endpoint = (LOOPBACK, listener.getsockname()[1])
            self.session_id = secrets.token_hex(32)
            atomic_write_json(rendezvous, {
                "schemaVersion": 1,
                "protocol": 1,
                "port": self.endpoint[1],
                "pid": os.getpid(),
                "profileId": credential.profile_id,
                "sessionId": self.session_id,
            })
            self._worker = threading.Thread(target=self._serve, name="strongcode-blender-mcp", daemon=True)
            self._worker.start()
            started = True
        finally:
            if not started:
                try:
                    rendezvous.unlink(missing_ok=True)
                finally:
                    try:
                        if listener is not None:
                            listener.close()
                    finally:
                        self._credential = None
                        self._listener = None
                        self._worker = None
                        self.endpoint = (LOOPBACK, 0)
                        self.session_id = ""
                        self._lock.release()

    def _serve(self) -> None:
        listener = self._listener
        if listener is None:
            return
        while not self._stopping.is_set():
            try:
                connection, address = listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            if self._stopping.is_set():
                connection.close()
                return
            if address[0] != LOOPBACK:
                connection.close()
                continue
            if not self._handshake_slots.acquire(blocking=False):
                connection.close()
                continue
            thread = threading.Thread(
                target=self._run_connection,
                args=(connection,),
                name="strongcode-blender-client",
                daemon=True,
            )
            with self._connections_lock:
                self._connections.add(connection)
                self._connection_threads.add(thread)
            try:
                thread.start()
            except RuntimeError:
                with self._connections_lock:
                    self._connections.discard(connection)
                    self._connection_threads.discard(thread)
                connection.close()
                self._handshake_slots.release()

    def _run_connection(self, connection: socket.socket) -> None:
        handshake_held = True
        operational_slot = False
        try:
            with connection:
                credential = self._credential
                if credential is None:
                    return
                try:
                    channel = server_authenticate(connection, credential, self.session_id)
                except (AuthenticationError, FrameError, EOFError, TimeoutError, OSError):
                    return
                if not self._connection_slots.acquire(blocking=False):
                    return
                operational_slot = True
                self._handshake_slots.release()
                handshake_held = False
                self._serve_connection(connection, channel)
        finally:
            with self._connections_lock:
                self._connections.discard(connection)
                self._connection_threads.discard(threading.current_thread())
            if operational_slot:
                self._connection_slots.release()
            if handshake_held:
                self._handshake_slots.release()

    def _serve_connection(self, connection: socket.socket, channel: SecureChannel) -> None:
        connection.settimeout(SOCKET_TIMEOUT_SECONDS)
        while not self._stopping.is_set():
            try:
                operation, payload = channel.receive("request")
            except (AuthenticationError, FrameError, EOFError, TimeoutError, OSError):
                return
            if operation not in SUPPORTED_OPERATIONS:
                return
            call = PendingCall(operation=operation, payload=payload)
            try:
                self._pending.put(call, timeout=1.0)
            except queue.Full:
                channel.send("response", operation, {"ok": False, "error": "dispatch queue is full"})
                continue
            if not call.completed.wait(REQUEST_TIMEOUT_SECONDS):
                with call.state_lock:
                    timed_out = not call.started
                    call.cancelled = timed_out
                if timed_out:
                    channel.send("response", operation, {"ok": False, "error": "operation timed out"})
                    continue
                call.completed.wait()
            response: JsonObject = {"ok": call.error is None}
            if call.error is None:
                response["result"] = call.result
            else:
                response["error"] = call.error[:4096]
            try:
                channel.send("response", operation, response)
            except (FrameError, TimeoutError, OSError):
                return

    def pump(self) -> int:
        handled = 0
        while handled < 4:
            try:
                call = self._pending.get_nowait()
            except queue.Empty:
                return handled
            with call.state_lock:
                if call.cancelled:
                    continue
                call.started = True
            try:  # Blender operation failures must cross the socket boundary as data.
                call.result = self._dispatcher.dispatch(call.operation, call.payload)
            except Exception as error:  # noqa: BROAD_EXCEPT_OK
                call.error = f"{type(error).__name__}: {error}"
            finally:
                call.completed.set()
            handled += 1
        return handled

    def stop(self) -> None:
        self._stopping.set()
        listener = self._listener
        self._listener = None
        if listener is not None:
            listener.close()
        worker = self._worker
        if worker is not None and worker is not threading.current_thread():
            worker.join()
        self._worker = None
        with self._connections_lock:
            connections = tuple(self._connections)
            connection_threads = tuple(self._connection_threads)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                connection.close()
            else:
                connection.close()
        while True:
            try:
                call = self._pending.get_nowait()
            except queue.Empty:
                break
            with call.state_lock:
                if call.started:
                    continue
                call.cancelled = True
                call.error = "runtime stopped"
                call.completed.set()
        for thread in connection_threads:
            if thread is not threading.current_thread():
                thread.join()
        rendezvous = self._profile_path / "rendezvous.json"
        try:
            rendezvous.unlink(missing_ok=True)
        finally:
            self._lock.release()


__all__ = ["ListenerRuntime", "ProfileBusyError"]

from __future__ import annotations

import json
import os
import socket
import stat
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from .protocol import (
    AuthenticationError,
    Credential,
    FrameError,
    JsonObject,
    JsonValue,
    SecureChannel,
    client_authenticate,
)


LOOPBACK: Final = "127.0.0.1"
CONNECT_TIMEOUT_SECONDS: Final = 5.0
REQUEST_TIMEOUT_SECONDS: Final = 180.0


@dataclass(frozen=True, slots=True)
class ClientConfigError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class RemoteOperationError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


def _load_json(path: Path) -> JsonObject:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        info = os.fstat(descriptor)
        path_info = path.lstat()
    except OSError:
        os.close(descriptor)
        raise
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(path_info.st_mode)
        or (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)
    ):
        os.close(descriptor)
        raise ClientConfigError(reason=f"path must be a regular non-symlink file: {path}")
    if sys.platform != "win32" and stat.S_IMODE(info.st_mode) & 0o077:
        os.close(descriptor)
        raise ClientConfigError(reason=f"file permissions must be 0600: {path}")
    try:
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ClientConfigError(reason=f"invalid JSON file {path}: {error}") from error
    if not isinstance(value, dict):
        raise ClientConfigError(reason=f"JSON file must contain an object: {path}")
    return value


def _load_credential(path: Path) -> Credential:
    value = _load_json(path)
    profile_id = value.get("profileId")
    encoded = value.get("secret")
    if set(value) != {"schemaVersion", "profileId", "secret"} or value.get("schemaVersion") != 1:
        raise ClientConfigError(reason="private config fields are invalid")
    if not isinstance(profile_id, str) or not profile_id or not isinstance(encoded, str):
        raise ClientConfigError(reason="private config identity is invalid")
    import base64

    try:
        secret = base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
    except (ValueError, base64.binascii.Error) as error:
        raise ClientConfigError(reason="private config secret is invalid") from error
    if len(secret) != 32:
        raise ClientConfigError(reason="private config secret must be 32 bytes")
    if base64.urlsafe_b64encode(secret).decode("ascii").rstrip("=") != encoded:
        raise ClientConfigError(reason="private config secret is not canonical")
    return Credential(profile_id=profile_id, secret=secret)


class BlenderClient:
    def __init__(self, config_or_profile: Path) -> None:
        self._config_path = (
            config_or_profile / "config.json" if config_or_profile.is_dir() else config_or_profile
        )
        self._connection: socket.socket | None = None
        self._channel: SecureChannel | None = None
        self._request_lock = threading.Lock()

    def __enter__(self) -> "BlenderClient":
        credential = _load_credential(self._config_path)
        rendezvous = _load_json(self._config_path.parent / "rendezvous.json")
        if set(rendezvous) != {"schemaVersion", "protocol", "port", "pid", "profileId", "sessionId"}:
            raise ClientConfigError(reason="rendezvous fields are invalid")
        port = rendezvous.get("port")
        pid = rendezvous.get("pid")
        session_id = rendezvous.get("sessionId")
        if (
            rendezvous.get("schemaVersion") != 1
            or rendezvous.get("protocol") != 1
            or rendezvous.get("profileId") != credential.profile_id
            or not isinstance(port, int)
            or isinstance(port, bool)
            or not 1 <= port <= 65535
            or not isinstance(pid, int)
            or isinstance(pid, bool)
            or pid <= 0
            or not isinstance(session_id, str)
            or len(session_id) != 64
        ):
            raise ClientConfigError(reason="rendezvous values are invalid")
        try:
            bytes.fromhex(session_id)
        except ValueError as error:
            raise ClientConfigError(reason="rendezvous session is invalid") from error
        connection = socket.create_connection((LOOPBACK, port), timeout=CONNECT_TIMEOUT_SECONDS)
        try:
            channel = client_authenticate(connection, credential, session_id)
        except (AuthenticationError, FrameError, EOFError, OSError):
            connection.close()
            raise
        connection.settimeout(REQUEST_TIMEOUT_SECONDS)
        self._connection = connection
        self._channel = channel
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self._disconnect()

    def _disconnect(self) -> None:
        connection = self._connection
        self._connection = None
        self._channel = None
        if connection is not None:
            connection.close()

    def request(self, operation: str, payload: JsonObject) -> JsonValue:
        channel = self._channel
        if channel is None:
            raise ClientConfigError(reason="client is not connected")
        try:
            with self._request_lock:
                channel.send("request", operation, payload)
                response_operation, response = channel.receive("response")
        except (AuthenticationError, FrameError, EOFError, TimeoutError, OSError):
            self._disconnect()
            raise
        if response_operation != operation:
            raise ClientConfigError(reason="response operation mismatch")
        if response.get("ok") is not True:
            error = response.get("error")
            raise RemoteOperationError(reason=error if isinstance(error, str) else "Blender operation failed")
        return response.get("result")

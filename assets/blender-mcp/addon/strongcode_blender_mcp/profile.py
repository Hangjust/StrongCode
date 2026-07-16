from __future__ import annotations

import base64
import json
import os
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .protocol import Credential, JsonObject


@dataclass(frozen=True, slots=True)
class ProfileConfigError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class ProfileBusyError(Exception):
    path: Path

    def __str__(self) -> str:
        return f"Blender MCP profile is already owned: {self.path}"


def _open_regular(path: Path, flags: int, mode: int = 0o600) -> int:
    try:
        descriptor = os.open(path, flags, mode)
    except OSError as error:
        raise ProfileConfigError(reason=f"cannot open private profile file: {error}") from error
    try:
        info = os.fstat(descriptor)
        path_info = path.lstat()
    except OSError as error:
        os.close(descriptor)
        raise ProfileConfigError(reason=f"cannot inspect private profile file: {error}") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(path_info.st_mode)
        or (info.st_dev, info.st_ino) != (path_info.st_dev, path_info.st_ino)
    ):
        os.close(descriptor)
        raise ProfileConfigError(reason="private profile file must be regular and non-symlinked")
    return descriptor


def load_credential(config_path: Path) -> Credential:
    descriptor = _open_regular(config_path, os.O_RDONLY)
    info = os.fstat(descriptor)
    if sys.platform != "win32" and stat.S_IMODE(info.st_mode) & 0o077:
        os.close(descriptor)
        raise ProfileConfigError(reason="private config permissions must be 0600")
    try:
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProfileConfigError(reason=f"invalid private config: {error}") from error
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "profileId", "secret"}:
        raise ProfileConfigError(reason="private config fields are invalid")
    profile_id = value.get("profileId")
    encoded = value.get("secret")
    if value.get("schemaVersion") != 1 or not isinstance(profile_id, str) or not profile_id:
        raise ProfileConfigError(reason="private config identity is invalid")
    if not isinstance(encoded, str):
        raise ProfileConfigError(reason="private config secret is invalid")
    try:
        secret = base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
    except (ValueError, base64.binascii.Error) as error:
        raise ProfileConfigError(reason="private config secret is invalid") from error
    if len(secret) != 32:
        raise ProfileConfigError(reason="private config secret must be 32 bytes")
    if base64.urlsafe_b64encode(secret).decode("ascii").rstrip("=") != encoded:
        raise ProfileConfigError(reason="private config secret is not canonical")
    return Credential(profile_id=profile_id, secret=secret)


def atomic_write_json(path: Path, value: JsonObject) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


class ProfileLock:
    """Owns an operating-system lock for one Blender profile."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._stream: BinaryIO | None = None

    def acquire(self) -> None:
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = _open_regular(self._path, os.O_RDWR | os.O_CREAT)
        if sys.platform != "win32":
            os.fchmod(descriptor, 0o600)
        stream = os.fdopen(descriptor, "a+b")
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            stream.close()
            raise ProfileBusyError(path=self._path) from error
        stream.seek(0)
        stream.truncate()
        stream.write(str(os.getpid()).encode("ascii"))
        stream.flush()
        self._stream = stream

    def release(self) -> None:
        stream = self._stream
        if stream is None:
            return
        stream.seek(0)
        if sys.platform == "win32":
            import msvcrt

            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()
        self._stream = None

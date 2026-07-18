from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final, NewType, TypeAlias, TypeVar


NONCE_BYTES: Final = 32
MAC_HEX_LENGTH: Final = 64
REPLAY_WINDOW: Final = 4096
MINIMUM_PORT: Final = 49152
MAXIMUM_PORT: Final = 65535
ProfileId = NewType("ProfileId", str)
JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
Result = TypeVar("Result")


@dataclass(frozen=True, slots=True)
class AuthenticationError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class PrivateConfig:
    profile_id: ProfileId
    host: str
    port: int
    secret: bytes


class ReplayGuard:
    """Bounded mutable nonce history for one Blender bridge process."""

    __slots__ = ("_order", "_seen")

    def __init__(self) -> None:
        self._order: deque[str] = deque()
        self._seen: set[str] = set()

    def accept(self, nonce: str) -> None:
        if nonce in self._seen:
            raise AuthenticationError(reason="request nonce was already used")
        self._seen.add(nonce)
        self._order.append(nonce)
        if len(self._order) > REPLAY_WINDOW:
            self._seen.remove(self._order.popleft())


def canonical_json(value: JsonValue) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise AuthenticationError(reason="value is not canonical JSON") from error


def load_private_config(config_path: str | Path) -> PrivateConfig:
    try:
        raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AuthenticationError(reason="private bridge config is unreadable") from error
    if not isinstance(raw, dict) or set(raw) != {"schemaVersion", "profileId", "host", "port", "secret"}:
        raise AuthenticationError(reason="private bridge config shape is invalid")
    profile_id = raw.get("profileId")
    host = raw.get("host")
    port = raw.get("port")
    encoded_secret = raw.get("secret")
    if raw.get("schemaVersion") != 1 or not isinstance(profile_id, str) or not profile_id:
        raise AuthenticationError(reason="private bridge config identity is invalid")
    if host != "127.0.0.1" or not isinstance(port, int) or isinstance(port, bool) or not MINIMUM_PORT <= port <= MAXIMUM_PORT:
        raise AuthenticationError(reason="private bridge config endpoint is invalid")
    if not isinstance(encoded_secret, str):
        raise AuthenticationError(reason="private bridge config credential is invalid")
    try:
        secret = base64.b64decode(encoded_secret + "=" * (-len(encoded_secret) % 4), altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as error:
        raise AuthenticationError(reason="private bridge config credential is invalid") from error
    if len(secret) != 32:
        raise AuthenticationError(reason="private bridge config credential is invalid")
    return PrivateConfig(ProfileId(profile_id), host, port, secret)


def create_execute_request(
    config: PrivateConfig,
    code: str,
    strict_json: bool,
    *,
    nonce: str | None = None,
) -> bytes:
    request_nonce = nonce if nonce is not None else secrets.token_hex(NONCE_BYTES)
    _require_hex(request_nonce, NONCE_BYTES * 2, "nonce")
    payload: JsonObject = {"code": code, "strict_json": strict_json, "type": "execute"}
    proof = _proof(config, request_nonce, payload)
    return canonical_json({
        "auth": {"nonce": request_nonce, "profileId": config.profile_id, "proof": proof},
        "payload": payload,
    })


def authenticate_execute_request(data: bytes, config: PrivateConfig, replay_guard: ReplayGuard) -> tuple[str, bool]:
    try:
        request = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AuthenticationError(reason="authenticated request is invalid JSON") from error
    if not isinstance(request, dict) or data != canonical_json(request) or set(request) != {"auth", "payload"}:
        raise AuthenticationError(reason="authenticated request is not canonical")
    auth = request.get("auth")
    payload = request.get("payload")
    if not isinstance(auth, dict) or set(auth) != {"nonce", "profileId", "proof"}:
        raise AuthenticationError(reason="authenticated request proof is malformed")
    if not isinstance(payload, dict) or set(payload) != {"code", "strict_json", "type"}:
        raise AuthenticationError(reason="authenticated request payload is malformed")
    nonce = _require_text(auth, "nonce")
    proof = _require_text(auth, "proof")
    _require_hex(nonce, NONCE_BYTES * 2, "nonce")
    _require_hex(proof, MAC_HEX_LENGTH, "proof")
    if auth.get("profileId") != config.profile_id or payload.get("type") != "execute":
        raise AuthenticationError(reason="authenticated request identity is invalid")
    code = payload.get("code")
    strict_json = payload.get("strict_json")
    if not isinstance(code, str) or not isinstance(strict_json, bool):
        raise AuthenticationError(reason="authenticated execute payload is invalid")
    if not hmac.compare_digest(proof, _proof(config, nonce, payload)):
        raise AuthenticationError(reason="authenticated request proof mismatch")
    replay_guard.accept(nonce)
    return code, strict_json


def authenticate_and_execute(
    data: bytes,
    config: PrivateConfig,
    replay_guard: ReplayGuard,
    execute: Callable[[str, bool], Result],
) -> Result:
    code, strict_json = authenticate_execute_request(data, config, replay_guard)
    return execute(code, strict_json)


def _proof(config: PrivateConfig, nonce: str, payload: JsonObject) -> str:
    material: JsonObject = {
        "direction": "request",
        "nonce": nonce,
        "payload": payload,
        "profileId": config.profile_id,
    }
    return hmac.new(config.secret, canonical_json(material), hashlib.sha256).hexdigest()


def _require_text(value: JsonObject, key: str) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str):
        raise AuthenticationError(reason=f"authenticated request field is invalid: {key}")
    return candidate


def _require_hex(value: str, length: int, field: str) -> None:
    if len(value) != length:
        raise AuthenticationError(reason=f"authenticated request field is invalid: {field}")
    try:
        bytes.fromhex(value)
    except ValueError as error:
        raise AuthenticationError(reason=f"authenticated request field is invalid: {field}") from error

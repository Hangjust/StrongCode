from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import socket
import struct
from dataclasses import dataclass
from typing import Final, Literal, TypeAlias


PROTOCOL_VERSION: Final = 1
MAX_FRAME_BYTES: Final = 8 * 1024 * 1024
AUTH_TIMEOUT_SECONDS: Final = 5.0
NONCE_BYTES: Final = 32
MAC_HEX_LENGTH: Final = 64

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
Direction: TypeAlias = Literal["request", "response"]


@dataclass(frozen=True, slots=True)
class FrameError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class AuthenticationError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class Credential:
    profile_id: str
    secret: bytes


@dataclass(frozen=True, slots=True)
class Handshake:
    session_id: str
    client_nonce: str
    server_nonce: str


def canonical_json(value: JsonValue) -> bytes:
    try:
        text = json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise FrameError(reason=f"value is not canonical JSON: {error}") from error
    return text.encode("utf-8")


def send_frame(connection: socket.socket, message: JsonObject) -> None:
    payload = canonical_json(message)
    if len(payload) > MAX_FRAME_BYTES:
        raise FrameError(reason="frame exceeds maximum size")
    connection.sendall(struct.pack(">I", len(payload)) + payload)


def _receive_exact(connection: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = connection.recv(length - len(chunks))
        if not chunk:
            raise EOFError("peer closed the connection")
        chunks.extend(chunk)
    return bytes(chunks)


def receive_frame(connection: socket.socket) -> JsonObject:
    length = struct.unpack(">I", _receive_exact(connection, 4))[0]
    if length == 0 or length > MAX_FRAME_BYTES:
        raise FrameError(reason="invalid frame length")
    raw = _receive_exact(connection, length)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FrameError(reason=f"invalid JSON frame: {error}") from error
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise FrameError(reason="frame must be a JSON object")
    if raw != canonical_json(value):
        raise FrameError(reason="frame JSON is not canonical")
    return value


def _mac(key: bytes, value: JsonObject) -> str:
    return hmac.new(key, canonical_json(value), hashlib.sha256).hexdigest()


def _require_text(message: JsonObject, key: str, length: int | None = None) -> str:
    value = message.get(key)
    if not isinstance(value, str) or (length is not None and len(value) != length):
        raise AuthenticationError(reason=f"invalid authentication field: {key}")
    if length is not None:
        try:
            bytes.fromhex(value)
        except ValueError as error:
            raise AuthenticationError(reason=f"invalid authentication field: {key}") from error
    return value


def _derive_key(credential: Credential, handshake: Handshake) -> bytes:
    material: JsonObject = {
        "clientNonce": handshake.client_nonce,
        "profileId": credential.profile_id,
        "role": "session",
        "serverNonce": handshake.server_nonce,
        "sessionId": handshake.session_id,
    }
    return hmac.new(credential.secret, canonical_json(material), hashlib.sha256).digest()


def client_authenticate(
    connection: socket.socket,
    credential: Credential,
    session_id: str,
) -> "SecureChannel":
    connection.settimeout(AUTH_TIMEOUT_SECONDS)
    client_nonce = secrets.token_hex(NONCE_BYTES)
    client_claim: JsonObject = {
        "clientNonce": client_nonce,
        "profileId": credential.profile_id,
        "role": "client",
        "sessionId": session_id,
    }
    send_frame(connection, {
        "operation": "auth.client_hello",
        "protocol": PROTOCOL_VERSION,
        "sessionId": session_id,
        "profileId": credential.profile_id,
        "clientNonce": client_nonce,
        "proof": _mac(credential.secret, client_claim),
    })
    challenge = receive_frame(connection)
    if set(challenge) != {"operation", "serverNonce", "proof"} or challenge.get("operation") != "auth.server_challenge":
        raise AuthenticationError(reason="server challenge missing")
    server_nonce = _require_text(challenge, "serverNonce", NONCE_BYTES * 2)
    server_claim: JsonObject = {
        "clientNonce": client_nonce,
        "profileId": credential.profile_id,
        "role": "server",
        "serverNonce": server_nonce,
        "sessionId": session_id,
    }
    proof = _require_text(challenge, "proof", MAC_HEX_LENGTH)
    if not hmac.compare_digest(proof, _mac(credential.secret, server_claim)):
        raise AuthenticationError(reason="server proof mismatch")
    session_key = _derive_key(credential, Handshake(session_id, client_nonce, server_nonce))
    confirmation: JsonObject = {
        "clientNonce": client_nonce,
        "role": "client_confirm",
        "serverNonce": server_nonce,
        "sessionId": session_id,
    }
    send_frame(connection, {
        "operation": "auth.client_confirm",
        "proof": _mac(session_key, confirmation),
    })
    accepted = receive_frame(connection)
    server_confirmation: JsonObject = {
        "clientNonce": client_nonce,
        "role": "server_confirm",
        "serverNonce": server_nonce,
        "sessionId": session_id,
    }
    accepted_proof = _require_text(accepted, "proof", MAC_HEX_LENGTH)
    if set(accepted) != {"operation", "proof"} or accepted.get("operation") != "auth.server_confirm" or not hmac.compare_digest(
        accepted_proof, _mac(session_key, server_confirmation)
    ):
        raise AuthenticationError(reason="server confirmation mismatch")
    return SecureChannel(connection, session_key, session_id)


def server_authenticate(
    connection: socket.socket,
    credential: Credential,
    session_id: str,
) -> "SecureChannel":
    connection.settimeout(AUTH_TIMEOUT_SECONDS)
    hello = receive_frame(connection)
    if set(hello) != {"operation", "protocol", "sessionId", "profileId", "clientNonce", "proof"}:
        raise AuthenticationError(reason="client hello invalid")
    if hello.get("operation") != "auth.client_hello" or hello.get("protocol") != PROTOCOL_VERSION:
        raise AuthenticationError(reason="client hello invalid")
    if hello.get("sessionId") != session_id or hello.get("profileId") != credential.profile_id:
        raise AuthenticationError(reason="client identity mismatch")
    client_nonce = _require_text(hello, "clientNonce", NONCE_BYTES * 2)
    client_claim: JsonObject = {
        "clientNonce": client_nonce,
        "profileId": credential.profile_id,
        "role": "client",
        "sessionId": session_id,
    }
    proof = _require_text(hello, "proof", MAC_HEX_LENGTH)
    if not hmac.compare_digest(proof, _mac(credential.secret, client_claim)):
        raise AuthenticationError(reason="client proof mismatch")
    server_nonce = secrets.token_hex(NONCE_BYTES)
    server_claim: JsonObject = {
        "clientNonce": client_nonce,
        "profileId": credential.profile_id,
        "role": "server",
        "serverNonce": server_nonce,
        "sessionId": session_id,
    }
    send_frame(connection, {
        "operation": "auth.server_challenge",
        "serverNonce": server_nonce,
        "proof": _mac(credential.secret, server_claim),
    })
    session_key = _derive_key(credential, Handshake(session_id, client_nonce, server_nonce))
    confirmation = receive_frame(connection)
    client_confirmation: JsonObject = {
        "clientNonce": client_nonce,
        "role": "client_confirm",
        "serverNonce": server_nonce,
        "sessionId": session_id,
    }
    confirmation_proof = _require_text(confirmation, "proof", MAC_HEX_LENGTH)
    if set(confirmation) != {"operation", "proof"} or confirmation.get("operation") != "auth.client_confirm" or not hmac.compare_digest(
        confirmation_proof, _mac(session_key, client_confirmation)
    ):
        raise AuthenticationError(reason="client confirmation mismatch")
    server_confirmation: JsonObject = {
        "clientNonce": client_nonce,
        "role": "server_confirm",
        "serverNonce": server_nonce,
        "sessionId": session_id,
    }
    send_frame(connection, {
        "operation": "auth.server_confirm",
        "proof": _mac(session_key, server_confirmation),
    })
    return SecureChannel(connection, session_key, session_id)


from .channel import SecureChannel  # noqa: E402

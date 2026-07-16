from __future__ import annotations

import hmac
import socket

from .protocol import (
    AuthenticationError,
    Direction,
    JsonObject,
    _mac,
    receive_frame,
    send_frame,
)


class SecureChannel:
    def __init__(self, connection: socket.socket, key: bytes, session_id: str) -> None:
        self._connection = connection
        self._key = key
        self._session_id = session_id
        self._send_sequence = 0
        self._receive_sequence = 0

    def send(self, direction: Direction, operation: str, payload: JsonObject) -> None:
        self._send_sequence += 1
        authenticated: JsonObject = {
            "direction": direction,
            "operation": operation,
            "payload": payload,
            "sequence": self._send_sequence,
            "sessionId": self._session_id,
        }
        send_frame(self._connection, {**authenticated, "mac": _mac(self._key, authenticated)})

    def receive(self, direction: Direction) -> tuple[str, JsonObject]:
        message = receive_frame(self._connection)
        sequence = message.get("sequence")
        operation = message.get("operation")
        payload = message.get("payload")
        supplied_mac = message.get("mac")
        if (
            set(message) != {"direction", "operation", "payload", "sequence", "sessionId", "mac"}
            or message.get("direction") != direction
            or message.get("sessionId") != self._session_id
            or sequence != self._receive_sequence + 1
            or isinstance(sequence, bool)
            or not isinstance(operation, str)
            or not isinstance(payload, dict)
            or not isinstance(supplied_mac, str)
        ):
            raise AuthenticationError(reason="authenticated envelope invalid")
        authenticated: JsonObject = {
            "direction": direction,
            "operation": operation,
            "payload": payload,
            "sequence": sequence,
            "sessionId": self._session_id,
        }
        if not hmac.compare_digest(supplied_mac, _mac(self._key, authenticated)):
            raise AuthenticationError(reason="message MAC mismatch")
        self._receive_sequence = sequence
        return operation, payload

from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path


DERIVATIVE_ROOT = Path(__file__).resolve().parents[2] / "assets" / "blender-mcp" / "official-derivative"
sys.path.insert(0, str(DERIVATIVE_ROOT))

import strongcode_auth  # noqa: E402


class OfficialDerivativeAuthenticationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.config_path = Path(self.temporary.name) / "official.json"
        self.config_path.write_text(json.dumps({
            "schemaVersion": 1,
            "profileId": "blender-profile",
            "host": "127.0.0.1",
            "port": 54321,
            "secret": base64.urlsafe_b64encode(b"s" * 32).decode("ascii").rstrip("="),
        }), encoding="utf-8")
        self.config = strongcode_auth.load_private_config(self.config_path)

    def test_missing_proof_cannot_execute(self) -> None:
        # Given
        request = strongcode_auth.canonical_json({
            "auth": {"nonce": "01" * 32, "profileId": self.config.profile_id},
            "payload": {"code": "result = {'executed': True}", "strict_json": True, "type": "execute"},
        })
        executed: list[str] = []

        # When / Then
        with self.assertRaises(strongcode_auth.AuthenticationError):
            strongcode_auth.authenticate_and_execute(request, self.config, strongcode_auth.ReplayGuard(),
                lambda code, _strict: executed.append(code))
        self.assertEqual(executed, [])

    def test_wrong_or_malformed_proof_cannot_execute(self) -> None:
        # Given
        valid = json.loads(strongcode_auth.create_execute_request(
            self.config, "result = {'executed': True}", True, nonce="02" * 32
        ))
        malformed = {**valid, "auth": {**valid["auth"], "proof": "not-hex"}}
        wrong = {**valid, "auth": {**valid["auth"], "proof": "00" * 32}}

        # When / Then
        for request in (malformed, wrong):
            with self.assertRaises(strongcode_auth.AuthenticationError):
                strongcode_auth.authenticate_and_execute(
                    strongcode_auth.canonical_json(request), self.config, strongcode_auth.ReplayGuard(), lambda _code, _strict: None
                )

    def test_noncanonical_request_is_rejected(self) -> None:
        # Given
        request = strongcode_auth.create_execute_request(self.config, "result = {}", True, nonce="03" * 32)
        noncanonical = request.replace(b'"auth":', b'"auth": ')

        # When / Then
        with self.assertRaises(strongcode_auth.AuthenticationError):
            strongcode_auth.authenticate_and_execute(
                noncanonical, self.config, strongcode_auth.ReplayGuard(), lambda _code, _strict: None
            )

    def test_replayed_request_cannot_execute_twice(self) -> None:
        # Given
        guard = strongcode_auth.ReplayGuard()
        request = strongcode_auth.create_execute_request(self.config, "result = {'executed': True}", True, nonce="04" * 32)
        executions: list[str] = []

        # When
        strongcode_auth.authenticate_and_execute(request, self.config, guard, lambda code, _strict: executions.append(code))

        # Then
        with self.assertRaises(strongcode_auth.AuthenticationError):
            strongcode_auth.authenticate_and_execute(request, self.config, guard, lambda code, _strict: executions.append(code))
        self.assertEqual(executions, ["result = {'executed': True}"])

    def test_valid_authenticated_request_executes_with_exact_payload(self) -> None:
        # Given
        request = strongcode_auth.create_execute_request(self.config, "result = {'value': 7}", False, nonce="05" * 32)

        # When
        result = strongcode_auth.authenticate_and_execute(
            request, self.config, strongcode_auth.ReplayGuard(), lambda code, strict: (code, strict)
        )

        # Then
        self.assertEqual(result, ("result = {'value': 7}", False))


if __name__ == "__main__":
    unittest.main()

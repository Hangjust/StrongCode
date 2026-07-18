# SPDX-FileCopyrightText: 2026 Blender Authors
#
# SPDX-License-Identifier: GPL-3.0-or-later

"""Authenticated socket client for the Blender Lab add-on bridge."""

__all__ = (
    "configure_private_config",
    "get_connection_params",
    "send_code",
)

import json
import socket

from . import strongcode_auth


_TIMEOUT = 300.0
_RECV_BUFFER_SIZE = 65536
_private_config_path: str | None = None


def configure_private_config(config_path: str) -> None:
    global _private_config_path
    strongcode_auth.load_private_config(config_path)
    _private_config_path = config_path


def _private_config() -> strongcode_auth.PrivateConfig:
    if _private_config_path is None:
        raise ConnectionError("StrongCode private bridge config was not provided")
    return strongcode_auth.load_private_config(_private_config_path)


def get_connection_params() -> tuple[str, int]:
    config = _private_config()
    return config.host, config.port


def send_code(code: str, strict_json: bool) -> dict[str, object]:
    """Authenticate and send Python code to the pinned Blender Lab bridge."""
    config = _private_config()
    request = strongcode_auth.create_execute_request(config, code, strict_json) + b"\0"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(_TIMEOUT)
            sock.connect((config.host, config.port))
            sock.sendall(request)
            buf = bytearray()
            while True:
                chunk = sock.recv(_RECV_BUFFER_SIZE)
                if not chunk:
                    break
                buf.extend(chunk)
                if b"\0" in buf:
                    break
    except ConnectionRefusedError as error:
        raise ConnectionError(
            "Cannot connect to Blender at {:s}:{:d}. Ensure Blender is running with the authenticated MCP addon enabled.".format(
                config.host, config.port
            )
        ) from error
    except socket.timeout as error:
        raise ConnectionError("Blender connection timed out at {:s}:{:d}".format(config.host, config.port)) from error
    except OSError as error:
        raise ConnectionError(
            "Socket error communicating with Blender at {:s}:{:d}: {:s}".format(config.host, config.port, str(error))
        ) from error
    if not buf:
        raise ConnectionError("Empty response from Blender")
    line, _separator, _remaining = buf.partition(b"\0")
    try:
        response = json.loads(line.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ConnectionError(
            "Invalid response from Blender at {:s}:{:d}: {:s}".format(config.host, config.port, str(error))
        ) from error
    if not isinstance(response, dict) or not all(isinstance(key, str) for key in response):
        raise ConnectionError("Invalid response from Blender")
    return response

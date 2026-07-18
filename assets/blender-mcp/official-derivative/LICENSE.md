# StrongCode Blender Lab MCP authenticated derivative

The derivative files in this directory modify Blender Lab MCP v1.0.0 from
commit `03004fd0216bfe5e0a3d9ac9b47d5efadc3d78c4`.

Upstream and derivative code remain licensed under GPL-3.0-or-later. See
`../OFFICIAL_LICENSE.md`. StrongCode-authored changes add a private-config
HMAC-SHA256 request proof, cryptographic nonces, canonical JSON, replay
rejection, and a literal `127.0.0.1` endpoint. These changes do not imply
endorsement by Blender or the upstream Blender Lab MCP authors.

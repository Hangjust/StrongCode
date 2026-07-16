# Wrapper asset source

Pass `assets/blender-mcp/runtime-wrapper` as `wrapperAssetsPath` to
`stageBlenderPythonEnvironment`. That directory intentionally contains only
`strongcode-blender-wrapper.py` and its `wrapper` Python package, so staging
does not copy the Blender addon, provenance, locks, licenses, or notices into
the virtual environment's wrapper directory.

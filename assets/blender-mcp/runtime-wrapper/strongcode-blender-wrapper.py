from __future__ import annotations

import sys
from pathlib import Path


# Python isolated mode omits the script directory; this pinned local bundle is trusted.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from wrapper.server import main


if __name__ == "__main__":
    raise SystemExit(main())

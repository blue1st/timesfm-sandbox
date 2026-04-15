# PyInstaller runtime hook for numpy
# Ensures numpy's native extensions can find their dependencies
# in the PyInstaller bundle directory (_MEIPASS).
import os
import sys

# Get the PyInstaller bundle base directory
_base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))

# Ensure _MEIPASS is at the front of sys.path so numpy's
# native extensions (.so/.dylib) can be resolved before
# any system-installed versions
if _base not in sys.path:
    sys.path.insert(0, _base)

# Pre-import numpy BEFORE torch to prevent torch from
# swallowing the real import error and printing
# "Numpy is not available" without details
try:
    import numpy
    import numpy.core._multiarray_umath
except ImportError as e:
    print(f"[rthook] numpy import failed: {e}", file=sys.stderr)

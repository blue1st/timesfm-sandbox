import os
import sys
import ctypes

# Get the PyInstaller bundle base directory
_base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))

# Ensure _MEIPASS is at the front of sys.path
if _base not in sys.path:
    sys.path.insert(0, _base)

# Intel Mac specific: Add .libs to DYLD_LIBRARY_PATH if it exists
numpy_libs = os.path.join(_base, 'numpy', '.libs')
if os.path.exists(numpy_libs):
    existing = os.environ.get('DYLD_LIBRARY_PATH', '')
    os.environ['DYLD_LIBRARY_PATH'] = f"{numpy_libs}:{existing}" if existing else numpy_libs

# Pre-import numpy and diagnostic
try:
    import numpy
    print(f"[rthook] numpy {numpy.__version__} loaded successfully")
except Exception as e:
    print(f"[rthook] numpy import failed: {e}", file=sys.stderr)
    # Check if we can load the core C extension directly to see why it fails
    try:
        import numpy.core._multiarray_umath
    except Exception as ce:
        print(f"[rthook] multiarray_umath load failed: {ce}", file=sys.stderr)

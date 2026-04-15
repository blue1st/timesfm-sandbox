import os
import sys
import traceback

# Get the PyInstaller bundle base directory
_base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))

def debug_log(msg):
    print(msg)
    try:
        debug_path = os.path.expanduser("~/Desktop/timesfm_debug.txt")
        with open(debug_path, "a") as f:
            f.write(msg + "\n")
    except:
        pass

debug_log(f"--- Startup Debug: _base={_base} ---")
debug_log(f"sys.path={sys.path}")

# Ensure _MEIPASS is at the front
if _base not in sys.path:
    sys.path.insert(0, _base)

# Intel Mac specific: Add .libs to DYLD_LIBRARY_PATH if it exists
numpy_libs = os.path.join(_base, 'numpy', '.libs')
if os.path.exists(numpy_libs):
    debug_log(f"Found numpy .libs at: {numpy_libs}")
    existing = os.environ.get('DYLD_LIBRARY_PATH', '')
    os.environ['DYLD_LIBRARY_PATH'] = f"{numpy_libs}:{existing}" if existing else numpy_libs

# Pre-import numpy and diagnostic
try:
    import numpy
    debug_log(f"SUCCESS: numpy {numpy.__version__} loaded from {numpy.__file__}")
except Exception as e:
    debug_log(f"FAILED: numpy import error: {e}")
    debug_log(traceback.format_exc())
    # Try direct load of core C extension
    try:
        import numpy.core._multiarray_umath
        debug_log("SUCCESS: numpy.core._multiarray_umath loaded directly")
    except Exception as ce:
        debug_log(f"FAILED: multiarray_umath load error: {ce}")
        debug_log(traceback.format_exc())

# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import (
    collect_all,
    collect_submodules,
    collect_dynamic_libs,
)

block_cipher = None

# Collect all data/binaries for packages with native extensions
timesfm_datas, timesfm_binaries, timesfm_hiddenimports = collect_all('timesfm')
torch_datas, torch_binaries, torch_hiddenimports = collect_all('torch')
numpy_datas, numpy_binaries, numpy_hiddenimports = collect_all('numpy')
safetensors_datas, safetensors_binaries, safetensors_hiddenimports = collect_all('safetensors')

# Explicitly collect dynamic libraries (.so/.dylib) — collect_all sometimes
# misses transitive native dependencies, especially on Intel macOS
numpy_dynlibs = collect_dynamic_libs('numpy')
numpy_core_dynlibs = collect_dynamic_libs('numpy.core')
numpy_linalg_dynlibs = collect_dynamic_libs('numpy.linalg')
numpy_fft_dynlibs = collect_dynamic_libs('numpy.fft')
numpy_random_dynlibs = collect_dynamic_libs('numpy.random')

# Explicitly collect numpy's .libs directory (contains OpenBLAS/MKL)
import os
import numpy as np
numpy_libs_dir = os.path.join(os.path.dirname(np.__file__), ".libs")
all_datas = timesfm_datas + torch_datas + numpy_datas + safetensors_datas
if os.path.exists(numpy_libs_dir):
    all_datas += [(numpy_libs_dir, "numpy/.libs")]

all_binaries = (
    timesfm_binaries
    + torch_binaries
    + numpy_binaries
    + safetensors_binaries
    + numpy_dynlibs
    + numpy_core_dynlibs
    + numpy_linalg_dynlibs
    + numpy_fft_dynlibs
    + numpy_random_dynlibs
)
all_hiddenimports = (
    timesfm_hiddenimports
    + torch_hiddenimports
    + numpy_hiddenimports
    + safetensors_hiddenimports
    + collect_submodules('numpy')
    + collect_submodules('numpy.core')
    + collect_submodules('numpy.linalg')
    + collect_submodules('numpy.fft')
    + collect_submodules('numpy.random')
    + collect_submodules('uvicorn')
    + collect_submodules('fastapi')
    + collect_submodules('pydantic')
    + collect_submodules('huggingface_hub')
    + collect_submodules('google.auth')
    + collect_submodules('google.cloud')
    + collect_submodules('google_auth_oauthlib')
    + [
        'gcp_service', 'pandas', 'db_dtypes', 'pandas_gbq',
        # numpy core native extensions — critical for "Numpy is available"
        'numpy.core._multiarray_umath',
        'numpy.core._multiarray_tests',
        'numpy.core._dtype_ctypes',
        'numpy.core._internal',
        'numpy.core._methods',
        'numpy.core._exceptions',
        'numpy.linalg._umath_linalg',
        'numpy.linalg.lapack_lite',
        'numpy.fft._pocketfft_internal',
        'numpy.random._common',
        'numpy.random._bounded_integers',
        'numpy.random._mt19937',
        'numpy.random._philox',
        'numpy.random._pcg64',
        'numpy.random._sfc64',
        'numpy.random._generator',
        'numpy.random.mtrand',
        'numpy.random.bit_generator',
        # numpy._distributor_init handles BLAS/LAPACK library loading
        'numpy._distributor_init',
        'numpy._pytesttester',
    ]
)

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=all_binaries,
    datas=all_datas,
    hiddenimports=all_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['hooks/rthook_numpy.py'],
    excludes=[],
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='server',
)

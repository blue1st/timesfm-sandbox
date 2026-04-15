# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# Collect all data/binaries for packages with native extensions
timesfm_datas, timesfm_binaries, timesfm_hiddenimports = collect_all('timesfm')
torch_datas, torch_binaries, torch_hiddenimports = collect_all('torch')
numpy_datas, numpy_binaries, numpy_hiddenimports = collect_all('numpy')
safetensors_datas, safetensors_binaries, safetensors_hiddenimports = collect_all('safetensors')

all_datas = timesfm_datas + torch_datas + numpy_datas + safetensors_datas
all_binaries = timesfm_binaries + torch_binaries + numpy_binaries + safetensors_binaries
all_hiddenimports = (
    timesfm_hiddenimports
    + torch_hiddenimports
    + numpy_hiddenimports
    + safetensors_hiddenimports
    + collect_submodules('uvicorn')
    + collect_submodules('fastapi')
    + collect_submodules('pydantic')
    + collect_submodules('huggingface_hub')
    + collect_submodules('google.auth')
    + collect_submodules('google.cloud')
    + collect_submodules('google_auth_oauthlib')
    + ['gcp_service', 'pandas', 'db_dtypes', 'pandas_gbq']
)

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=all_binaries,
    datas=all_datas,
    hiddenimports=all_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
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

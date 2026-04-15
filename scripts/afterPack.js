// Ad-hoc codesign the app bundle after electron-builder packs it.
// This is necessary because PyInstaller binaries in extraResources
// are not signed by electron-builder, causing "damaged" errors on Apple Silicon.
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function(context) {
  if (process.platform !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  if (!fs.existsSync(appPath)) {
    console.warn(`App not found at ${appPath}, skipping codesign`);
    return;
  }

  console.log(`Ad-hoc codesigning: ${appPath}`);

  // 1. Sign all .so and .dylib files inside the app (inside-out signing)
  try {
    execSync(
      `find "${appPath}" -type f \\( -name "*.so" -o -name "*.dylib" \\) -exec codesign --force --sign - {} \\;`,
      { stdio: 'inherit' }
    );
    console.log('Signed all .so/.dylib files');
  } catch (e) {
    console.warn('Warning signing shared libraries:', e.message);
  }

  // 2. Sign all executable binaries in the backend resources
  const backendDir = path.join(appPath, 'Contents', 'Resources', 'backend');
  if (fs.existsSync(backendDir)) {
    try {
      execSync(
        `find "${backendDir}" -type f -perm +111 ! -name "*.so" ! -name "*.dylib" -exec codesign --force --sign - {} \\;`,
        { stdio: 'inherit' }
      );
      console.log('Signed backend executables');
    } catch (e) {
      console.warn('Warning signing backend executables:', e.message);
    }
  }

  // 3. Re-sign the entire .app bundle
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log('App bundle signed successfully');
  } catch (e) {
    console.warn('Warning signing app bundle:', e.message);
  }
};

// electron-builder "afterSign" hook. Invoicer has no Apple Developer ID, so on macOS the finished
// app gets an ad-hoc signature ("codesign --sign -") before the .dmg and .zip are made.
// Apple silicon Macs won't open an app with no signature at all; with an ad-hoc one, people can
// open it via System Settings → Privacy & Security → Open Anyway.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--verbose=2', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${app}`);
};

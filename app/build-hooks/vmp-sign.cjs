// electron-builder afterPack, before the app is zipped / turned into an installer:
//
// 1. A production VMP signature from castLabs' EVS, so DRM services that refuse the development one
//    (Apple Music on macOS and Windows…) play. Needs the EVS client (pip install castlabs-evs) and
//    EVS_ACCOUNT_NAME / EVS_PASSWD; without them the build goes on unsigned (GLEEOK_REQUIRE_VMP=1,
//    set for releases, makes that an error). Linux has no VMP.
// 2. macOS: code signing, which has to come after VMP. electron-builder does not sign (there is no
//    Apple developer identity, and then it skips afterSign too), so it happens here: with
//    MAC_SIGN_IDENTITY (a self-signed certificate the release workflow imports) every version keeps
//    the same code identity and the keychain keeps trusting it across updates; without one, ad hoc
//    ("-"), which is enough for Apple Silicon to run it.
const { execFileSync } = require('node:child_process');
const { chmodSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/** node-pty's spawn-helper comes out of npm without the executable bit: terminals fail to start without it. */
function makeSpawnHelpersExecutable(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) makeSpawnHelpersExecutable(path);
    else if (entry.name === 'spawn-helper') chmodSync(path, 0o755);
  }
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'win32') {
    const app = platform === 'darwin' ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app') : join(context.appOutDir, 'resources', 'app');
    const pty = join(app, 'node_modules', 'node-pty');
    if (existsSync(pty)) makeSpawnHelpersExecutable(pty);
  }
  if (platform === 'linux') return;

  const { EVS_ACCOUNT_NAME: account, EVS_PASSWD: passwd } = process.env;
  if (account && passwd) {
    const python = process.env.EVS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const evs = (args) => execFileSync(python, ['-m', ...args], { stdio: 'inherit' });
    evs(['castlabs_evs.vmp', 'sign-pkg', '-A', account, '-P', passwd, context.appOutDir]);
    evs(['castlabs_evs.vmp', 'verify-pkg', context.appOutDir]);
  } else {
    const msg = 'no EVS_ACCOUNT_NAME / EVS_PASSWD: this build has no production VMP signature (Apple Music may refuse it)';
    if (process.env.GLEEOK_REQUIRE_VMP) throw new Error(msg);
    console.warn(`  • ${msg}`);
  }

  if (platform === 'darwin') {
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const identity = process.env.MAC_SIGN_IDENTITY || '-';
    const keychain = process.env.MAC_SIGN_KEYCHAIN ? ['--keychain', process.env.MAC_SIGN_KEYCHAIN] : [];
    execFileSync('codesign', ['--force', '--deep', '--sign', identity, ...keychain, app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', app], { stdio: 'inherit' });
  }
};

// Builds D2L Hub for this computer and installs it like any other app, so it
// shows up in the app launcher / Applications folder / Start menu.
//
//   npm run install:app               build + install
//   npm run install:app -- --skip-build   reinstall the last build in release/
//   npm run install:app -- --uninstall    remove it again
//
// Linux: the unpacked app in ~/.local/share/d2l-hub plus a launcher entry.
// macOS: "D2L Hub.app" in /Applications (or ~/Applications if not writable).
// Windows: runs the NSIS installer silently (per-user, Start menu + desktop shortcut).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const productName = 'D2L Hub';
const release = path.join(root, 'release');
const args = new Set(process.argv.slice(2));
const home = os.homedir();
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

function run(cmd, cmdArgs) {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

function builder(cmdArgs) {
  run('npx', ['electron-builder', ...cmdArgs, `--${arch}`, '--publish', 'never']);
}

function newest(dir, test) {
  if (!fs.existsSync(dir)) return null;
  const hits = fs
    .readdirSync(dir)
    .filter(test)
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hits[0] ?? null;
}

function linux() {
  // The unpacked build rather than the AppImage: AppImageLauncher and the
  // AppImage's own first-run integration would otherwise move it and add a
  // second launcher entry. Rerun this script to update.
  const appDir = path.join(home, '.local/share/d2l-hub/app');
  const binary = path.join(appDir, 'd2l-hub');
  const iconFile = path.join(home, '.local/share/icons/hicolor/512x512/apps/d2l-hub.png');
  const desktopFile = path.join(home, '.local/share/applications/d2l-hub.desktop');

  if (args.has('--uninstall')) {
    fs.rmSync(appDir, { recursive: true, force: true });
    for (const file of [iconFile, desktopFile]) fs.rmSync(file, { force: true });
    refreshLinuxMenus();
    console.log('D2L Hub removed.');
    return;
  }

  if (!args.has('--skip-build')) {
    run('npm', ['run', 'build']);
    builder(['--linux', 'dir', '-c.electronDist=node_modules/electron/dist']);
  }
  const built = newest(release, (name) => name.startsWith('linux') && name.endsWith('unpacked'));
  if (!built) throw new Error('No unpacked build found in release/ — run without --skip-build.');

  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(appDir), { recursive: true });
  fs.cpSync(built, appDir, { recursive: true, verbatimSymlinks: true });

  fs.mkdirSync(path.dirname(iconFile), { recursive: true });
  fs.copyFileSync(path.join(root, 'build/icon.png'), iconFile);

  fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
  fs.writeFileSync(
    desktopFile,
    [
      '[Desktop Entry]',
      `Name=${productName}`,
      `Comment=${pkg.description}`,
      // Same flag the AppImage uses: chrome-sandbox would need setuid root.
      `Exec="${binary}" --no-sandbox %U`,
      `Icon=${iconFile}`,
      'Terminal=false',
      'Type=Application',
      'Categories=Education;',
      'StartupWMClass=d2l-hub',
      '',
    ].join('\n'),
  );
  refreshLinuxMenus();
  console.log(`\nInstalled ${productName} ${pkg.version} → ${appDir}`);
  console.log('It is in your app launcher now. Rerun `npm run install:app` to update it.');
}

function refreshLinuxMenus() {
  try {
    execFileSync('update-desktop-database', [path.join(home, '.local/share/applications')], { stdio: 'ignore' });
  } catch {
    // Optional; launchers pick up new entries on their own.
  }
}

function mac() {
  const target = isWritable('/Applications') ? '/Applications' : path.join(home, 'Applications');
  const installed = path.join(target, `${productName}.app`);

  if (args.has('--uninstall')) {
    fs.rmSync(installed, { recursive: true, force: true });
    console.log('D2L Hub removed.');
    return;
  }

  if (!args.has('--skip-build')) {
    run('npm', ['run', 'build']);
    builder(['--mac', 'dir']);
  }
  const outDir = newest(release, (name) => name.startsWith('mac'));
  const built = outDir && path.join(outDir, `${productName}.app`);
  if (!built || !fs.existsSync(built)) throw new Error('No .app found in release/ — run without --skip-build.');

  fs.mkdirSync(target, { recursive: true });
  fs.rmSync(installed, { recursive: true, force: true });
  // ditto keeps the bundle's symlinks and signature intact.
  run('ditto', [built, installed]);
  console.log(`\nInstalled ${productName} ${pkg.version} → ${installed}`);
  console.log('Open it from Launchpad or Spotlight; drag it to the Dock to keep it there.');
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function windows() {
  if (args.has('--uninstall')) {
    const uninstaller = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'd2l-hub', `Uninstall ${productName}.exe`);
    if (!fs.existsSync(uninstaller)) throw new Error('Not found — remove it from Settings → Apps instead.');
    run(`"${uninstaller}"`, ['/S']);
    console.log('D2L Hub removed.');
    return;
  }

  if (!args.has('--skip-build')) {
    run('npm', ['run', 'build']);
    builder(['--win', 'nsis', '-c.electronDist=node_modules/electron/dist']);
  }
  const setup = newest(release, (name) => name.endsWith('.exe') && name.includes('setup'));
  if (!setup) throw new Error('No installer found in release/ — run without --skip-build.');

  // /S = silent install for the current user, with Start menu and desktop shortcuts.
  run(`"${setup}"`, ['/S']);
  console.log(`\nInstalled ${productName} ${pkg.version}. Find it in the Start menu.`);
}

const installers = { linux, darwin: mac, win32: windows };
const install = installers[process.platform];
if (!install) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}
try {
  install();
} catch (error) {
  console.error(`\n${error.message ?? error}`);
  process.exit(1);
}

// Gleeok's entry point. An installed build on the beta channel may run a hot update (see
// src/main/hot-update.ts): the code in <userData>/hot/<commit>/, when it was made for this installed
// shell (same Electron and native modules) and did not fail to start last time. Otherwise, and
// always when run from a checkout, the bundled dist/.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function hotMain() {
  if (!app.isPackaged || process.env.GLEEOK_NO_HOT) return null;
  // As dist/main.js does, so userData is the same directory.
  app.setName('gleeok');
  if (process.env.GLEEOK_USER_DATA) app.setPath('userData', process.env.GLEEOK_USER_DATA);
  const dir = path.join(app.getPath('userData'), 'hot');
  let current;
  try {
    current = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
  } catch {
    return null;
  }
  const shell = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist', 'shell.json'), 'utf8')).key;
  const main = path.join(dir, current.commit, 'dist', 'main.js');
  if (current.shell !== shell || !fs.existsSync(main)) return null;
  // It started before and never said it was fine (it crashed or hung): back to the bundled code,
  // and remember not to offer this one again.
  const booting = path.join(dir, 'booting');
  if (fs.existsSync(booting) && fs.readFileSync(booting, 'utf8') === current.commit) {
    fs.writeFileSync(path.join(dir, 'failed'), current.commit);
    fs.rmSync(path.join(dir, 'current.json'), { force: true });
    fs.rmSync(booting, { force: true });
    return null;
  }
  fs.writeFileSync(booting, current.commit);
  return main;
}

let main = null;
try {
  main = hotMain();
} catch {
  main = null;
}
if (main) {
  // The hot code lives outside the app: let it load the installed app's modules (node-pty, the
  // Bitwarden CLI, electron-updater), which is what dist/shell.json vouches for.
  const Module = require('node:module');
  process.env.NODE_PATH = [path.join(__dirname, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
}
require(main || './dist/main.js');

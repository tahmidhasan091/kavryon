#!/usr/bin/env node
/** Copy frontend → Android WebView assets; fail if three.js missing after sync. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'frontend');
const dest = path.join(root, 'android/app/src/main/assets/public');

function cpDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (name === 'node_modules') continue;
    const a = path.join(from, name);
    const b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) cpDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

if (!fs.existsSync(path.join(src, 'js/vendor/three.min.js'))) {
  console.error('FAIL: frontend/js/vendor/three.min.js missing');
  process.exit(1);
}
cpDir(src, dest);
const three = path.join(dest, 'js/vendor/three.min.js');
if (!fs.existsSync(three) || fs.statSync(three).size < 100000) {
  console.error('FAIL: Android three.min.js missing or too small');
  process.exit(1);
}
const appJs = path.join(dest, 'js/app.js');
const srcApp = path.join(src, 'js/app.js');
if (fs.statSync(appJs).size !== fs.statSync(srcApp).size) {
  console.error('FAIL: app.js size mismatch after sync');
  process.exit(1);
}
console.log('Android assets synced OK');

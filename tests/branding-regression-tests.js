const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules','.git','build','.gradle'].includes(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}
const codeExt = new Set(['.js','.json','.xml','.gradle','.yml','.yaml','.html','.css','.md','.sql']);
const files = walk(root).filter(f => codeExt.has(path.extname(f).toLowerCase()));
const allowed = ['BRANDING_MIGRATION.md','BUG_FIX_REPORT.md','ECONOMY_SYSTEM.md','KAVRYON_FINAL_AUDIT.md','seed.js','db.js','production-config.js','economy.js','api.js','server.js','auth.js','LEGACY_NAME_SCAN.md','BUG_FIX_REPORT.md'];
let hits = [];
for (const f of files) {
  const rel = path.relative(root, f);
  const text = fs.readFileSync(f, 'utf8');
  if (/com\.vyntrix\.platform/.test(text)) hits.push(rel + ': com.vyntrix');
  if (/\bVyntrix\b/.test(text) && !allowed.some(a => rel.includes(a)) && !rel.startsWith('tests/')) hits.push(rel + ': bare Vyntrix');
}
for (const a of ['frontend/assets/vyn.svg','android/app/src/main/assets/public/assets/vyn.svg']) {
  assert.ok(!fs.existsSync(path.join(root, a)), 'obsolete asset: ' + a);
}
const appGradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
assert.ok(appGradle.includes('applicationId "com.kavryon.platform"'));
assert.ok(!appGradle.includes('com.vyntrix'));
const strings = fs.readFileSync(path.join(root, 'android/app/src/main/res/values/strings.xml'), 'utf8');
assert.ok(strings.includes('Kavryon'));
assert.ok(!/Vyntrix/i.test(strings));
const auth = fs.readFileSync(path.join(root, 'backend/routes/auth.js'), 'utf8');
assert.ok(auth.includes('kavx:'));
assert.ok(!auth.includes('vyn: w.balance'));
assert.strictEqual(hits.length, 0, 'regressions:\n' + hits.join('\n'));
console.log('Branding regression tests passed');

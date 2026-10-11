/**
 * Real HTTP smoke test: starts the actual backend process, checks startup,
 * static frontend serving, health, and PATCH route registration.
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

async function main() {
  const port = await freePort();
  const dbPath = path.join(os.tmpdir(), `kavryon-smoke-${process.pid}.sqlite`);
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
  }
  const child = spawn(process.execPath, [path.join(__dirname, '../backend/server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'server-smoke-secret-with-more-than-32-characters',
      KAVRYON_DB: dbPath,
      PORT: String(port),
      MULTIPLAYER_MODE: 'memory'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (b) => { logs += b.toString(); });
  child.stderr.on('data', (b) => { logs += b.toString(); });

  const assert = (ok, name) => {
    if (!ok) throw new Error(`FAIL ${name}`);
    console.log(`OK ${name}`);
  };

  try {
    let health = null;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null) throw new Error(`Backend exited early:\n${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) { health = await response.json(); break; }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(health && health.ok === true, 'backend starts and health endpoint responds');

    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    assert(home.status === 200 && html.includes('<title>Kavryon</title>'), 'frontend static files served');

    const patch = await fetch(`http://127.0.0.1:${port}/api/videos/smoke-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const patchBody = await patch.json();
    assert(patch.status === 401 && patchBody.error === 'Login required', 'PATCH route registered and protected by authentication');

    console.log('All server HTTP smoke tests passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500).unref();
    });
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
    }
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exitCode = 1;
});

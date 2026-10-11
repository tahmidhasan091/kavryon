const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function matchPath(pattern, urlPath) {
  const pp = pattern.split('/').filter(Boolean);
  const up = urlPath.split('/').filter(Boolean);
  if (pp.length !== up.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(up[i]);
    else if (pp[i] !== up[i]) return null;
  }
  return params;
}

function createApp() {
  const routes = [];
  const app = {
    use(fn) { routes.push({ method: '*', path: null, fn }); },
    get(p, fn) { routes.push({ method: 'GET', path: p, fn }); },
    post(p, fn) { routes.push({ method: 'POST', path: p, fn }); },
    put(p, fn) { routes.push({ method: 'PUT', path: p, fn }); },
    patch(p, fn) { routes.push({ method: 'PATCH', path: p, fn }); },
    delete(p, fn) { routes.push({ method: 'DELETE', path: p, fn }); }
  };

  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    res.json = (obj, code = 200) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    res.status = (code) => ({ json: (obj) => res.json(obj, code) });

    const maxBody = Number(process.env.JSON_BODY_LIMIT || 524288);
    const chunks = [];
    let received = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      received += c.length;
      if (received > maxBody) {
        aborted = true;
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Request too large' }));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (aborted || res.writableEnded) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      req.body = {};
      if (raw) {
        try { req.body = JSON.parse(raw); } catch {
          res.status(400).json({ error: 'Malformed JSON' });
          return;
        }
      }
      try {
        for (const r of routes) {
          if (r.path === null) {
            await new Promise((resolve) => r.fn(req, res, resolve));
            if (res.writableEnded) return;
            continue;
          }
          if (r.method !== req.method) continue;
          const params = matchPath(r.path, req.path);
          if (!params) continue;
          req.params = params;
          await r.fn(req, res);
          return;
        }
        if (!res.writableEnded) res.status(404).json({ error: 'Not found' });
      } catch (e) {
        console.error(e);
        if (!res.writableEnded) res.status(500).json({ error: 'Server error' });
      }
    });
  }

  app.handle = handle;
  return app;
}

function jwtSign(payload, secret, expiresInSec = 7 * 24 * 3600) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(header + '.' + body).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function jwtVerify(token, secret) {
  const [h, b, s] = String(token).split('.');
  const expect = crypto.createHmac('sha256', secret).update(h + '.' + b).digest('base64url');
  if (s !== expect) throw new Error('bad sig');
  const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
  if (payload.exp && payload.exp < Date.now() / 1000) throw new Error('exp');
  return payload;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png'
};

function staticHandler(root) {
  return (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    let rel = req.path === '/' ? '/index.html' : req.path;
    const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) return next();
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const idx = path.join(root, 'index.html');
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(idx));
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  };
}

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const accept = crypto.createHash('sha1').update(key + guid).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      accept + '\r\n\r\n'
  );
  return wrapSocket(socket);
}

function wrapSocket(socket) {
  const ws = {
    readyState: 1,
    send(data) {
      const payload = Buffer.from(String(data));
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
      else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    },
    ping() {
      socket.write(Buffer.from([0x89, 0]));
    },
    close(code) {
      this.readyState = 3;
      socket.end();
    },
    on(ev, fn) { this._on[ev] = fn; },
    _on: {}
  };
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const finOp = buf[0];
      const opcode = finOp & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const mlen = masked ? 4 : 0;
      if (buf.length < off + mlen + len) return;
      let payload = buf.slice(off + mlen, off + mlen + len);
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      buf = buf.slice(off + mlen + len);
      if (opcode === 0x8) { ws.readyState = 3; if (ws._on.close) ws._on.close(); socket.end(); return; }
      if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0])); continue; }
      if (opcode === 0x1 && ws._on.message) ws._on.message(payload);
    }
  });
  socket.on('close', () => { ws.readyState = 3; if (ws._on.close) ws._on.close(); });
  socket.on('error', () => { ws.readyState = 3; if (ws._on.error) ws._on.error(); });
  return ws;
}

module.exports = { createApp, jwtSign, jwtVerify, staticHandler, acceptWebSocket };

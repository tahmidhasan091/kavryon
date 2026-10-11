/**
 * Minimal single-file multipart/form-data parser (no external deps).
 * Returns { fields, file: { buffer, filename, mime } }
 */
function parseMultipart(req, { maxBytes = 50 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!m) {
      return reject(Object.assign(new Error('Expected multipart/form-data'), { code: 'NOT_MULTIPART' }));
    }
    const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes + 1024 * 64) {
        aborted = true;
        reject(Object.assign(new Error('Payload too large'), { code: 'TOO_LARGE' }));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const buf = Buffer.concat(chunks);
        const parts = splitParts(buf, boundary);
        const fields = {};
        let file = null;
        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd < 0) continue;
          const header = part.slice(0, headerEnd).toString('utf8');
          let body = part.slice(headerEnd + 4);
          // trim trailing CRLF
          if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
            body = body.slice(0, -2);
          }
          const nameMatch = /name="([^"]+)"/i.exec(header);
          const fileMatch = /filename="([^"]*)"/i.exec(header);
          const mimeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(header);
          if (!nameMatch) continue;
          const name = nameMatch[1];
          if (fileMatch) {
            if (body.length > maxBytes) {
              return reject(Object.assign(new Error('File too large'), { code: 'TOO_LARGE' }));
            }
            file = {
              field: name,
              filename: fileMatch[1] || 'upload',
              mime: (mimeMatch && mimeMatch[1].trim()) || 'application/octet-stream',
              buffer: body
            };
          } else {
            fields[name] = body.toString('utf8');
          }
        }
        resolve({ fields, file });
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function splitParts(buf, boundary) {
  const parts = [];
  let start = indexOf(buf, boundary, 0);
  if (start < 0) return parts;
  start += boundary.length;
  // skip optional leading CRLF or --
  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // final --
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const next = indexOf(buf, boundary, start);
    if (next < 0) break;
    let end = next;
    // part ends before boundary; remove preceding CRLF
    if (end >= 2 && buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    parts.push(buf.slice(start, end));
    start = next + boundary.length;
  }
  return parts;
}

function indexOf(buf, pattern, from) {
  for (let i = from; i <= buf.length - pattern.length; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (buf[i + j] !== pattern[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

module.exports = { parseMultipart };

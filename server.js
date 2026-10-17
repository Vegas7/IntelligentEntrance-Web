// 智能通行 Web 版 —— 零依赖 Node.js 服务
// 1) 托管 public/ 下的静态页面
// 2) 把 /api/<path> 转发到 https://www.infoxs.com.cn:15000/building_app_api/<path>
//    （官方服务器对任何带 Origin 的跨域请求返回 403，浏览器无法直连，所以需要同源代理）
//
// 用法: node server.js            默认监听 0.0.0.0:8080
//       PORT=3000 HOST=127.0.0.1 node server.js

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM_HOST = 'www.infoxs.com.cn';
const UPSTREAM_PORT = 15000;
const UPSTREAM_PREFIX = '/building_app_api/';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 16 * 1024;

// 只放行本应用用到的接口，避免成为开放代理
const ALLOWED = new Set([
  'POST auth/get_token',
  'POST sms_verification/send',
  'POST user/get_user',
  'POST building/read_relation_building_list',
  'POST floor/read_list',
  'POST user/get_default_floor',
  'POST user/modify_default_floor',
  'POST v2/user/get_commuter_code',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function proxy(req, res, apiPath) {
  if (!ALLOWED.has(`${req.method} ${apiPath}`)) {
    return send(res, 404, { value: 404, description: `接口未开放: ${req.method} ${apiPath}` });
  }

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      send(res, 413, { value: 413, description: '请求体过大' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    const body = Buffer.concat(chunks);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    // 只转发鉴权头，不转发 Origin / Referer / Cookie
    const auth = req.headers['authorization'];
    if (auth) {
      headers['Authorization'] = auth;
      headers['Token'] = auth;
    }
    if (req.method !== 'GET') headers['Content-Length'] = body.length;

    const started = Date.now();
    const upstream = https.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method: req.method,
        path: UPSTREAM_PREFIX + apiPath,
        headers,
        timeout: 15000,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, {
          'Content-Type': up.headers['content-type'] || 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        up.pipe(res);
        console.log(`${new Date().toISOString()} ${req.method} /api/${apiPath} -> ${up.statusCode} (${Date.now() - started}ms)`);
      }
    );
    upstream.on('timeout', () => upstream.destroy(new Error('上游超时')));
    upstream.on('error', (e) => {
      console.log(`${new Date().toISOString()} ${req.method} /api/${apiPath} -> ERROR ${e.message}`);
      if (!res.headersSent) send(res, 502, { value: 502, description: `代理请求失败: ${e.message}` });
      else res.end();
    });
    if (req.method !== 'GET') upstream.write(body);
    upstream.end();
  });
}

function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { description: 'Method Not Allowed' });
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { description: 'Forbidden' });

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      ETag: etag,
      // 浏览器每次带 ETag 校验，未修改时只回 304（几乎零流量），更新后立刻生效
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    fs.readFile(file, (err2, data) => {
      if (err2) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Read Error');
      }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath.startsWith('/api/')) return proxy(req, res, urlPath.slice(5));
  if (urlPath === '/healthz') return send(res, 200, { ok: true });
  serveStatic(req, res, urlPath);
});

server.listen(PORT, HOST, () => {
  console.log(`智能通行 Web 版已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

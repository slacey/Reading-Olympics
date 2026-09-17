const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_TARGET = 'https://www.worldreader.org/challenges-stats/current.json';

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100000) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function requestRemote(targetUrl, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = targetUrl.protocol === 'https:' ? https : http;
    const request = client.request(targetUrl, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Worldreader-Reading-Olympics/1.1',
        'Accept': options.accept || 'application/json,text/plain,text/html,*/*',
        'Accept-Encoding': 'identity',
        ...(options.headers || {})
      }
    }, response => {
      if (options.followRedirects !== false && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 5) {
        response.resume();
        const next = new URL(response.headers.location, targetUrl);
        return resolve(requestRemote(next, {
          ...options,
          method: response.statusCode === 307 || response.statusCode === 308 ? options.method : 'GET',
          body: response.statusCode === 307 || response.statusCode === 308 ? options.body : undefined
        }, redirects + 1));
      }
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => raw += chunk);
      response.on('end', () => resolve({
        raw,
        status: response.statusCode || 0,
        headers: response.headers,
        url: targetUrl.toString()
      }));
    });
    request.setTimeout(15000, () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function validWorldreaderUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!(parsed.hostname === 'worldreader.org' || parsed.hostname.endsWith('.worldreader.org'))) return null;
  return parsed;
}

function textPreview(raw) {
  return raw.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function collectDataCandidates(source, baseUrl, out) {
  const decoded = source.replace(/\\\//g, '/').replace(/\\u002F/gi, '/').replace(/&amp;/g, '&');
  const patterns = [
    /["'`](https?:\/\/[^"'`\s<>]+\.json(?:\?[^"'`\s<>]*)?)["'`]/gi,
    /["'`]((?:\.\.\/|\.\/|\/)[^"'`\s<>]*\.json(?:\?[^"'`\s<>]*)?)["'`]/gi,
    /(?:fetch|axios\.get|d3\.json)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\.open\s*\(\s*["'`](?:GET|POST)["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi
  ];
  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      try {
        const candidate = new URL(match[1], baseUrl);
        if (['http:', 'https:'].includes(candidate.protocol) && !/elementor-pro\/modules\/lottie/.test(candidate.href)) out.add(candidate.href);
      } catch {}
    }
  }
}

function collectLinkedResources(source, baseUrl) {
  const urls = new Map();
  for (const match of source.matchAll(/<(script|iframe)\b[^>]*?\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[2].replace(/&amp;/g, '&'), baseUrl);
      if (['http:', 'https:'].includes(url.protocol)) urls.set(url.href, match[1].toLowerCase());
    } catch {}
  }
  return [...urls].map(([url, type]) => ({ url, type }));
}

function serveStatic(req, res) {
  let pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8'
    };
    send(res, 200, data, types[ext] || 'application/octet-stream');
  });
}

async function proxyJson(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const target = requestUrl.searchParams.get('url') || DEFAULT_TARGET;

  const targetUrl = validWorldreaderUrl(target);
  if (!targetUrl) return send(res, 400, JSON.stringify({ error: 'Enter a valid worldreader.org URL' }), 'application/json; charset=utf-8');
  try {
    const upstream = await requestRemote(targetUrl, { accept: 'application/json,text/plain,*/*' });
    let parsed;
    try { parsed = JSON.parse(upstream.raw); } catch {
      const looksHtml = /text\/html/i.test(upstream.headers['content-type'] || '') || /^\s*</.test(upstream.raw);
      const detail = looksHtml
        ? `The URL returned an HTML page (HTTP ${upstream.status}), not JSON. ${textPreview(upstream.raw)}`
        : `The URL returned HTTP ${upstream.status}, but its response was not valid JSON.`;
      return send(res, 502, JSON.stringify({ error: detail, status: upstream.status, contentType: upstream.headers['content-type'] || null }, null, 2), 'application/json; charset=utf-8');
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      return send(res, 502, JSON.stringify({ error: `The JSON endpoint returned HTTP ${upstream.status}`, status: upstream.status }), 'application/json; charset=utf-8');
    }
    send(res, 200, JSON.stringify({ fetchedFrom: upstream.url, fetchedAt: new Date().toISOString(), upstreamStatus: upstream.status, data: parsed }), 'application/json; charset=utf-8');
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), 'application/json; charset=utf-8');
  }
}

async function discoverJson(req, res) {
  try {
    const input = JSON.parse(await readBody(req) || '{}');
    const pageUrl = validWorldreaderUrl(input.pageUrl || 'https://www.worldreader.org/challenges-stats/');
    if (!pageUrl) return send(res, 400, JSON.stringify({ error: 'Enter a valid worldreader.org page URL' }), 'application/json; charset=utf-8');
    let cookie = '';
    if (input.password) {
      const body = new URLSearchParams({ post_password: String(input.password), Submit: 'Enter', redirect_to: pageUrl.toString() }).toString();
      const login = await requestRemote(new URL('https://www.worldreader.org/wp-login.php?action=postpass'), {
        method: 'POST', body,
        followRedirects: false,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      });
      cookie = (login.headers['set-cookie'] || []).map(v => v.split(';')[0]).join('; ');
    }
    const page = await requestRemote(pageUrl, { headers: cookie ? { Cookie: cookie } : {} });
    if (/post-password-form/.test(page.raw)) {
      return send(res, 401, JSON.stringify({ error: input.password ? 'The password was not accepted.' : 'This page is password-protected. Enter its password, then try Discover JSON URL.' }), 'application/json; charset=utf-8');
    }
    const found = new Set();
    collectDataCandidates(page.raw, pageUrl, found);

    const linked = collectLinkedResources(page.raw, pageUrl);
    const sameSite = linked.filter(item => {
      try {
        const host = new URL(item.url).hostname;
        return host === 'worldreader.org' || host.endsWith('.worldreader.org');
      } catch { return false; }
    }).slice(0, 35);
    const externalFrames = linked.filter(item => item.type === 'iframe' && !sameSite.some(same => same.url === item.url)).map(item => item.url);
    const inspected = [];

    await Promise.all(sameSite.map(async ({ url: resourceUrl }) => {
      try {
        const resource = await requestRemote(new URL(resourceUrl), { headers: cookie ? { Cookie: cookie } : {} });
        const type = resource.headers['content-type'] || '';
        if (resource.status >= 200 && resource.status < 300 && (/javascript|html|text\//i.test(type) || /\.(?:js|html?)(?:\?|$)/i.test(resourceUrl))) {
          inspected.push(resourceUrl);
          collectDataCandidates(resource.raw, resourceUrl, found);
          if (/html/i.test(type) || /<html|<iframe/i.test(resource.raw)) {
            for (const nested of collectLinkedResources(resource.raw, resourceUrl).slice(0, 10)) {
              if (/\.json(?:\?|$)/i.test(nested.url)) found.add(nested.url);
            }
          }
        }
      } catch {}
    }));

    const candidates = [...found].sort((a, b) => {
      const rank = value => /current\.json(?:\?|$)/i.test(value) ? 0 : /\.json(?:\?|$)/i.test(value) ? 1 : /wp-json|api|ajax/i.test(value) ? 2 : 3;
      return rank(a) - rank(b);
    });
    if (!candidates.length) return send(res, 404, JSON.stringify({
      error: `The page opened successfully and ${inspected.length} linked scripts or frames were inspected, but none contained a detectable JSON or API URL.`,
      inspectedResources: inspected,
      externalResources: externalFrames.slice(0, 10),
      nextStep: externalFrames.length ? 'The dashboard may be inside an external iframe. Copy one of the external resource URLs shown below into a browser and inspect its Network requests.' : 'Open the protected page in Chrome, choose DevTools → Network → Fetch/XHR, reload, and copy the request URL that returns the challenge data.'
    }, null, 2), 'application/json; charset=utf-8');
    send(res, 200, JSON.stringify({ candidates, inspectedResources: inspected, externalResources: externalFrames.slice(0, 10) }), 'application/json; charset=utf-8');
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), 'application/json; charset=utf-8');
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/fetch')) return proxyJson(req, res);
  if (req.url === '/api/discover' && req.method === 'POST') return discoverJson(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Worldreader JSON Viewer running at http://localhost:${PORT}`);
  console.log(`Default source: ${DEFAULT_TARGET}`);
});

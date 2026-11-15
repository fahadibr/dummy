const fetch = require('node-fetch');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

const FETCH_TIMEOUT_MS = 15000;

// Basic SSRF guard: only allow public http/https hosts. Blocks localhost,
// loopback, link-local and private-network targets from being fetched
// server-side via the shortener.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  }
  return false;
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Local/internal addresses are not allowed');
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve target host');
  }
  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('Internal/private addresses are not allowed');
  }
  return parsed;
}

const DROPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'set-cookie', // Domain= on the real site never matches our proxy host
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'cookie']);

// Per-link cookie jar. The real site's Set-Cookie headers are never forwarded
// to the browser (their Domain= never matches our proxy host, so the browser
// would just reject them) - but sites like Google rely on session/anti-abuse
// cookies (e.g. "AEC", "NID") being present on every request, and silently
// behave differently (simplified pages, consent/home redirects) without
// them. Keeping a jar per short code and replaying it server-side on every
// request to that target keeps the real site's session continuous.
const cookieJars = new Map(); // code -> Map(cookieName -> value)

function cookieHeaderFor(code) {
  const jar = cookieJars.get(code);
  if (!jar || jar.size === 0) return undefined;
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function updateCookieJar(code, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return;
  let jar = cookieJars.get(code);
  if (!jar) {
    jar = new Map();
    cookieJars.set(code, jar);
  }
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

// Same-origin absolute URLs (href="https://realsite/x", or "//realsite/x")
// get rewritten to point at our proxy host instead, so clicking them keeps
// the browser on our domain. Relative/root-relative URLs are left untouched
// -- they already resolve correctly against the current (proxy) subdomain,
// and so does any page JavaScript that builds new URLs from
// `location.origin`/`location.host`, which is what a path-prefix scheme
// cannot survive.
function rewriteSameOriginUrl(value, targetOrigin, proxyOrigin) {
  if (!value) return value;
  const trimmed = value.trim();
  if (
    trimmed === '' ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('tel:')
  ) {
    return value;
  }

  if (trimmed.startsWith('//')) {
    try {
      const resolved = new URL(`https:${trimmed}`);
      if (resolved.origin === targetOrigin) {
        return `//${new URL(proxyOrigin).host}${resolved.pathname}${resolved.search}${resolved.hash}`;
      }
    } catch {
      /* not a valid protocol-relative URL, leave as-is */
    }
    return value;
  }

  try {
    const resolved = new URL(trimmed);
    if (resolved.origin === targetOrigin) {
      return `${proxyOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
    }
  } catch {
    /* relative URL: nothing to rewrite */
  }
  return value;
}

function rewriteCssUrls(css, targetOrigin, proxyOrigin) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
    const rewritten = rewriteSameOriginUrl(url, targetOrigin, proxyOrigin);
    return `url(${quote}${rewritten}${quote})`;
  });
}

function rewriteHtml(html, targetOrigin, proxyOrigin) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const rw = (v) => rewriteSameOriginUrl(v, targetOrigin, proxyOrigin);

  $('[href]').each((_, el) => $(el).attr('href', rw($(el).attr('href'))));
  $('[src]').each((_, el) => $(el).attr('src', rw($(el).attr('src'))));
  $('form[action]').each((_, el) => $(el).attr('action', rw($(el).attr('action'))));
  $('[srcset]').each((_, el) => {
    const rewritten = $(el)
      .attr('srcset')
      .split(',')
      .map((part) => {
        const [url, descriptor] = part.trim().split(/\s+/, 2);
        return [rw(url), descriptor].filter(Boolean).join(' ');
      })
      .join(', ');
    $(el).attr('srcset', rewritten);
  });
  $('[style]').each((_, el) => {
    $(el).attr('style', rewriteCssUrls($(el).attr('style'), targetOrigin, proxyOrigin));
  });
  $('style').each((_, el) => {
    $(el).text(rewriteCssUrls($(el).text(), targetOrigin, proxyOrigin));
  });
  $('meta[http-equiv="refresh" i]').each((_, el) => {
    const content = $(el).attr('content') || '';
    const match = content.match(/^(\d+)\s*;\s*url=(.+)$/i);
    if (match) {
      $(el).attr('content', `${match[1]};url=${rw(match[2])}`);
    }
  });
  $('meta[http-equiv="Content-Security-Policy" i]').remove();

  return $.html();
}

async function fetchTarget(targetUrl, req, code) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!DROPPED_REQUEST_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
      headers[key] = value;
    }
  }
  headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (compatible; TinyProxy/1.0)';
  const cookieHeader = cookieHeaderFor(code);
  if (cookieHeader) headers['cookie'] = cookieHeader;

  const hasBody = !['GET', 'HEAD'].includes(req.method);

  try {
    return await fetch(targetUrl, {
      method: req.method,
      redirect: 'follow',
      signal: controller.signal,
      headers,
      body: hasBody ? req : undefined,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// `link`: the stored { code, target_url } row. `opts.proxyHost` is the
// host (with port) the browser used to reach us, e.g. "abc123.tiny.local:8080".
async function proxyTargetToResponse(link, req, res, opts) {
  const targetOrigin = new URL(link.target_url).origin;
  const proxyOrigin = `${opts.proxyProtocol}://${opts.proxyHost}`;

  // By the time we get here, server.js has already redirected the bare "/"
  // entry hit to the shortened URL's real path/query, so every request's
  // path/query maps straight onto the real origin, consistently.
  const realUrl = `${targetOrigin}${req.originalUrl}`;

  const response = await fetchTarget(realUrl, req, link.code);
  const contentType = response.headers.get('content-type') || '';

  updateCookieJar(link.code, response.headers.raw()['set-cookie']);

  res.status(response.status);
  for (const [key, value] of response.headers.entries()) {
    if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }

  if (contentType.includes('text/html')) {
    const html = await response.text();
    const rewritten = rewriteHtml(html, targetOrigin, proxyOrigin);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(rewritten);
    return;
  }

  if (contentType.includes('text/css')) {
    const css = await response.text();
    res.setHeader('content-type', 'text/css; charset=utf-8');
    res.send(rewriteCssUrls(css, targetOrigin, proxyOrigin));
    return;
  }

  response.body.pipe(res);
}

module.exports = { assertPublicUrl, proxyTargetToResponse };

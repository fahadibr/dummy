const path = require('path');
const express = require('express');
const { customAlphabet } = require('nanoid');

const { createLink, getLink, codeExists, listLinks } = require('./db');
const { assertPublicUrl, proxyTargetToResponse } = require('./proxy');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'tiny.test';
// Subdomain-per-link (code.BASE_DOMAIN) needs wildcard DNS (*.BASE_DOMAIN ->
// this server). Without that set up yet, set SUBDOMAIN_MODE=false to fall
// back to path-based links (BASE_DOMAIN/code) on the single domain - see
// proxy.js's pathPrefix handling for how that keeps root-relative URLs (and
// JS that builds them from location.origin) from escaping the link's code.
const SUBDOMAIN_MODE = process.env.SUBDOMAIN_MODE !== 'false';
// Google Programmable Search Engine ID. When set, Google search links are
// served as a results page on our own domain using Google's official
// embeddable search element, instead of being proxied server-side (Google
// flags server-side proxied search traffic as a bot; the embed runs in the
// visitor's own browser, so it doesn't).
const GOOGLE_PSE_CX = process.env.GOOGLE_PSE_CX || '';
const CODE_LENGTH = 8;
// Lowercase letters + digits only: safe as a DNS label in every resolver,
// unlike nanoid's default alphabet (which includes "_" and "-").
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', CODE_LENGTH);

app.set('trust proxy', true);

function hostHeaderSuffix(req) {
  const hostHeader = req.get('host') || BASE_DOMAIN; // may include :port
  return hostHeader.includes(':') ? hostHeader.slice(hostHeader.indexOf(':')) : '';
}

function shortUrlFor(req, code) {
  const portSuffix = hostHeaderSuffix(req);
  return SUBDOMAIN_MODE
    ? `${req.protocol}://${code}.${BASE_DOMAIN}${portSuffix}`
    : `${req.protocol}://${BASE_DOMAIN}${portSuffix}/${code}`;
}

// Returns the search query for a Google search/home URL, or null for anything
// else (including when no PSE is configured).
function googleSearchQuery(targetUrl) {
  if (!GOOGLE_PSE_CX) return null;
  const url = new URL(targetUrl);
  if (!/^(www\.)?google\.[a-z.]+$/i.test(url.hostname)) return null;
  if (url.pathname !== '/' && url.pathname !== '/search') return null;
  return url.searchParams.get('q') || '';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The search element runs a search automatically on load when the page URL
// carries the `q` query parameter, so callers redirect to `?q=...` first.
function googleSearchPage(query) {
  const title = query ? `${escapeHtml(query)} - Search` : 'Search';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:arial,sans-serif;max-width:900px;margin:0 auto;padding:16px;background:#fff}</style>
<script async src="https://cse.google.com/cse.js?cx=${encodeURIComponent(GOOGLE_PSE_CX)}"></script>
</head><body>
<div class="gcse-searchbox" data-queryParameterName="q"></div>
<div class="gcse-searchresults" data-linkTarget="_self"></div>
</body></html>`;
}

// Serves the Google search page if `link` is a Google search link. Handles
// the redirect to `basePath?q=...` when the URL doesn't carry the query yet.
function serveGoogleSearch(link, req, res, basePath) {
  const query = googleSearchQuery(link.target_url);
  if (query === null) return false;
  if (req.query.q === undefined && query) {
    res.redirect(302, `${basePath}?q=${encodeURIComponent(query)}`);
  } else {
    res.send(googleSearchPage(typeof req.query.q === 'string' ? req.query.q : query));
  }
  return true;
}

function subdomainCode(hostname) {
  if (!hostname.endsWith(`.${BASE_DOMAIN}`)) return null;
  return hostname.slice(0, hostname.length - BASE_DOMAIN.length - 1);
}

// Each short link gets its own subdomain (code.BASE_DOMAIN) rather than a
// path prefix. That way, when a proxied page's own JavaScript builds new
// URLs from `location.origin`/`location.host` (very common on JS-heavy
// sites), it naturally stays on our domain instead of leaking the real one -
// a path-prefix scheme can't survive that, since such JS ignores the path.
//
// This runs before any body-parsing middleware so non-GET requests (forms,
// XHR/fetch posts the proxied page makes) can still be streamed through with
// their original body intact.
app.use(async (req, res, next) => {
  const code = subdomainCode(req.hostname);
  if (!code) return next(); // root domain: fall through to the routes below

  const link = await getLink(code);
  if (!link) return res.status(404).send('Unknown short link');

  if (req.method === 'GET' && (req.path === '/' || req.path === '/search') && serveGoogleSearch(link, req, res, '/')) {
    return;
  }

  // The very first hit is the bare subdomain root ("/"), but the shortened
  // URL may have had its own path/query (e.g. a Google search results page).
  // Redirect once to that real path (still on our subdomain, so the address
  // bar stays ours) so the browser's own location matches it from then on -
  // otherwise every *relative* link on the page (not just absolute ones)
  // would resolve against the wrong ("/") path and silently load the wrong
  // content.
  if (req.originalUrl === '/') {
    const target = new URL(link.target_url);
    const entryPath = `${target.pathname}${target.search}`;
    if (entryPath !== '/') {
      return res.redirect(302, `${req.protocol}://${req.get('host')}${entryPath}`);
    }
  }

  try {
    await proxyTargetToResponse(link, req, res, {
      proxyHost: req.get('host'),
      proxyProtocol: req.protocol,
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send(`Could not load target page: ${err.message}`);
    } else {
      res.end();
    }
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/shorten', express.json(), async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Body must include a "url" string' });
  }

  let parsed;
  try {
    parsed = await assertPublicUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let code;
  do {
    code = nanoid();
  } while (await codeExists(code));

  await createLink(code, parsed.toString());

  return res.json({ code, targetUrl: parsed.toString(), shortUrl: shortUrlFor(req, code) });
});

app.get('/api/links', async (req, res) => {
  const links = (await listLinks()).map((l) => ({ ...l, shortUrl: shortUrlFor(req, l.code) }));
  res.json(links);
});

// Path-mode entry point: BASE_DOMAIN/<code>. In subdomain mode this is just a
// convenience bounce to the real subdomain link (still entirely our own
// domain). In path mode (no wildcard DNS) this *is* the real link - it
// redirects once to BASE_DOMAIN/<code>/<real-path-and-query>, same reasoning
// as the subdomain entry redirect above.
app.get('/:code', async (req, res) => {
  const link = await getLink(req.params.code);
  if (!link) return res.status(404).send('Unknown short link');

  if (SUBDOMAIN_MODE) {
    return res.redirect(`${shortUrlFor(req, req.params.code)}/`);
  }

  if (serveGoogleSearch(link, req, res, `/${req.params.code}`)) return;

  const target = new URL(link.target_url);
  const entryPath = `${target.pathname}${target.search}`;
  return res.redirect(302, `${shortUrlFor(req, req.params.code)}${entryPath}`);
});

// Path-mode proxying for everything under /<code>/... - only reachable (and
// only needed) when SUBDOMAIN_MODE is off.
app.all('/:code/*', async (req, res) => {
  const link = await getLink(req.params.code);
  if (!link) return res.status(404).send('Unknown short link');

  // Older links (and bookmarks) already landed on /<code>/search?... before
  // the search page existed - send those to the search page too.
  if (req.method === 'GET' && req.path === `/${req.params.code}/search` && googleSearchQuery(link.target_url) !== null) {
    const q = typeof req.query.q === 'string' ? req.query.q : googleSearchQuery(link.target_url);
    return res.redirect(302, `/${req.params.code}?q=${encodeURIComponent(q)}`);
  }

  try {
    await proxyTargetToResponse(link, req, res, {
      proxyHost: req.get('host'),
      proxyProtocol: req.protocol,
      pathPrefix: `/${req.params.code}`,
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send(`Could not load target page: ${err.message}`);
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(
    `tiny-proxy-shortener listening on http://localhost:${PORT} (base domain: ${BASE_DOMAIN}, subdomain mode: ${SUBDOMAIN_MODE})`
  );
});

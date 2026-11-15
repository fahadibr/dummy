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

// Overrides for the search element's own markup (.gsc-*/.gs-*). Clean results
// layout only - deliberately no Google logo or name, so the page can't pass
// for google.com itself.
const SEARCH_PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:arial,sans-serif;color:#202124;background:#fff}
header{display:flex;align-items:center;gap:28px;padding:20px 24px 12px;border-bottom:1px solid #ebebeb}
.brand{font-size:22px;font-weight:bold;color:#5f6368;text-decoration:none;white-space:nowrap}
.box{flex:1;max-width:690px}
main{padding:0 24px 40px;max-width:900px}
@media (min-width:900px){main{margin-left:118px}}
@media (max-width:600px){header{flex-direction:column;align-items:stretch;gap:12px;padding:16px}main{padding:0 16px 32px}}

.gsc-control-searchbox-only,.gsc-control-cse{padding:0!important;border:0!important;background:transparent!important}
form.gsc-search-box,table.gsc-search-box{margin:0!important}
.gsc-input-box{border:1px solid #dfe1e5!important;border-radius:24px!important;padding:6px 14px!important;background:#fff!important;box-shadow:none!important}
.gsc-input-box:hover,.gsc-input-box-focus{box-shadow:0 1px 6px rgba(32,33,36,.28)!important;border-color:transparent!important}
input.gsc-input{font-size:16px!important;background:none!important}
.gsc-search-button-v2{border:0!important;border-radius:24px!important;background:#fff!important;padding:10px 14px!important;cursor:pointer}
.gsc-search-button-v2 svg{fill:#4285f4!important;width:18px!important;height:18px!important}

.gsc-tabsArea{border:0!important;margin:8px 0 4px!important}
.gsc-tabHeader{font-size:14px!important;color:#5f6368!important;background:none!important;border:0!important;padding:8px 12px 10px!important}
.gsc-tabHeader.gsc-tabhActive{color:#1a73e8!important;border-bottom:3px solid #1a73e8!important}
.gsc-above-wrapper-area{border:0!important;padding:4px 0 12px!important}
.gsc-result-info{font-size:14px!important;color:#70757a!important;padding-left:0!important}

.gsc-webResult.gsc-result,.gsc-results .gsc-imageResult{border:0!important;background:none!important;padding:0!important;margin:0 0 28px!important}
.gs-webResult .gs-title,.gs-webResult .gs-title *{font-size:20px!important;line-height:1.3!important;color:#1a0dab!important;text-decoration:none!important}
.gs-webResult .gs-title:hover *{text-decoration:underline!important}
.gs-webResult .gs-visibleUrl,.gsc-url-top *{font-size:14px!important;color:#202124!important}
.gs-webResult .gs-snippet{font-size:14px!important;line-height:1.58!important;color:#4d5156!important}
.gsc-table-cell-thumbnail{padding-right:16px!important}

.gsc-cursor-box{margin:24px 0!important;text-align:left!important}
.gsc-cursor-page{font-size:14px!important;color:#1a0dab!important;margin-right:14px!important}
.gsc-cursor-current-page{color:#202124!important;font-weight:bold!important}

/* If the engine's control-panel layout is "Overlay", results render into a
   hidden popup - show that wrapper inline as part of the page instead. */
body main .gsc-results-wrapper-overlay,body main .gsc-results-wrapper-overlay.gsc-results-wrapper-visible{position:static!important;top:auto!important;left:auto!important;display:block!important;visibility:visible!important;opacity:1!important;width:auto!important;height:auto!important;max-height:none!important;overflow:visible!important;box-shadow:none!important;padding:0!important;margin:0!important;background:none!important;transform:none!important}
.gsc-results-close-btn,.gsc-modal-background-image{display:none!important}
`;

// The search element runs a search automatically on load when the page URL
// carries the `q` query parameter, so callers redirect to `?q=...` first.
function googleSearchPage(query) {
  const title = query ? `${escapeHtml(query)} - Search` : 'Search';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${SEARCH_PAGE_CSS}</style>
<script async src="https://cse.google.com/cse.js?cx=${encodeURIComponent(GOOGLE_PSE_CX)}"></script>
</head><body>
<header>
  <span class="brand">Search</span>
  <div class="box"><div class="gcse-searchbox" data-queryParameterName="q"></div></div>
</header>
<main><div class="gcse-searchresults" data-linkTarget="_self"></div></main>
<script>
(function () {
  var q = ${JSON.stringify(query).replace(/</g, '\\u003c')};
  var tries = 0;
  var timer = setInterval(function () {
    var input = document.querySelector('input.gsc-input');
    if (input && !input.value) input.value = q;
    if (input || ++tries > 50) clearInterval(timer);
  }, 100);
})();
</script>
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

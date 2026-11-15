const path = require('path');
const express = require('express');
const { customAlphabet } = require('nanoid');

const { createLink, getLink, codeExists, listLinks } = require('./db');
const { assertPublicUrl, proxyTargetToResponse } = require('./proxy');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'tiny.test';
const CODE_LENGTH = 8;
// Lowercase letters + digits only: safe as a DNS label in every resolver,
// unlike nanoid's default alphabet (which includes "_" and "-").
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', CODE_LENGTH);

app.set('trust proxy', true);

function shortUrlFor(req, code) {
  const hostHeader = req.get('host') || BASE_DOMAIN; // may include :port
  const portSuffix = hostHeader.includes(':') ? hostHeader.slice(hostHeader.indexOf(':')) : '';
  return `${req.protocol}://${code}.${BASE_DOMAIN}${portSuffix}`;
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
function subdomainCode(hostname) {
  if (!hostname.endsWith(`.${BASE_DOMAIN}`)) return null;
  return hostname.slice(0, hostname.length - BASE_DOMAIN.length - 1);
}

app.use(async (req, res, next) => {
  const code = subdomainCode(req.hostname);
  if (!code) return next(); // root domain: fall through to the routes below

  const link = await getLink(code);
  if (!link) return res.status(404).send('Unknown short link');

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

// Convenience: pasting the root-domain form of a link (no subdomain) bounces
// to the real subdomain link, still entirely on our own domain.
app.get('/:code', async (req, res) => {
  const link = await getLink(req.params.code);
  if (!link) return res.status(404).send('Unknown short link');
  res.redirect(`${shortUrlFor(req, req.params.code)}/`);
});

app.listen(PORT, () => {
  console.log(`tiny-proxy-shortener listening on http://localhost:${PORT} (base domain: ${BASE_DOMAIN})`);
});

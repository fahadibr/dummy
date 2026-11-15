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
// Brave Search API key. When set, Google search links are served as a
// whole-web results page on our own domain, rendered from the Brave Search
// API (called server-side so the key stays secret). This replaces the
// Google PSE path, which Google has limited to configured sites only.
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
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
// else (including when no search backend is configured).
function googleSearchQuery(targetUrl) {
  if (!GOOGLE_PSE_CX && !BRAVE_API_KEY) return null;
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
/* Favicon chip + site name/url line, like a modern Google result header. */
.site-chip{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.site-chip .fav{width:26px;height:26px;border-radius:50%;border:1px solid #ececec;background:#f1f3f4;flex:none}
.site-chip .meta{display:flex;flex-direction:column;line-height:1.3;overflow:hidden}
.site-chip .name{font-size:14px;color:#202124;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.site-chip .url{font-size:12px;color:#5f6368;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gsc-url-top,.gs-webResult .gs-visibleUrl-short,.gs-webResult .gs-visibleUrl-long{display:none!important}
.gs-webResult .gs-title,.gs-webResult .gs-title *{font-size:20px!important;line-height:1.3!important;color:#1a0dab!important;text-decoration:none!important}
.gs-webResult .gs-title:hover *{text-decoration:underline!important}
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

// Dispatches to the Brave-backed page (whole-web results) when a Brave key is
// configured, otherwise the Google PSE page.
function googleSearchPage(query) {
  return BRAVE_API_KEY ? braveSearchPage(query) : psePage(query);
}

// The search element runs a search automatically on load when the page URL
// carries the `q` query parameter, so callers redirect to `?q=...` first.
function psePage(query) {
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

  // Add a favicon + site-name header above each result, the way modern
  // Google results look. The favicon comes from Google's public favicon
  // service; everything else is taken from the result's own visible URL.
  function hostFrom(result) {
    var a = result.querySelector('.gs-title a.gs-title');
    try { return new URL(a.getAttribute('data-ctorig') || a.href).hostname.replace(/^www\\./, ''); }
    catch (e) { var u = result.querySelector('.gs-visibleUrl'); return u ? u.textContent.trim().split('/')[0].replace(/^www\\./, '') : ''; }
  }
  function decorate(result) {
    if (result.querySelector('.site-chip')) return;
    var host = hostFrom(result);
    if (!host) return;
    var crumbEl = result.querySelector('.gs-visibleUrl-breadcrumb') || result.querySelector('.gs-visibleUrl');
    var crumb = crumbEl ? crumbEl.textContent.trim().replace(/^https?:\\/\\//, '').replace(/^www\\./, '') : host;
    var chip = document.createElement('div');
    chip.className = 'site-chip';
    chip.innerHTML = '<img class="fav" referrerpolicy="no-referrer" src="https://www.google.com/s2/favicons?sz=64&domain=' +
      encodeURIComponent(host) + '"><div class="meta"><span class="name"></span><span class="url"></span></div>';
    chip.querySelector('.name').textContent = host;
    chip.querySelector('.url').textContent = crumb;
    var title = result.querySelector('.gsc-thumbnail-inside') || result;
    title.insertBefore(chip, title.firstChild);
  }
  var obs = new MutationObserver(function () {
    document.querySelectorAll('.gsc-webResult.gsc-result').forEach(decorate);
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
</script>
</body></html>`;
}

const BRAVE_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:arial,sans-serif;color:#202124;background:#fff}
header{display:flex;align-items:center;gap:28px;padding:20px 24px 0;border-bottom:1px solid #ebebeb}
.brand{font-size:22px;font-weight:bold;color:#5f6368;white-space:nowrap}
form.box{flex:1;max-width:690px;display:flex;align-items:center;gap:10px;border:1px solid #dfe1e5;border-radius:24px;padding:8px 16px;margin:0}
form.box:hover,form.box:focus-within{box-shadow:0 1px 6px rgba(32,33,36,.28);border-color:transparent}
form.box svg{width:18px;height:18px;fill:#9aa0a6;flex:none}
form.box input{flex:1;border:0;outline:0;font-size:16px;background:none}
.tabs{display:flex;gap:4px;padding:10px 24px 0;border-bottom:1px solid #ebebeb}
.tab{font-size:14px;color:#5f6368;padding:8px 12px 12px;cursor:pointer;border-bottom:3px solid transparent;background:none;border-top:0;border-left:0;border-right:0;font-family:inherit}
.tab.active{color:#1a73e8;border-bottom-color:#1a73e8}
main{padding:16px 24px 40px;max-width:900px}
@media (min-width:900px){main{margin-left:118px}}
@media (max-width:600px){header{flex-direction:column;align-items:stretch;gap:12px;padding:16px 16px 0}.tabs,main{padding-left:16px;padding-right:16px}}
.info{font-size:14px;color:#70757a;margin:4px 0 20px}
.res{margin:0 0 28px}
.chip{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.chip img{width:26px;height:26px;border-radius:50%;border:1px solid #ececec;background:#f1f3f4;flex:none;object-fit:cover}
.chip .meta{display:flex;flex-direction:column;line-height:1.3;overflow:hidden}
.chip .nm{font-size:14px;color:#202124;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip .u{font-size:12px;color:#5f6368;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.res .row{display:flex;gap:16px;justify-content:space-between}
.res .txt{min-width:0}
.res a.ti{font-size:20px;line-height:1.3;color:#1a0dab;text-decoration:none;display:inline-block;margin:2px 0}
.res a.ti:hover{text-decoration:underline}
.res .sn{font-size:14px;line-height:1.58;color:#4d5156}
.res .sn strong{color:#4d5156}
.res .thumb{width:116px;height:92px;border-radius:10px;object-fit:cover;flex:none;background:#f1f3f4}
.imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}
.imgs a{text-decoration:none;color:#202124}
.imgs img{width:100%;height:120px;object-fit:cover;border-radius:10px;background:#f1f3f4}
.imgs .cap{font-size:12px;color:#5f6368;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pager{display:flex;gap:18px;margin:28px 0}
.pager button{font-size:15px;color:#1a0dab;background:none;border:0;cursor:pointer;font-family:inherit}
.pager button[disabled]{color:#bdc1c6;cursor:default}
.state{font-size:14px;color:#70757a;padding:12px 0}
`;

// Whole-web results page backed by the Brave Search API. Deliberately no
// Google logo or branding - it must not pass for google.com itself. Results
// are fetched from our own /__tiny/search endpoint (which calls Brave
// server-side with the secret key).
function braveSearchPage(query) {
  const title = query ? `${escapeHtml(query)} - Search` : 'Search';
  const qJs = JSON.stringify(query == null ? '' : query).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${BRAVE_CSS}</style>
</head><body>
<header>
  <span class="brand">Search</span>
  <form class="box" onsubmit="go(event)">
    <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z"/></svg>
    <input id="q" name="q" autocomplete="off" aria-label="Search">
  </form>
</header>
<div class="tabs">
  <button class="tab active" data-type="web" onclick="setType('web')">Web</button>
  <button class="tab" data-type="images" onclick="setType('images')">Images</button>
</div>
<main id="main"><div class="state">Loading…</div></main>
<script>
var query = ${qJs};
var type = 'web';
var offset = 0;
var main = document.getElementById('main');
document.getElementById('q').value = query;

function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }
function snippet(s){ return esc(s).replace(/&lt;strong&gt;/g,'<strong>').replace(/&lt;\\/strong&gt;/g,'</strong>'); }
function go(e){ e.preventDefault(); var v=document.getElementById('q').value.trim(); if(!v)return;
  var u=new URL(location.href); u.searchParams.set('q',v); location.href=u.toString(); }
function setType(t){ if(t===type)return; type=t; offset=0;
  document.querySelectorAll('.tab').forEach(function(b){ b.classList.toggle('active', b.dataset.type===t); });
  load(); }

function renderWeb(d){
  if(!d.results || !d.results.length){ main.innerHTML='<div class="state">No results.</div>'; return; }
  var html='';
  d.results.forEach(function(r){
    var host=r.host||''; var crumb=(host+(r.path||'')).replace(/^www\\./,'');
    var fav=r.favicon||('https://www.google.com/s2/favicons?sz=64&domain='+encodeURIComponent(host));
    html+='<div class="res"><div class="chip"><img referrerpolicy="no-referrer" src="'+esc(fav)+'">'+
      '<div class="meta"><span class="nm">'+esc(r.name||host)+'</span><span class="u">'+esc(crumb)+'</span></div></div>'+
      '<div class="row"><div class="txt"><a class="ti" href="'+esc(r.url)+'">'+esc(r.title)+'</a>'+
      '<div class="sn">'+snippet(r.description)+'</div></div>'+
      (r.thumb?'<img class="thumb" referrerpolicy="no-referrer" src="'+esc(r.thumb)+'">':'')+'</div></div>';
  });
  html+='<div class="pager"><button onclick="prev()"'+(offset<=0?' disabled':'')+'>Previous</button>'+
    '<button onclick="next()"'+(d.more?'':' disabled')+'>Next</button></div>';
  main.innerHTML=html;
  window.scrollTo(0,0);
}
function renderImages(d){
  if(!d.results || !d.results.length){ main.innerHTML='<div class="state">No results.</div>'; return; }
  var html='<div class="imgs">';
  d.results.forEach(function(r){
    if(!r.src)return;
    html+='<a href="'+esc(r.url)+'"><img referrerpolicy="no-referrer" src="'+esc(r.src)+'"><div class="cap">'+esc(r.title||'')+'</div></a>';
  });
  main.innerHTML=html+'</div>';
  window.scrollTo(0,0);
}
function load(){
  main.innerHTML='<div class="state">Loading…</div>';
  fetch('/__tiny/search?type='+type+'&offset='+offset+'&q='+encodeURIComponent(query))
    .then(function(r){ return r.json(); })
    .then(function(d){ if(d.error){ main.innerHTML='<div class="state">Search error.</div>'; return; }
      type==='images'?renderImages(d):renderWeb(d); })
    .catch(function(){ main.innerHTML='<div class="state">Search failed. Try again.</div>'; });
}
function next(){ offset++; load(); }
function prev(){ if(offset>0){ offset--; load(); } }
if(query) load(); else main.innerHTML='';
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
  // Our own search backend is never a proxied target, even on a code subdomain.
  if (req.path.startsWith('/__tiny/')) return next();
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

// Server-side Brave Search proxy for the results page. The API key stays on
// the server; the browser only ever talks to this same-origin endpoint.
app.get('/__tiny/search', async (req, res) => {
  if (!BRAVE_API_KEY) return res.status(404).json({ error: 'search not configured' });
  const q = String(req.query.q || '').slice(0, 400).trim();
  if (!q) return res.json({ results: [] });
  const images = req.query.type === 'images';
  const offset = Math.max(0, Math.min(9, parseInt(req.query.offset, 10) || 0));
  const endpoint = images
    ? 'https://api.search.brave.com/res/v1/images/search'
    : 'https://api.search.brave.com/res/v1/web/search';
  const params = new URLSearchParams({ q });
  if (images) {
    params.set('count', '50');
  } else {
    params.set('count', '20');
    params.set('offset', String(offset));
  }
  try {
    const r = await fetch(`${endpoint}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
    });
    if (!r.ok) return res.status(502).json({ error: `upstream ${r.status}` });
    const data = await r.json();
    if (images) {
      const results = (data.results || []).map((it) => ({
        title: it.title,
        url: it.url,
        src: (it.thumbnail && it.thumbnail.src) || (it.properties && it.properties.url),
      }));
      return res.json({ type: 'images', results });
    }
    const list = (data.web && data.web.results) || [];
    const results = list.map((it) => ({
      title: it.title,
      url: it.url,
      description: it.description,
      host: (it.meta_url && it.meta_url.hostname) || '',
      path: (it.meta_url && it.meta_url.path) || '',
      favicon: (it.meta_url && it.meta_url.favicon) || '',
      name: (it.profile && it.profile.name) || (it.meta_url && it.meta_url.hostname) || '',
      thumb: (it.thumbnail && it.thumbnail.src) || '',
    }));
    return res.json({ type: 'web', results, more: results.length >= 20 });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
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

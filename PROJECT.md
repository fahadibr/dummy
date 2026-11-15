# Tiny URL Cloak — Project Summary

## Problem Statement

Build a URL shortener where:
- Any URL (originally motivated by Google URLs) can be converted into a "tiny" URL.
- When a user clicks the tiny URL, the **original site's content** is displayed.
- The **browser's address bar** should always show our own ("tiny") domain —
  never the real site's domain — no matter how deep the user navigates into
  the proxied site.
- Implemented using **nginx as a reverse proxy** in front of the application,
  deployed on our own domain.

This is a transparent reverse-proxy "cloaking" tool, not a redirect-based
shortener (redirect-based shorteners change the address bar to the real
site; this one does not).

## Final Architecture

```
Browser → nginx (reverse proxy, TLS termination) → Node/Express backend → target site
```

- **Backend**: Node.js + Express ([backend/server.js](backend/server.js),
  [backend/proxy.js](backend/proxy.js))
  - `POST /api/shorten` stores `{ code, target_url }` and returns a short URL.
  - Any request matching a stored code is proxied server-side: the backend
    fetches the real target URL, rewrites same-origin links, and streams the
    (rewritten) response back — the browser never navigates to the real
    site's origin.
  - **Storage**: SQLite locally (`backend/db.js`), Postgres in production via
    `DATABASE_URL` (so links survive restarts on hosts with ephemeral disks).
- **nginx**: reverse proxy + TLS termination in front of the Node app
  ([nginx/tiny.test.conf](nginx/tiny.test.conf) for local dev).
- **Two addressing modes**, both implemented, selected via `SUBDOMAIN_MODE`:
  1. **Subdomain-per-link** (`<code>.BASE_DOMAIN`) — the preferred mode.
     Needs wildcard DNS (`*.BASE_DOMAIN → server`). Because each link gets
     its own subdomain, any JavaScript on the proxied page that builds URLs
     from `location.origin`/`location.host` (very common on JS-heavy sites)
     naturally stays on our domain, and root-relative URLs (`/search?...`)
     resolve correctly without any rewriting.
  2. **Path-based** (`BASE_DOMAIN/<code>/...`) — fallback when wildcard DNS
     isn't available. The proxy rewrites root-relative and protocol-relative
     same-origin URLs to carry the `/<code>` prefix so the page still works,
     but this mode is inherently more fragile: JS that builds absolute URLs
     from `location.origin` will escape the prefix and leak the real domain.
- **Per-link cookie jar** (server-side): since the real site's `Set-Cookie`
  can never validly apply to our domain, the browser never holds them —  but
  the backend keeps a small per-link jar and replays it on every request to
  that target, so the target's own session/anti-abuse cookies stay
  consistent across the link's requests.
- **Header hygiene**: `Content-Security-Policy`, `X-Frame-Options`,
  `Strict-Transport-Security`, and `Set-Cookie` are stripped from the
  response the browser sees — keeping any of these would break the page or
  misbehave against our domain.
- **SSRF guard**: only public `http`/`https` hosts can be shortened; private/
  loopback/link-local IP ranges and `localhost`/`*.local` are rejected.

## Local Development Journey (notable gotchas)

1. **First working version** used a single domain + `<base href>` injection
   (classic reverse-proxy cloaking trick). Worked for static/server-rendered
   sites (Wikipedia, BBC) but broke on JS-heavy sites (Google Search): once
   the page's own JS builds a new URL from `location.origin`, the `<base>`
   tag can't influence it, and the real domain leaked into the address bar.
   → Pivoted to **subdomain-per-link**.
2. **`tiny.local` doesn't work** — macOS reserves the `.local` TLD for
   Bonjour/mDNS; `/etc/resolver` entries for it are silently ignored.
   → Switched to `tiny.test` (IANA-reserved for exactly this purpose).
3. **`nip.io` (public wildcard-DNS trick) doesn't work either** — modern
   Chrome's Private Network Access feature specifically detects and blocks
   background `fetch`/XHR calls from pages whose hostname looks public but
   resolves to a loopback/private address (`ERR_BLOCKED_BY_CLIENT`), exactly
   to close this kind of workaround.
   → Went back to genuine local DNS: `dnsmasq` + `/etc/resolver/tiny.test`.
4. **macOS wouldn't pick up a freshly-created `/etc/resolver/*` file** even
   after `dscacheutil -flushcache` / `killall -HUP mDNSResponder` (Sequoia
   15.6). A **Wi-Fi off/on toggle** (forces a network-config refresh) fixed
   it without a reboot.

## Deployment Journey

- Deployed to a real **VPS (AWS EC2, Ubuntu 24.04)** instead of a PaaS,
  because Render.com required credit-card verification even for its free
  tier, and entering payment details is something this assistant never does
  on a user's behalf.
- Stack on the VPS: Node 20 + nginx (both installed from scratch), app
  cloned from GitHub, run as a **systemd service** (auto-restart, survives
  reboot), nginx as the reverse proxy.
- **DNS/SSL detour**: the first domain used (`tiny.devzel.2bd.net`) is a
  subdomain of a free, heavily-shared dynamic-DNS service (`2bd.net`). Its
  Let's Encrypt rate limit (50 certs/week) is shared across *all* unrelated
  users of that free domain and kept being exhausted by other people before
  we could get a certificate. Switching to a different domain
  (`tiny.devzel.work.gd`) got a certificate immediately.
- Final production config: HTTPS via Let's Encrypt (`certbot --nginx`,
  auto-renewing), HTTP → HTTPS redirect, **path-based mode**
  (`SUBDOMAIN_MODE=false`) since wildcard DNS wasn't set up for this
  deployment.

## Known Limitation: Google Search specifically

This was the single hardest case, investigated in depth:

1. Google's search results page, once loaded, fires its own follow-up
   requests carrying session-bound continuation tokens (`sg_ss`, `sei`,
   etc.) — generated by Google's own client-side JS, not by anything the
   user or this tool does.
2. When our server replays one of these token-bearing requests to Google
   (from a different IP/context than the token was originally tied to),
   Google's abuse-detection system sometimes serves its own CAPTCHA/
   "unusual traffic" interstitial instead of real content.
3. That interstitial's own reCAPTCHA widget is registered to `google.com`'s
   domain key, so it **cannot work** when served from our domain anyway
   (`Invalid domain for site key`) — serving it as-is would just show the
   visitor an unsolvable dead end.
4. **Mitigations implemented** (all legitimate — no fingerprint spoofing, no
   IP rotation, no evading detection):
   - A per-link cookie jar (see above), so Google's own session cookies are
     consistently replayed.
   - Using the clean/canonical search URL form (`?q=...`) rather than a
     URL copied mid-session with Google's internal tracking parameters.
   - **Retry with backoff** for GET/HEAD requests (2–3 attempts, short
     delay) before giving up, since this check is sometimes transient.
   - **Graceful fallback**: when Google's bot-check page is detected
     (redirect to `/sorry/...`), the visitor is sent directly to the real
     Google URL instead of being shown a broken, unsolvable CAPTCHA page.
     The cloak intentionally "breaks" (shows `google.com` in the address
     bar) *only* for this one case, transparently, so the user can clear
     the check on Google's real page.
   - Attempted to neutralize the specific analytics beacon
     (`window.prs(...)`, Google's own client-side performance-telemetry
     call, unrelated to rendering results) that appeared to trigger the
     check — this did **not** reliably prevent it; Google's page is heavily
     obfuscated and evidently has more than one code path that can trigger
     the same check.
5. **Conclusion**: there is no reliable, 100%-of-the-time fix for Google
   Search specifically without building actual bot-detection evasion
   (residential/rotating proxies, browser-fingerprint spoofing, etc.) —
   which was explicitly ruled out, by mutual agreement with the user, as it
   would violate Google's Terms of Service. The graceful fallback is the
   final, accepted behavior for this case.
6. **Every other kind of site** (Wikipedia, BBC News, and ordinary sites in
   general) works reliably and was verified end-to-end, including deep
   pages, image/asset loading, and real browser testing — Google Search is
   an adversarial, worst-case target, not representative of the tool's
   typical use.

## Solution for Google Search: Programmable Search Engine embed

The root cause above is that Google sees search traffic coming from our
**server's** IP. The fix that keeps the visitor on our domain without
evading anything is to stop proxying Google search server-side and use
Google's own, officially embeddable search element instead:

- Set `GOOGLE_PSE_CX` to the Search engine ID of a Programmable Search Engine
  (created at programmablesearchengine.google.com with "Search the entire
  web" enabled).
- Google search links (`google.*/search?q=...` or the Google home page) are
  then served as a results page **on our own domain**
  (`https://tiny.devzel.work.gd/<code>?q=...`) that loads Google's
  `cse.js` element; it runs the search automatically from the `q` parameter.
- The search requests are made by the visitor's own browser through
  Google's sanctioned embed, so there is no bot-check, and the address bar
  stays on our domain.
- Tradeoffs: the page is Google's results widget, not a pixel-identical
  google.com page; the free tier shows ads; clicking a result goes to the
  result's real site.
- Without `GOOGLE_PSE_CX` set, Google links keep the previous proxy behaviour.

## Security Notes

- A GitHub Personal Access Token was briefly exposed in plaintext in a git
  remote URL during setup; it was removed from the repo config (replaced
  with a username-only URL relying on the credential store), and the user
  was advised to revoke/regenerate that token on GitHub.
- `node_modules/` and the local SQLite data file were found committed to git
  and were removed (`.gitignore` added) — important because
  platform-specific native binaries (`better-sqlite3`) committed from macOS
  would not run on the Linux deployment target.

## Repository Layout

```
backend/
  server.js   - Express app, routing (subdomain + path modes), shortening API
  proxy.js    - Fetch/rewrite engine, cookie jar, SSRF guard, bot-check fallback
  db.js       - SQLite (local) / Postgres (production via DATABASE_URL)
  public/     - Simple shorten-link form (index.html)
nginx/
  tiny.test.conf - Local dev reverse-proxy config (also the basis for production)
render.yaml   - Render.com Blueprint (web service + Postgres) - prepared but
                not used for the final deployment (card-verification required)
README.md     - Setup/run/deploy instructions
PROJECT.md    - This file
```

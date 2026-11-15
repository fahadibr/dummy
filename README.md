# Tiny URL Cloak

URL shortener jiska short link click karne par original site ka content dikhata
hai, lekin browser ke address bar me tab hamesha tiny-domain ka URL hi rehta
hai (redirect nahi hota — server khud target page fetch karke serve karta hai).

## Architecture: subdomain-per-link

Har short link ko apna **subdomain** milta hai — `<code>.BASE_DOMAIN` — path
prefix (`BASE_DOMAIN/<code>`) ke bajaye. Wajah: JS-heavy sites (jaise Google
Search) apni naye URLs `location.origin`/`location.host` se bana leti hain;
path-prefix scheme me ye JS us prefix ko ignore kar deti aur asli domain
leak ho jata. Subdomain scheme me aisi JS khud-ba-khud humari hi domain par
rehti hai, aur relative/root-relative links (`/search?q=x`) bhi bina kisi
rewriting ke sahi resolve ho jate hain (browser ka normal behaviour).

1. `backend/` ek Node/Express app hai ([server.js](backend/server.js),
   [proxy.js](backend/proxy.js), [db.js](backend/db.js)):
   - `POST /api/shorten` — koi bhi `http(s)://` URL do, 8-char code ke sath
     `http://<code>.BASE_DOMAIN[:port]` wapas milta hai.
   - Koi bhi request jiska Host header `*.BASE_DOMAIN` ho, wo subdomain-se-code
     nikal ke uska stored target URL server-side fetch karta hai aur response
     wapas stream kar deta hai (method/headers/body sab forward hote hain, na
     sirf GET).
   - Pehli visit (bare subdomain root `/`) ko turant shortened URL ke asal
     path/query par redirect kiya jata hai (subdomain wahi rehta hai) — isse
     page ke andar relative links bhi sahi (real site ke path ke against)
     resolve hote hain, sirf absolute wale nahi.
   - HTML responses me sirf wahi `href`/`src`/`action`/`srcset`/CSS `url()`
     rewrite hote hain jo **absolute aur target ke hi origin** ko point karte
     hain (e.g. `https://www.google.com/...`) — inhe proxy subdomain par
     rewrite kiya jata hai. Relative/root-relative URLs ko chhua nahi jata.
   - Non-HTML/CSS targets (image, PDF, JSON, etc.) seedha stream ho jate hain.
   - Har short-code ke liye ek chhota server-side cookie jar hai, taake target
     site ke session/anti-abuse cookies (e.g. Google ka `AEC`/`NID`) proxy ke
     through requests me carry ho sakein — browser khud ye cookies kabhi nahi
     dekhta (domain-mismatch ki wajah se beeka reject ho jate), par server
     unhe apni taraf se replay karta hai.
   - Basic SSRF guard hai: `localhost`, loopback, aur private-IP (10.x,
     192.168.x, 172.16-31.x, 169.254.x) hosts shorten/fetch nahi hote.
   - `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`
     aur `Set-Cookie` headers target se browser ko forward nahi hote (warna ya
     to browser block kar deta, ya future requests ko force-https kar deta, ya
     cookie domain-mismatch ki wajah se silently drop ho jati).
   - Storage: `DATABASE_URL` env var set ho to Postgres use hota hai (Render
     deployment), warna local SQLite file (`backend/links.db`).
2. `nginx/tiny.test.conf` — **sirf local testing** ke liye wildcard
   `server_name` ke saath is Node app ke aage reverse proxy karta hai. Render
   par ye zaroori nahi — Render khud hi TLS-terminating reverse proxy hai.

**Known limitations (scope ke mutabiq):**
- Login/session cookies (upar wale per-code jar ke alawa) browser ki taraf
  persist nahi hote.
- Agar target redirect karke kisi bilkul alag origin par chala jaye, to sirf
  original origin ke same-origin links hi rewrite hote hain.
- Google Search jaisi heavily bot-protected sites kabhi kabhi apna khud ka
  "unusual traffic" / CAPTCHA page dikha sakti hain — ye Google ki IP-based
  anti-abuse detection hai (proxy server ke outbound IP par), humare code ka
  bug nahi, aur kisi bhi hosting (local ya VPS) par ho sakta hai agar wahi IP
  se bohot zyada automated requests jayein.

## Local setup aur run (macOS, is repo me)

```bash
cd backend
npm install
PORT=3001 node server.js
```

> Port **3000** is machine par kisi aur project ke paas hai, isliye **3001**
> use kiya hai. `nginx/tiny.test.conf` already `proxy_pass http://127.0.0.1:3001;`
> par set hai.

### nginx wire-up (Homebrew nginx)

```bash
mkdir -p /opt/homebrew/etc/nginx/servers
ln -sf /Users/macbookpro/data/proj/tiny/nginx/tiny.test.conf \
  /opt/homebrew/etc/nginx/servers/tiny.test.conf
nginx -t && nginx -s reload   # pehli dafa chala rahe ho to sirf: nginx
```

### Wildcard local domain: `*.tiny.test`

`/etc/hosts` wildcard support nahi karta, isliye **dnsmasq** use kiya hai:
`/opt/homebrew/etc/dnsmasq.conf` me `address=/tiny.test/127.0.0.1` add hai.
Setup ke sudo steps:

```bash
echo "nameserver 127.0.0.1" | sudo tee /etc/resolver/tiny.test
sudo brew services start dnsmasq
```

> **macOS gotcha:** agar `scutil --dns | grep -A3 tiny.test` khaali aaye (naya
> `/etc/resolver/*` file turant pick nahi ho raha), to Wi-Fi ko menu bar se
> 5 second ke liye off/on karen — isse macOS apni network config refresh kar
> leta hai aur resolver file pick ho jati hai, bina reboot ke.
> (`.local` TLD kabhi use na karen — macOS use Bonjour/mDNS ke liye reserve
> karta hai aur `/etc/resolver` wahan kaam hi nahi karta.)

Phir browser me kholen: **http://tiny.test:8080/**

## Production: Render.com par deploy karna

Ye repo [render.yaml](render.yaml) ke through ek Render **Blueprint** hai —
Node web service + ek free Postgres database (links persist rahein, kyunki
Render ke free web-service disk restart/sleep par reset ho jati hai).

1. Render dashboard me **New → Blueprint** choose karen, apna GitHub repo
   (jisme ye code pushed hai) connect karen — Render `render.yaml` khud detect
   kar lega aur web service + database dono propose karega.
2. Deploy hone ke baad, web service ke **Environment** tab me `BASE_DOMAIN`
   set karen apne real domain se (e.g. `tiny.yourdomain.com` ya seedha
   `yourdomain.com`) — `render.yaml` me ye jaan-boojh kar khaali chhoda gaya
   hai (`sync: false`) kyunki ye aapka apna domain hona chahiye.
3. Web service ke **Settings → Custom Domains** me do entries add karen:
   - `yourdomain.com` (ya jo bhi aapne `BASE_DOMAIN` set kiya)
   - `*.yourdomain.com` (wildcard — subdomain-per-link ke liye zaroori)
   Render exact CNAME/A records bata dega jo apne DNS provider (GoDaddy,
   Namecheap, Cloudflare, waghera) par add karne honge. Render in domains ke
   liye khud hi TLS certificate issue/renew kar deta hai.
4. Koi nginx config Render par nahi chahiye — Render ka apna edge hi reverse
   proxy/TLS termination hai.

Local SQLite file (`backend/links.db`) **commit nahi** hoti (`.gitignore` me
hai) — Render par `DATABASE_URL` khud set ho jata hai jab Blueprint database
ko web service se link karta hai, aur `backend/db.js` is case me Postgres use
karta hai.

## Known trade-offs / aage badhane ke options

- Abhi sirf fetch/record/serve hota hai — delete/expire/analytics (clicks
  count) nahi hai; `backend/db.js` me easily add ho sakta hai.
- `assertPublicUrl` ka SSRF-guard basic hai; agar publicly expose kar rahe ho
  to rate-limiting aur allow/deny domain list add karna recommended hai.
- Is Mac par `dnsmasq` install/running hai (local testing ke liye) — agar
  chahein to hata sakte hain: `sudo brew services stop dnsmasq`.

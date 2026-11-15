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
   [proxy.js](backend/proxy.js)):
   - `POST /api/shorten` — koi bhi `http(s)://` URL do, 8-char code (SQLite
     me store) ke sath `http://<code>.BASE_DOMAIN[:port]` wapas milta hai.
   - Koi bhi request jiska Host header `*.BASE_DOMAIN` ho, wo subdomain-se-code
     nikal ke uska stored target URL server-side fetch karta hai aur response
     wapas stream kar deta hai (method/headers/body sab forward hote hain, na
     sirf GET).
   - HTML responses me sirf wahi `href`/`src`/`action`/`srcset`/CSS `url()`
     rewrite hote hain jo **absolute aur target ke hi origin** ko point karte
     hain (e.g. `https://www.google.com/...`) — inhe proxy subdomain par
     rewrite kiya jata hai. Relative/root-relative URLs ko chhua nahi jata,
     kyunki wo already current subdomain ke against sahi resolve ho jate hain.
   - Non-HTML/CSS targets (image, PDF, JSON, etc.) seedha stream ho jate hain.
   - Basic SSRF guard hai: `localhost`, loopback, aur private-IP (10.x,
     192.168.x, 172.16-31.x, 169.254.x) hosts shorten/fetch nahi hote.
   - `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`
     aur `Set-Cookie` headers target se forward nahi hote (warna ya to
     browser block kar deta, ya future requests ko force-https kar deta, ya
     cookie domain-mismatch ki wajah se silently drop ho jati — isliye
     explicitly hata diya).
2. `nginx/tiny.test.conf` — wildcard `server_name` ke saath is Node app ke
   aage reverse proxy karta hai (production me yehi TLS bhi terminate
   karega).

**Known limitations (scope ke mutabiq):**
- Agar shortened URL ka path root (`/`) nahi tha (e.g.
  `https://x.com/blog/post1`), aur baad me proxied page ke andar koi link
  literally `/` (root) par wapas jata hai, to wo original shortened URL hi
  dobara replay ho jata hai (asli site ka root nahi) — kyunki humare paas
  "pehli request" aur "baad me genuinely root ki request" me farq karne ka
  koi reliable tareeqa nahi (dono hi bare `/` path hote hain).
- Login/session cookies proxy ke through persist nahi hote (upar dekhein).
- Agar target redirect karke kisi bilkul alag origin par chala jaye, to
  sirf original origin ke same-origin links hi rewrite hote hain — naya
  origin automatically cloak nahi hoga.

## Local setup aur run

```bash
cd backend
npm install
PORT=3001 node server.js
```

> Note: is machine par port **3000** pehle se kisi aur project (dev server)
> ke paas hai, isliye backend **3001** par chalaya gaya hai. `nginx/tiny.test.conf`
> already `proxy_pass http://127.0.0.1:3001;` par set hai — agar backend port
> badlo to ye file bhi update karni hogi.

### nginx wire-up (is Mac par, Homebrew nginx)

```bash
mkdir -p /opt/homebrew/etc/nginx/servers
ln -sf /Users/macbookpro/data/proj/tiny/nginx/tiny.test.conf \
  /opt/homebrew/etc/nginx/servers/tiny.test.conf
nginx -t && nginx -s reload   # agar pehli dafa chala rahe ho to sirf: nginx
```

### Local wildcard domain: `127.0.0.1.nip.io`

Local testing ke liye `BASE_DOMAIN = 127.0.0.1.nip.io` use ho raha hai —
[nip.io](https://nip.io) ek public wildcard-DNS service hai: iska **koi bhi**
subdomain (`<anything>.127.0.0.1.nip.io`) seedha real DNS se `127.0.0.1`
resolve ho jata hai, koi local `/etc/hosts`/resolver config nahi chahiye.

> Humne pehle `tiny.local` phir `tiny.test` + dnsmasq try kiya tha, lekin is
> machine (macOS Sequoia 15.6) ki DNS config (`configd`) naya
> `/etc/resolver/*` file bina reboot ke pick hi nahi kar rahi thi — isliye
> `nip.io` par switch kiya, jo kisi local system-config par depend nahi
> karta (sirf internet par normal DNS lookup chahiye, jo site content fetch
> karne ke liye already chahiye hi tha).

Koi sudo/system-config step nahi chahiye — seedha browser me kholen:
**http://127.0.0.1.nip.io:8080/**

- Form me koi bhi URL (jaise `https://www.google.com/`) daal ke Shorten
  karen.
- Mila hua short link (e.g. `http://abc12345.127.0.0.1.nip.io:8080`) naye
  tab me kholen — content dikhega, lekin address bar me hamesha
  `*.127.0.0.1.nip.io:8080` hi rahega, chahe site ke andar JS kitni bhi
  navigation kare.

Already curl se end-to-end verify ho chuka hai:

```bash
curl -s -X POST http://127.0.0.1.nip.io:8080/api/shorten \
  -H 'Content-Type: application/json' -d '{"url":"https://www.wikipedia.org/"}'
curl -s http://<code>.127.0.0.1.nip.io:8080/
```

## Production par apne real domain ke sath deploy karna

1. Server par is repo ko copy karen, `cd backend && npm install`.
2. Backend ko supervise karen (e.g. `pm2 start server.js --name tiny` ya
   systemd service), `BASE_DOMAIN=yourdomain.com` env var ke saath.
3. DNS me apne domain ka **wildcard** A/AAAA record (`*.yourdomain.com`)
   server ke IP par point karen.
4. `nginx/tiny.test.conf` ko apne nginx config me copy/symlink karen aur:
   - `server_name 127.0.0.1.nip.io *.127.0.0.1.nip.io;` ko
     `server_name yourdomain.com *.yourdomain.com;` se replace karen.
   - `listen 8080;` ko `listen 80;` kar den.
5. Wildcard TLS cert (DNS-01 challenge chahiye, kyunki HTTP-01 wildcard ke
   sath kaam nahi karta):
   ```bash
   sudo certbot certonly --manual --preferred-challenges dns \
     -d yourdomain.com -d '*.yourdomain.com'
   ```
   (ya apne DNS provider ka certbot plugin use karen agar available ho),
   phir nginx me `listen 443 ssl;` + cert paths add karen.

## Known trade-offs / aage badhane ke options

- Abhi sirf fetch/record/serve hota hai — delete/expire/analytics (clicks
  count) nahi hai; `backend/db.js` me easily add ho sakta hai.
- `assertPublicUrl` ka SSRF-guard basic hai; agar publicly expose kar rahe ho
  to rate-limiting aur allow/deny domain list add karna recommended hai.
- `dnsmasq` is machine par install/running reh gaya hai lekin ab use nahi ho
  raha — agar chahein to hata sakte hain: `sudo brew services stop dnsmasq`.

# ESA Contact Mailer

<p align="center">
  <strong>A small Express contact-form mailer</strong><br/>
  SMTP notify + auto-reply · rate limit · honeypot · optional Alibaba Cloud ESA AI Captcha
</p>

<p align="center">
  <a href="https://github.com/Speakingplease/esa-contact-mailer/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="Node >= 18" /></a>
  <a href="https://github.com/Speakingplease/esa-contact-mailer/actions/workflows/ci.yml"><img src="https://github.com/Speakingplease/esa-contact-mailer/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/Speakingplease/esa-contact-mailer/issues"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome" /></a>
</p>

---

## Introduction

`esa-contact-mailer` is a single-process contact backend:

1. Accepts `POST /api/contact` with `{ email, message }`
2. Emails you (owner notify) via SMTP
3. Sends a polite auto-reply to the visitor
4. Ships with rate limiting, CORS allowlist, and a honeypot field

It is **tuned for Alibaba Cloud ESA AI Captcha** when you put ESA in front of `/api/contact`, but that layer is **optional**. Leave the captcha env vars blank and the service runs as a plain SMTP mailer.

---

## Features

- **SMTP forwarding** — QQ Mail by default; override host/port for Gmail, Outlook, or self-hosted SMTP
- **Owner notify + visitor auto-reply** — HTML + plain text templates
- **Anti-abuse basics** — CORS allowlist, 5 requests / 15 min rate limit, honeypot field `website`
- **Optional reverse-proxy token** — `X-Contact-Proxy-Token` so only your nginx path can mail
- **Optional Aliyun ESA AI Captcha** — edge verifies; origin does a presence check (clearly marked in code so you can soft-disable or hard-remove)

---

## Quick Start

```bash
git clone https://github.com/Speakingplease/esa-contact-mailer.git
cd esa-contact-mailer
npm install
cp .env.example .env
# edit .env — at minimum set SMTP_USER / SMTP_PASS / CONTACT_TO / ALLOWED_ORIGIN
npm start
```

Health check:

```bash
curl http://127.0.0.1:8787/api/health
```

Send a test message:

```bash
curl -X POST http://127.0.0.1:8787/api/contact \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:5173" \
  -d '{"email":"you@example.com","message":"Hello from curl"}'
```

Point your frontend contact form at `/api/contact` (or set a Vite/nginx proxy to `http://127.0.0.1:8787`).

---

## Configuration

Copy `.env.example` → `.env`.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SMTP_USER` | yes | — | SMTP username / mailbox |
| `SMTP_PASS` | yes | — | SMTP password or auth code |
| `CONTACT_TO` | no | `SMTP_USER` | Owner inbox for notifications |
| `SMTP_HOST` | no | `smtp.qq.com` | SMTP host |
| `SMTP_PORT` | no | `465` | SMTP port |
| `SMTP_SECURE` | no | `true` | TLS (`false` for STARTTLS setups) |
| `PORT` | no | `8787` | Listen port (bound to `127.0.0.1`) |
| `ALLOWED_ORIGIN` | no | `http://localhost:5173` | Comma-separated CORS allowlist |
| `FROM_DISPLAY_NAME` | no | `Website Contact` | From name in mail templates |
| `SITE_NAME` | no | hostname of first `ALLOWED_ORIGIN` | Footer brand in mail templates |
| `CONTACT_PROXY_TOKEN` | no | _(empty)_ | Shared secret with reverse proxy |
| `CAPTCHA_SCENE_ID` | no | _(empty)_ | Aliyun ESA captcha scene id |
| `CAPTCHA_REGION` | no | `cn` | `cn` or `sgp` |
| `ALIYUN_ACCESS_KEY_ID` | no | _(empty)_ | RAM AccessKey for captcha gate |
| `ALIYUN_ACCESS_KEY_SECRET` | no | _(empty)_ | RAM AccessKey secret |

For **QQ Mail**: enable SMTP in the mailbox settings and create an **authorization code** (not your login password).

---

## Optional: Aliyun ESA AI Captcha

This project is designed to sit behind **Alibaba Cloud ESA AI Captcha** (一点即过 / one-click) in production.

### Defense in depth

1. **ESA edge** verifies the challenge before traffic reaches origin
2. **This origin** only checks that a captcha verify param is present when captcha env vars are set (the edge already consumed the V3 token; calling OpenAPI again would return F018 reuse)
3. **Nginx** (or any reverse proxy) can send `X-Contact-Proxy-Token` matching `CONTACT_PROXY_TOKEN` so clients cannot hit the Node port directly

### Soft-disable (recommended for local / non-ESA setups)

Leave these blank in `.env`:

```bash
ALIYUN_ACCESS_KEY_ID=
ALIYUN_ACCESS_KEY_SECRET=
CAPTCHA_SCENE_ID=
```

`captchaConfigured` becomes `false` and every captcha branch is a no-op.

### Hard-remove

1. Delete every block in `index.js` between:
   ```
   // ===== BEGIN Aliyun ESA AI Captcha (optional) =====
   ...
   // ===== END Aliyun ESA AI Captcha =====
   ```
   (`captchaRows` defaults to `''`, so owner HTML remains valid after deletion.)
2. Uninstall the SDKs:
   ```bash
   npm uninstall @alicloud/captcha20230305 @alicloud/openapi-core
   ```
3. Remove the captcha section from `.env.example` if you fork the repo

`CONTACT_PROXY_TOKEN` is **not** part of the ESA module — it is a generic reverse-proxy shared secret and stays useful without Aliyun.

### Frontend note

When captcha is enabled, the browser should send the ESA verify param as:

- JSON field `captcha_verify_param`, or
- header `captcha-verify-param`

---

## Deployment notes

1. Bind the process to `127.0.0.1` only (already the default in `index.js`)
2. Reverse-proxy `/api/contact` → `http://127.0.0.1:8787`
3. Optionally set `CONTACT_PROXY_TOKEN` and have nginx inject:
   ```nginx
   proxy_set_header X-Contact-Proxy-Token "your-long-random-secret";
   ```
4. Deny public access to the Node port in your firewall
5. Set `ALLOWED_ORIGIN` to your real site origin(s)

Process managers such as `pm2`, `systemd`, or Docker all work; this repo stays process-manager agnostic on purpose.

---

## API

### `GET /api/health`

```json
{ "ok": true }
```

### `POST /api/contact`

Request body:

```json
{
  "email": "visitor@example.com",
  "message": "Hello",
  "website": ""
}
```

`website` is a honeypot — leave it empty in real forms. Bots that fill it get a quiet `{ "ok": true }` with no mail sent.

Success: `{ "ok": true }`  
Errors: `{ "ok": false, "error": "…" }` with `400` / `403` / `429` / `500` / `503`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and small PRs are welcome.

---

## License

[MIT](LICENSE) © Speakingplease

const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit')
const helmet = require('helmet')
const nodemailer = require('nodemailer')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

// ===== BEGIN Aliyun ESA AI Captcha (optional) =====
// Only needed if you front this service with Alibaba Cloud ESA AI Captcha.
// ESA verifies and consumes the V3 token at the edge — no server-side SDK is
// required (https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/ai-captchas-overview/).
// Soft-disable: leave CAPTCHA_SCENE_ID blank in .env -> captchaConfigured=false.
// ===== END Aliyun ESA AI Captcha =====

const PORT = Number(process.env.PORT) || 8787
const SMTP_USER = process.env.SMTP_USER
const SMTP_PASS = process.env.SMTP_PASS
const SMTP_HOST = (process.env.SMTP_HOST || 'smtp.qq.com').trim()
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false'
const CONTACT_TO = process.env.CONTACT_TO || SMTP_USER
const CONTACT_PROXY_TOKEN = (process.env.CONTACT_PROXY_TOKEN || '').trim()
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

function envValue(name) {
  return String(process.env[name] || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

/** Strip CR/LF/controls so env values cannot inject SMTP headers. */
function sanitizeHeaderValue(value, fallback = '') {
  const cleaned = String(value || '')
    .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

function deriveSiteName() {
  const explicit = envValue('SITE_NAME')
  if (explicit) return explicit
  const firstOrigin = ALLOWED_ORIGINS[0] || ''
  try {
    if (firstOrigin.startsWith('http://') || firstOrigin.startsWith('https://')) {
      return new URL(firstOrigin).hostname
    }
  } catch {
    // fall through
  }
  return firstOrigin || 'your-site'
}

const FROM_DISPLAY_NAME = sanitizeHeaderValue(
  process.env.FROM_DISPLAY_NAME || 'Website Contact',
  'Website Contact',
)
const SITE_NAME = sanitizeHeaderValue(deriveSiteName(), 'your-site')

// ===== BEGIN Aliyun ESA AI Captcha (optional) =====
const CAPTCHA_SCENE_ID = envValue('CAPTCHA_SCENE_ID')

const captchaConfigured = Boolean(CAPTCHA_SCENE_ID)
// ===== END Aliyun ESA AI Captcha =====

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 254
const MAX_MESSAGE_LENGTH = 5000

if (!SMTP_USER || !SMTP_PASS) {
  console.error(
    'Missing SMTP_USER or SMTP_PASS. Copy .env.example to .env and fill in your SMTP credentials.',
  )
  process.exit(1)
}

// ===== BEGIN Aliyun ESA AI Captcha (optional) =====
console.log(
  `Contact captcha: configured=${captchaConfigured} sceneLen=${CAPTCHA_SCENE_ID.length}`,
)
// ===== END Aliyun ESA AI Captcha =====
console.log(`SMTP: ${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE} from=${FROM_DISPLAY_NAME} site=${SITE_NAME}`)

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  // Fail fast instead of holding a request for the 10-minute socket timeout.
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
})

// Surface SMTP misconfiguration at boot, not on the first visitor.
transporter.verify().catch((error) => {
  console.error(
    'SMTP verification failed — mail will not send:',
    error instanceof Error ? error.message : error,
  )
})

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ===== BEGIN Aliyun ESA AI Captcha (optional) =====
function readCaptchaVerifyParam(req) {
  if (typeof req.body?.captcha_verify_param === 'string' && req.body.captcha_verify_param.trim()) {
    return req.body.captcha_verify_param.trim()
  }
  const headerParam = (req.get('captcha-verify-param') || '').trim()
  if (headerParam) return headerParam
  if (typeof req.query?.captcha_verify_param === 'string' && req.query.captcha_verify_param.trim()) {
    return req.query.captcha_verify_param.trim()
  }
  return ''
}

/** Owner-mail diagnostics only — never include the raw token. */
function describeCaptchaMeta(req) {
  const bodyParam =
    typeof req.body?.captcha_verify_param === 'string'
      ? req.body.captcha_verify_param.trim()
      : ''
  const headerParam = (req.get('captcha-verify-param') || '').trim()
  const queryParam =
    typeof req.query?.captcha_verify_param === 'string'
      ? req.query.captcha_verify_param.trim()
      : ''

  let source = '—'
  let param = ''
  if (bodyParam) {
    source = 'JSON body'
    param = bodyParam
  } else if (headerParam) {
    source = 'Request header'
    param = headerParam
  } else if (queryParam) {
    source = 'URL query'
    param = queryParam
  }

  const present = Boolean(param)
  let trust = 'Not required (dev)'
  if (captchaConfigured) {
    trust = present
      ? 'ESA edge (token consumed; origin presence-check only)'
      : 'Missing'
  }

  return {
    captcha: present ? 'Present' : 'Absent',
    captchaSource: source,
    captchaParamLen: present ? String(param.length) : '0',
    captchaTrust: trust,
  }
}

/**
 * ESA AI Captcha consumes the V3 token at the edge and echoes
 * X-Captcha-Verify-Code: T001 on the origin response. Origin requires the
 * param when a scene is configured, and treats a non-T001 echo as a failure.
 */
function verifyAliyunCaptcha(req) {
  if (!captchaConfigured) {
    return { ok: true, skipped: true }
  }
  const captchaVerifyParam = readCaptchaVerifyParam(req)
  if (!captchaVerifyParam) {
    return { ok: false, verifyCode: 'F002' }
  }
  const verifyCode = (req.get('x-captcha-verify-code') || '').trim()
  if (verifyCode && verifyCode !== 'T001') {
    return { ok: false, verifyCode }
  }
  return { ok: true, verifyCode: verifyCode || 'ESA', skippedOpenApi: true }
}
// ===== END Aliyun ESA AI Captcha =====

function buildAutoReplyText(message) {
  return [
    'Thanks for writing.',
    '',
    'Your message reached me safely. I read everything that comes through and I will reply personally as soon as I can.',
    '',
    'Your message:',
    message,
    '',
    `— ${FROM_DISPLAY_NAME}`,
    '',
    `${SITE_NAME} · ${new Date().getFullYear()}`,
  ].join('\n')
}

function buildAutoReplyHtml(safeMessage) {
  const year = new Date().getFullYear()
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f5f0e8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f0e8;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#faf7f2;border:1px solid #e0d8cc;border-radius:12px;">
          <tr>
            <td style="padding:36px 40px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;color:#c4624a;text-transform:uppercase;">${escapeHtml(FROM_DISPLAY_NAME)}</div>
              <h1 style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:normal;color:#1a1714;font-size:26px;line-height:1.25;margin:10px 0 16px;">Thanks for writing.</h1>
              <p style="font-family:Arial,Helvetica,sans-serif;color:#5c5248;line-height:1.7;font-size:15px;margin:0 0 20px;">
                Your message reached me safely. I read everything that comes through and I&rsquo;ll reply personally as soon as I can.
              </p>
              <div style="border-left:3px solid #c4624a;background:#f0ebe2;padding:12px 16px;color:#6e6358;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;">
                ${safeMessage}
              </div>
              <p style="font-family:Georgia,'Times New Roman',serif;font-style:italic;color:#1a1714;margin:24px 0 0;">&mdash; ${escapeHtml(FROM_DISPLAY_NAME)}</p>
            </td>
          </tr>
        </table>
        <div style="color:#b8afa8;font-size:11px;font-family:Arial,Helvetica,sans-serif;margin-top:16px;">${escapeHtml(SITE_NAME)} &middot; ${year}</div>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim()
}

function clip(value, max = 500) {
  const text = String(value || '').trim()
  if (!text) return '—'
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function collectRequestMeta(req) {
  // ===== BEGIN Aliyun ESA AI Captcha (optional) =====
  const captchaMeta = describeCaptchaMeta(req)
  // ===== END Aliyun ESA AI Captcha =====

  return {
    ip: clip(req.ip || req.socket?.remoteAddress || '', 128),
    forwardedFor: clip(req.get('x-forwarded-for') || '', 300),
    userAgent: clip(req.get('user-agent') || '', 500),
    origin: clip(req.get('origin') || '', 300),
    referer: clip(req.get('referer') || '', 300),
    language: clip(req.get('accept-language') || '', 200),
    time: new Date().toISOString(),
    // ===== BEGIN Aliyun ESA AI Captcha (optional) =====
    captcha: captchaMeta.captcha,
    captchaSource: captchaMeta.captchaSource,
    captchaParamLen: captchaMeta.captchaParamLen,
    captchaTrust: captchaMeta.captchaTrust,
    // ===== END Aliyun ESA AI Captcha =====
  }
}

function buildOwnerNotifyText(email, message, meta) {
  return [
    'Someone wrote in.',
    '',
    `From: ${email}`,
    '',
    'Message:',
    message,
    '',
    'Details:',
    `IP: ${meta.ip}`,
    `X-Forwarded-For: ${meta.forwardedFor}`,
    `User-Agent: ${meta.userAgent}`,
    `Origin: ${meta.origin}`,
    `Referer: ${meta.referer}`,
    `Language: ${meta.language}`,
    `Time: ${meta.time}`,
    // ===== BEGIN Aliyun ESA AI Captcha (optional) =====
    `Captcha: ${meta.captcha}`,
    `Captcha source: ${meta.captchaSource}`,
    `Captcha length: ${meta.captchaParamLen}`,
    `Captcha trust: ${meta.captchaTrust}`,
    // ===== END Aliyun ESA AI Captcha =====
    '',
    `${SITE_NAME} · ${new Date().getFullYear()}`,
  ].join('\n')
}

function metaRow(label, value) {
  return `
    <tr>
      <td style="padding:8px 12px 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#b8aca0;vertical-align:top;white-space:nowrap;width:120px;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5c5248;line-height:1.5;word-break:break-word;">${escapeHtml(value)}</td>
    </tr>
  `
}

function buildOwnerNotifyHtml(safeEmail, safeMessage, meta) {
  const year = new Date().getFullYear()
  // Default empty so hard-removing the ESA block below stays safe.
  let captchaRows = ''
  // ===== BEGIN Aliyun ESA AI Captcha (optional) =====
  captchaRows = [
    metaRow('Captcha', meta.captcha),
    metaRow('Captcha source', meta.captchaSource),
    metaRow('Captcha length', meta.captchaParamLen),
    metaRow('Captcha trust', meta.captchaTrust),
  ].join('')
  // ===== END Aliyun ESA AI Captcha =====
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f5f0e8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f0e8;padding:32px 0;">
    <tr>
      <td align="center" style="padding:0 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#faf7f2;border:1px solid #e0d8cc;border-radius:12px;">
          <tr>
            <td style="padding:36px 40px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;color:#c4624a;text-transform:uppercase;">New message</div>
              <h1 style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:normal;color:#1a1714;font-size:26px;line-height:1.25;margin:10px 0 16px;">Someone wrote in.</h1>
              <p style="font-family:Arial,Helvetica,sans-serif;color:#5c5248;line-height:1.7;font-size:15px;margin:0 0 8px;">
                <strong style="color:#1a1714;">From:</strong> ${safeEmail}
              </p>
              <div style="border-left:3px solid #c4624a;background:#f0ebe2;padding:12px 16px;color:#6e6358;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;margin:0 0 28px;">
                ${safeMessage}
              </div>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#b8aca0;margin:0 0 10px;">Details</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e0d8cc;">
                ${metaRow('IP', meta.ip)}
                ${metaRow('X-Forwarded-For', meta.forwardedFor)}
                ${metaRow('User-Agent', meta.userAgent)}
                ${metaRow('Origin', meta.origin)}
                ${metaRow('Referer', meta.referer)}
                ${metaRow('Language', meta.language)}
                ${metaRow('Time', meta.time)}
                ${captchaRows}
              </table>
            </td>
          </tr>
        </table>
        <div style="color:#b8afa8;font-size:11px;font-family:Arial,Helvetica,sans-serif;margin-top:16px;">${escapeHtml(SITE_NAME)} &middot; ${year}</div>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim()
}

const app = express()

app.disable('x-powered-by')
app.use(helmet())
app.set('trust proxy', 1)
app.use(express.json({ limit: '256kb' }))
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true)
        return
      }
      callback(new Error('Not allowed by CORS'))
    },
  }),
)

// Minimal request log with a request id for correlating errors in PM2 logs.
app.use((req, res, next) => {
  const requestId = crypto.randomBytes(4).toString('hex')
  res.setHeader('X-Request-Id', requestId)
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms id=${requestId} ip=${req.ip || '-'}`,
    )
  })
  next()
})

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many messages. Please try again later.' },
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// POST /api/contact — production typically sits behind a reverse proxy.
// With Aliyun ESA AI Captcha enabled, the edge consumes the V3 captcha token;
// origin only checks that the verify param is present.
app.post('/api/contact', contactLimiter, async (req, res) => {
  try {
    if (CONTACT_PROXY_TOKEN) {
      const provided = req.get('x-contact-proxy-token') || ''
      if (provided !== CONTACT_PROXY_TOKEN) {
        res.status(403).json({ ok: false, error: 'Forbidden.' })
        return
      }
    }

    // ===== BEGIN Aliyun ESA AI Captcha (optional) =====
    const captcha = verifyAliyunCaptcha(req)
    if (!captcha.ok) {
      console.warn(
        `Captcha rejected: verifyCode=${captcha.verifyCode} paramLen=${readCaptchaVerifyParam(req).length}`,
      )
      res.status(403).json({ ok: false, error: 'Verification did not pass. Please try again.' })
      return
    }
    // ===== END Aliyun ESA AI Captcha =====

    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    const website = typeof req.body?.website === 'string' ? req.body.website.trim() : ''

    // Honeypot: bots that fill the hidden field get a quiet success.
    if (website) {
      res.json({ ok: true })
      return
    }

    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      res.status(400).json({ ok: false, error: 'Please enter a valid email address.' })
      return
    }

    if (!message || message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({
        ok: false,
        error: 'Please write a message (up to 5000 characters).',
      })
      return
    }

    const safeEmail = escapeHtml(email)
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>')
    const meta = collectRequestMeta(req)

    const fromAddress = { name: FROM_DISPLAY_NAME, address: SMTP_USER }
    const safeSubjectEmail = sanitizeHeaderValue(email, 'unknown')

    await transporter.sendMail({
      from: fromAddress,
      to: CONTACT_TO,
      replyTo: email,
      subject: `New message from ${safeSubjectEmail}`,
      text: buildOwnerNotifyText(email, message, meta),
      html: buildOwnerNotifyHtml(safeEmail, safeMessage, meta),
    })

    try {
      await transporter.sendMail({
        from: fromAddress,
        to: email,
        subject: `Thanks for reaching out — ${FROM_DISPLAY_NAME}`,
        text: buildAutoReplyText(message),
        html: buildAutoReplyHtml(safeMessage),
      })
    } catch (autoReplyError) {
      console.warn(
        'Auto-reply mail failed:',
        autoReplyError instanceof Error ? autoReplyError.message : autoReplyError,
      )
    }

    res.json({ ok: true })
  } catch (error) {
    console.error('Contact mail failed:', error instanceof Error ? error.message : error)
    res.status(500).json({ ok: false, error: 'Could not send your message. Please try again later.' })
  }
})

app.use((err, _req, res, next) => {
  if (err?.message === 'Not allowed by CORS') {
    res.status(403).json({ ok: false, error: 'Forbidden.' })
    return
  }
  // Everything else answers JSON too — never the Express HTML error page.
  const status = err?.type === 'entity.parse.failed' ? 400 : 500
  console.error(`Unhandled error (${status}):`, err instanceof Error ? err.stack : err)
  res.status(status).json({
    ok: false,
    error:
      status === 400
        ? 'Invalid JSON body.'
        : 'Something went wrong. Please try again later.',
  })
})

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Contact server listening on http://127.0.0.1:${PORT}`)
})

// Graceful shutdown: drain in-flight requests, close the SMTP pool, then exit.
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received — draining connections…`)
  const force = setTimeout(() => {
    console.error('Shutdown timed out; forcing exit.')
    process.exit(1)
  }, 5000)
  force.unref()
  server.close(() => {
    transporter.close()
    process.exit(0)
  })
  server.closeIdleConnections?.()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

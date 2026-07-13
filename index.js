const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const nodemailer = require('nodemailer')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })

// ===== BEGIN Aliyun ESA AI Captcha (optional) =====
// Only needed if you front this service with Alibaba Cloud ESA AI Captcha.
// Soft-disable: leave CAPTCHA_SCENE_ID / ALIYUN_ACCESS_KEY_ID blank in .env
//   -> captchaConfigured=false, all of this becomes a no-op automatically.
// Hard-remove: delete every block marked BEGIN/END Aliyun ESA AI Captcha
//   (captchaRows defaults to '' so owner HTML stays valid), then run:
//   npm uninstall @alicloud/captcha20230305 @alicloud/openapi-core
const Captcha20230305 = require('@alicloud/captcha20230305')
const OpenApi = require('@alicloud/openapi-core')
const CaptchaClient = Captcha20230305.default
const { Config } = OpenApi.$OpenApiUtil
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
const CAPTCHA_REGION = (envValue('CAPTCHA_REGION') || 'cn').toLowerCase()
const ALIYUN_ACCESS_KEY_ID = envValue('ALIYUN_ACCESS_KEY_ID')
const ALIYUN_ACCESS_KEY_SECRET = envValue('ALIYUN_ACCESS_KEY_SECRET')

const captchaConfigured = Boolean(
  CAPTCHA_SCENE_ID && ALIYUN_ACCESS_KEY_ID && ALIYUN_ACCESS_KEY_SECRET,
)

let captchaClient = null
let captchaEndpoint = ''
if (captchaConfigured) {
  const regionId = CAPTCHA_REGION === 'sgp' ? 'ap-southeast-1' : 'cn-shanghai'
  captchaEndpoint =
    CAPTCHA_REGION === 'sgp'
      ? 'captcha.ap-southeast-1.aliyuncs.com'
      : 'captcha.cn-shanghai.aliyuncs.com'
  captchaClient = new CaptchaClient(
    new Config({
      accessKeyId: ALIYUN_ACCESS_KEY_ID,
      accessKeySecret: ALIYUN_ACCESS_KEY_SECRET,
      endpoint: captchaEndpoint,
      regionId,
    }),
  )
}
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
  `Contact captcha: configured=${captchaConfigured} sceneLen=${CAPTCHA_SCENE_ID.length} endpoint=${captchaEndpoint || 'n/a'}`,
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

async function verifyAliyunCaptcha(captchaVerifyParam) {
  if (!captchaConfigured) {
    return { ok: true, skipped: true }
  }
  // ESA AI Captcha verifies and consumes the V3 token at the edge (response
  // header X-Captcha-Verify-Code: T001). Calling VerifyIntelligentCaptcha
  // again with the same CaptchaVerifyParam returns F018 (reuse). Origin only
  // requires the param be present; ESA + CONTACT_PROXY_TOKEN are the gates.
  if (!captchaVerifyParam) {
    return { ok: false, verifyCode: 'F002' }
  }
  return { ok: true, verifyCode: 'ESA', skippedOpenApi: true }
}

function captchaErrorMeta(err) {
  const message = err instanceof Error ? err.message : String(err)
  const code = err?.code || err?.data?.Code || err?.name || ''
  const statusCode = Number(err?.statusCode || err?.data?.statusCode || 0) || undefined
  return { message, code, statusCode }
}

/** Map SDK throw → client status. Auth/network stay 503; param/verify failures → 403. */
function captchaThrowHttpStatus(meta) {
  const blob = `${meta.code} ${meta.message}`.toLowerCase()
  if (
    blob.includes('forbidden') ||
    blob.includes('unauthorized') ||
    blob.includes('invalidaccesskey') ||
    blob.includes('signature') ||
    blob.includes('throttl') ||
    blob.includes('timeout') ||
    blob.includes('econn') ||
    blob.includes('enotfound') ||
    blob.includes('network') ||
    blob.includes('internalerror') ||
    (meta.statusCode && meta.statusCode >= 500)
  ) {
    return 503
  }
  if (
    blob.includes('missingparameter') ||
    blob.includes('invalidparameter') ||
    blob.includes('captcha') ||
    blob.includes('scene') ||
    (meta.statusCode && meta.statusCode >= 400 && meta.statusCode < 500)
  ) {
    return 403
  }
  return 503
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
    const captchaVerifyParam = readCaptchaVerifyParam(req)
    if (captchaConfigured) {
      try {
        const captcha = await verifyAliyunCaptcha(captchaVerifyParam)
        if (!captcha.ok) {
          console.warn(
            `Captcha rejected: verifyCode=${captcha.verifyCode} paramLen=${captchaVerifyParam.length}`,
          )
          res.status(403).json({ ok: false, error: 'Verification did not pass. Please try again.' })
          return
        }
      } catch (captchaError) {
        const meta = captchaErrorMeta(captchaError)
        const status = captchaThrowHttpStatus(meta)
        console.error(
          `Captcha verify failed: status=${status} code=${meta.code || 'n/a'} http=${meta.statusCode || 'n/a'} paramLen=${captchaVerifyParam.length} msg=${meta.message}`,
        )
        if (status === 403) {
          res.status(403).json({ ok: false, error: 'Verification did not pass. Please try again.' })
          return
        }
        res.status(503).json({ ok: false, error: 'Verification unavailable. Please try again later.' })
        return
      }
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
  next(err)
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Contact server listening on http://127.0.0.1:${PORT}`)
})

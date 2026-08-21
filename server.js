require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { google } = require('googleapis');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const multer = require('multer');

const app = express();

// Escapes free-typed user text before it's inserted into HTML templates
// (e.g. dog notes), so a note containing < > & etc. can't break the page
// or inject anything.
function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Human-readable labels for the coded baseline-survey values (dashboard
// display only — the underlying stored values stay exactly as the signup
// form's allowed lists define them).
const DIET_TYPE_LABELS = {
  dry: 'Dry Food', wet: 'Wet Food', raw: 'Raw Diet',
  prescription: 'Prescription Diet', mixed: 'Mixed Diet', other: 'Other Diet'
};
const TREATMENT_CATEGORY_LABELS = {
  joint_supplement: 'Joint Supplement', nsaid: 'NSAID', steroid: 'Steroid',
  pain_medication: 'Pain Medication', other_prescription: 'Other Prescription',
  other_supplement: 'Other Supplement'
  // 'none' deliberately omitted — handled separately, not shown as a "medication"
};

// ============================================
// VALIDATE REQUIRED ENVIRONMENT VARIABLES
// ============================================
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ FATAL: Missing required environment variables:', missingVars);
  console.error('Create .env file in project root with all required variables');
  process.exit(1);
}

console.log('✅ All required environment variables loaded');

const PORT = process.env.PORT || 3000;

// The public web address used inside links sent to users (SMS, email).
// Locally this defaults to your home network IP so testing on your own
// devices still works. On Railway, set BASE_URL=https://companioncommons.com
// as an environment variable and every link will use the real domain
// instead — no code changes needed when you deploy.
const BASE_URL = process.env.BASE_URL || `http://192.168.1.19:${PORT}`;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================
// SITE LOCK ("Coming Soon" gate)
// ============================================
// Set SITE_PASSWORD in your .env (locally) or in your hosting provider's
// environment variables (e.g. Railway) to hide the ENTIRE site — every
// page and every form — behind a simple password wall showing a
// "Coming Soon" splash instead. Leave SITE_PASSWORD unset/blank and the
// site behaves 100% normally with no gate at all. To go public for real,
// just remove the SITE_PASSWORD variable — no code changes needed.
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const SITE_UNLOCK_COOKIE = 'cc_site_access';

function siteUnlockHash(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

const COMING_SOON_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Companion Commons — Coming Soon</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#2E2A26; color:#fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .box { max-width: 420px; padding: 40px; text-align: center; }
  h1 { font-size: 28px; margin-bottom: 12px; }
  p { opacity: .8; line-height: 1.5; margin-bottom: 28px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 8px; border: none;
         font-size: 16px; margin-bottom: 14px; }
  button { width: 100%; padding: 12px 14px; border-radius: 8px; border: none; background:#d96f56; color:#fff;
         font-size: 16px; font-weight: 600; cursor: pointer; }
  .error { color: #ff9b9b; font-size: 14px; margin-top: 12px; min-height: 18px; }
</style>
</head>
<body>
  <div class="box">
    <h1>Companion Commons</h1>
    <p>We're still building. If you've got the password, come on in.</p>
    <form id="unlockForm">
      <input type="password" id="pw" placeholder="Password" autofocus required />
      <button type="submit">Enter</button>
      <div class="error" id="err"></div>
    </form>
  </div>
  <script>
    document.getElementById('unlockForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const pw = document.getElementById('pw').value;
      const errEl = document.getElementById('err');
      errEl.textContent = '';
      try {
        const res = await fetch('/api/site-unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw })
        });
        if (res.ok) {
          window.location.reload();
        } else {
          errEl.textContent = 'Wrong password, try again.';
        }
      } catch (err) {
        errEl.textContent = 'Something went wrong, try again.';
      }
    });
  </script>
</body>
</html>`;

app.post('/api/site-unlock', (req, res) => {
  if (!SITE_PASSWORD) return res.json({ success: true }); // lock disabled
  const { password } = req.body || {};
  if (password && password === SITE_PASSWORD) {
    res.cookie(SITE_UNLOCK_COOKIE, siteUnlockHash(SITE_PASSWORD), {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax'
    });
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false });
});

app.use((req, res, next) => {
  if (!SITE_PASSWORD) return next(); // no password set = gate fully disabled

  // Always allow through: the unlock endpoint itself, hosting-provider
  // health checks, Twilio's own status-callback webhook (Twilio's servers
  // obviously can't type in a password), and the legal pages + their
  // styling/script assets — Twilio's A2P 10DLC campaign review requires
  // Privacy Policy / Terms URLs to be live and publicly reachable with NO
  // password, even while the rest of the site stays locked down.
  const alwaysAllowed =
    req.path === '/api/site-unlock' ||
    req.path === '/health' ||
    req.path.startsWith('/api/sms/') ||
    req.path === '/privacy.html' ||
    req.path === '/terms.html' ||
    req.path.startsWith('/assets/');

  if (alwaysAllowed) return next();

  const cookies = parseCookies(req);
  if (cookies[SITE_UNLOCK_COOKIE] === siteUnlockHash(SITE_PASSWORD)) {
    return next(); // already unlocked on this browser
  }

  if (req.method === 'GET') {
    return res.status(200).send(COMING_SOON_HTML);
  }
  return res.status(401).json({ error: 'Site is locked' });
});

app.use(express.static('Public'));

// ============================================
// ADMIN PANEL AUTH
// ============================================
// Same server-side password + hashed-cookie pattern as the SITE_PASSWORD
// gate above, but a separate, independent lock scoped to just /admin and
// the /api/page/* content API it uses. Set ADMIN_PASSWORD in your .env
// (locally) or your hosting provider's environment variables (e.g.
// Railway) — never hardcode it in this file.
//
// Unlike SITE_PASSWORD, leaving ADMIN_PASSWORD unset does NOT open the
// gate — it locks the admin panel out entirely (returns 503). Admin is a
// sensitive internal tool, not something that should ever be reachable by
// default the way the public "Coming Soon" splash is designed to be.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_UNLOCK_COOKIE = 'cc_admin_access';

function isAdminUnlocked(req) {
  if (!ADMIN_PASSWORD) return false;
  const cookies = parseCookies(req);
  return cookies[ADMIN_UNLOCK_COOKIE] === siteUnlockHash(ADMIN_PASSWORD);
}

app.post('/api/admin-unlock', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ success: false, error: 'Admin panel is not configured' });
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
    res.cookie(ADMIN_UNLOCK_COOKIE, siteUnlockHash(ADMIN_PASSWORD), {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax'
    });
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false });
});

app.post('/api/admin-logout', (req, res) => {
  res.clearCookie(ADMIN_UNLOCK_COOKIE);
  res.json({ success: true });
});

// Guards the page-content API the admin panel reads/writes through — this
// is the endpoint that actually mutates site content, so it needs the same
// server-side check as the /admin page itself (previously this had NO
// authentication at all, regardless of what /admin showed in the browser).
app.use('/api/page', (req, res, next) => {
  if (!isAdminUnlocked(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ============================================
// SUPABASE SETUP
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================
// SUPABASE ADMIN CLIENT (for bucket creation)
// ============================================
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (SUPABASE_SERVICE_ROLE_KEY) {
  console.log('✅ Service role key loaded');
} else {
  console.warn('⚠️ SUPABASE_SERVICE_ROLE_KEY not in .env');
}

const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

// Ensure bucket exists on startup
(async () => {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.storage.createBucket('Dog_Photos', { public: true });
    console.log('✅ Dog_Photos bucket ready');
  } catch (e) {
    if (e.message?.includes('already exists')) {
      console.log('✅ Dog_Photos bucket exists');
    } else {
      console.error('⚠️ Bucket error:', e.message);
    }
  }
})();

// ============================================
// TWILIO SETUP
// ============================================
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ============================================
// SENDGRID SETUP (Email)
// ============================================
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'companioncommons@gmail.com';
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log('✅ SendGrid initialized');
} else {
  console.warn('⚠️ SENDGRID_API_KEY not set. Email features disabled.');
}

// ============================================
// GOOGLE SHEETS SETUP
// ============================================
// GOOGLE SHEETS INTEGRATION
// Rebuilt Aug 19 — the old version looked for a credentials FILE on disk,
// which never worked once deployed (service account keys correctly never
// get committed to GitHub, so the file was never actually present on
// Railway — this is why every startup log showed "key file not found").
// Now reads credentials from the GOOGLE_SHEETS_CREDENTIALS environment
// variable instead, set directly in Railway.
// ============================================
const SHEET_ID = '1Qxm9pbI9PuE-dxCKJ5UrrspJGYcZXfb-fLwB69UyBsY';
let sheetsClient = null;

function loadGoogleSheetsAuth() {
  try {
    const credsBase64 = process.env.GOOGLE_SHEETS_CREDENTIALS_BASE64;

    if (!credsBase64) {
      console.warn('⚠️ GOOGLE_SHEETS_CREDENTIALS_BASE64 env var not set. Skipping Google Sheets integration.');
      return null;
    }

    // Base64-decode first — this sidesteps a common .env gotcha where literal
    // \n escape sequences inside a raw JSON value can get misinterpreted as
    // real line breaks by some .env parsers, breaking JSON.parse.
    const credsJson = Buffer.from(credsBase64, 'base64').toString('utf8');
    const keyData = JSON.parse(credsJson);

    const auth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log(`✅ Google Sheets authenticated (${keyData.client_email})`);
    return true;
  } catch (error) {
    console.warn('⚠️ Failed to load Google Sheets:', error.message);
    return null;
  }
}

// Initialize Google Sheets on startup
loadGoogleSheetsAuth();

// ============================================
// INPUT SANITIZATION FUNCTIONS (SECURITY)
// ============================================

// Sanitize strings: trim whitespace, remove null bytes, basic XSS prevention
const sanitizeString = (str, maxLength = 500) => {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .replace(/\0/g, '') // Remove null bytes
    .substring(0, maxLength);
};

// Sanitize email: trim, lowercase, remove dangerous characters
const sanitizeEmail = (email) => {
  if (typeof email !== 'string') return '';
  return email
    .trim()
    .toLowerCase()
    .replace(/[<>\"']/g, ''); // Remove quote/bracket characters
};

// Sanitize name fields: allow letters, spaces, hyphens, apostrophes only
const sanitizeName = (name, maxLength = 100) => {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/[^a-zA-Z\s\-\']/g, '') // Remove special characters except -, '
    .substring(0, maxLength);
};

// Sanitize phone: remove all non-digits, validate length
const sanitizePhone = (phone) => {
  if (typeof phone !== 'string') return '';
  const cleaned = phone.replace(/\D/g, ''); // Remove all non-digits
  // Return in E.164 format or empty if invalid
  if (cleaned.length < 10) return '';
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length > 15) return '';
  return `+${cleaned}`;
};

// Sanitize select fields (gender, trend, etc): lowercase, limit to allowed values
const sanitizeSelect = (value, allowedValues) => {
  if (typeof value !== 'string') return allowedValues[0] || '';
  const normalized = value.toLowerCase().trim();
  return allowedValues.includes(normalized) ? normalized : allowedValues[0] || '';
};

// Sanitize array of strings (treatments, observations)
const sanitizeArray = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(item => typeof item === 'string' ? sanitizeString(item, 100) : '')
    .filter(item => item.length > 0);
};

// ============================================
// RATE LIMITING (SECURITY - PREVENTS ABUSE)
// ============================================

// In-memory stores for rate limiting (production should use Redis)
const requestCounts = new Map(); // Track requests per IP
const smsCounts = new Map(); // Track SMS sends per user per day

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);

  for (const [key, data] of requestCounts.entries()) {
    if (data.timestamp < oneHourAgo) {
      requestCounts.delete(key);
    }
  }

  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  for (const [key, data] of smsCounts.entries()) {
    if (data.timestamp < oneDayAgo) {
      smsCounts.delete(key);
    }
  }
}, 60 * 60 * 1000);

// Middleware: Rate limit API requests (max 10 requests per 10 seconds per IP)
const apiRateLimit = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowSize = 10 * 1000; // 10 second window
  const maxRequests = 10;

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, timestamp: now });
    return next();
  }

  const data = requestCounts.get(ip);

  // Reset if window expired
  if (now - data.timestamp > windowSize) {
    requestCounts.set(ip, { count: 1, timestamp: now });
    return next();
  }

  // Increment count
  data.count += 1;

  // Check limit
  if (data.count > maxRequests) {
    return res.status(429).json({
      error: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil((windowSize - (now - data.timestamp)) / 1000)
    });
  }

  next();
};

// Middleware: Rate limit SMS (max 10 SMS per user per day)
const smsRateLimit = (userId) => {
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  if (!smsCounts.has(userId)) {
    smsCounts.set(userId, { count: 1, timestamp: now });
    return { allowed: true };
  }

  const data = smsCounts.get(userId);

  // Reset if day expired
  if (now - data.timestamp > 24 * 60 * 60 * 1000) {
    smsCounts.set(userId, { count: 1, timestamp: now });
    return { allowed: true };
  }

  // Check limit (max 10 per day)
  if (data.count >= 10) {
    return {
      allowed: false,
      message: 'SMS limit reached. Max 10 per day.',
      retryAfter: Math.ceil((24 * 60 * 60 * 1000 - (now - data.timestamp)) / 1000)
    };
  }

  // Increment count
  data.count += 1;
  return { allowed: true };
};

// Apply API rate limiting to all POST endpoints
app.post('*', apiRateLimit);

// ============================================
// ADMIN PANEL - EMBEDDED (UNCHANGED)
// ============================================
app.get('/admin', (req, res) => {
    if (!isAdminUnlocked(req)) {
        return res.send(`<!DOCTYPE html>
<html>
<head>
    <title>CompanionCommons Admin — Login</title>
    <style>
        body { font-family: Arial; background: #f0f0f0; padding: 20px; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
        .container { max-width: 340px; width: 100%; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; margin: 0 0 20px 0; font-size: 20px; }
        input { width: 100%; padding: 10px; margin-bottom: 14px; border: 1px solid #ddd; font-family: Arial; font-size: 14px; box-sizing: border-box; }
        button { width: 100%; background: #4CAF50; color: white; padding: 12px 24px; border: none; cursor: pointer; font-size: 16px; font-weight: bold; border-radius: 4px; }
        button:hover { background: #45a049; }
        .error { color: #c33; font-size: 14px; margin-top: 10px; min-height: 18px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>CompanionCommons Admin</h1>
        <form id="loginForm">
            <input type="password" id="password" placeholder="Admin password" autofocus required>
            <button type="submit">Login</button>
            <div class="error" id="err"></div>
        </form>
    </div>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('password').value;
            const errEl = document.getElementById('err');
            errEl.textContent = '';
            try {
                const res = await fetch('/api/admin-unlock', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                if (res.ok) {
                    window.location.reload();
                } else {
                    errEl.textContent = 'Incorrect password.';
                }
            } catch (error) {
                errEl.textContent = 'Something went wrong, try again.';
            }
        });
    </script>
</body>
</html>`);
    }

    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>CompanionCommons Admin</title>
    <style>
        body { font-family: Arial; background: #f0f0f0; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; margin-bottom: 30px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; font-weight: bold; margin-bottom: 8px; color: #333; }
        input, textarea, select { width: 100%; padding: 10px; margin-bottom: 10px; border: 1px solid #ddd; font-family: Arial; font-size: 14px; }
        textarea { min-height: 100px; }
        button { background: #4CAF50; color: white; padding: 12px 24px; border: none; cursor: pointer; font-size: 16px; font-weight: bold; border-radius: 4px; }
        button:hover { background: #45a049; }
        .message { padding: 15px; margin-bottom: 20px; border-radius: 4px; display: none; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    </style>
</head>
<body>
    <div class="container">
        <h1><i data-lucide="target"></i> CompanionCommons Admin</h1>
        <button onclick="logout()" style="float:right;">Logout</button>
        <div style="clear:both;"></div>

        <div id="message" class="message"></div>

        <div class="form-group">
            <label>Select Page:</label>
            <select id="page" onchange="loadPage()">
                <option value="home">Home</option>
                <option value="about">About</option>
                <option value="independent">Independent</option>
                <option value="privacy">Privacy</option>
                <option value="faq">FAQ</option>
                <option value="founding">Founding</option>
            </select>
        </div>

        <div class="form-group">
            <label>Headline:</label>
            <input type="text" id="headline" placeholder="Page headline">
        </div>

        <div class="form-group">
            <label>Subheading:</label>
            <input type="text" id="subheading" placeholder="Page subheading">
        </div>

        <div class="form-group">
            <label>CTA Button Text:</label>
            <input type="text" id="cta" placeholder="Button text">
        </div>

        <div class="form-group">
            <label>Body Content:</label>
            <textarea id="body" placeholder="Main content"></textarea>
        </div>

        <div class="form-group">
            <label>Secondary Text:</label>
            <textarea id="secondary" placeholder="Additional content"></textarea>
        </div>

        <button onclick="savePage()"><i data-lucide="save"></i> Save Changes</button>
    </div>

    <script>
        function logout() {
            fetch('/api/admin-logout', { method: 'POST' }).then(() => window.location.reload());
        }

        async function loadPage() {
            const page = document.getElementById('page').value;
            try {
                const res = await fetch('/api/page/' + page);
                if (res.status === 401) return window.location.reload();
                const data = await res.json();
                document.getElementById('headline').value = data.hero_headline || '';
                document.getElementById('subheading').value = data.hero_subheading || '';
                document.getElementById('cta').value = data.hero_cta || '';
                document.getElementById('body').value = data.body_content || '';
                document.getElementById('secondary').value = data.secondary_text || '';
            } catch (error) {
                console.error('Error loading page:', error);
            }
        }

        async function savePage() {
            const page = document.getElementById('page').value;
            try {
                const res = await fetch('/api/page/' + page, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        hero_headline: document.getElementById('headline').value,
                        hero_subheading: document.getElementById('subheading').value,
                        hero_cta: document.getElementById('cta').value,
                        body_content: document.getElementById('body').value,
                        secondary_text: document.getElementById('secondary').value
                    })
                });
                if (res.status === 401) return window.location.reload();
                if (res.ok) {
                    showMessage('Saved successfully!', 'success');
                } else {
                    showMessage('Error saving page', 'error');
                }
            } catch (error) {
                console.error('Error saving:', error);
                showMessage('Error saving page', 'error');
            }
        }

        function showMessage(text, type) {
            const msg = document.getElementById('message');
            msg.textContent = text;
            msg.className = 'message ' + type;
            msg.style.display = 'block';
            setTimeout(() => { msg.style.display = 'none'; }, 5000);
        }

        loadPage();
    </script>
    <script src="https://unpkg.com/lucide@1.33.0"></script>
    <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
</body>
</html>`);
});

// ============================================
// PAGE CONTENT API (admin-only — guarded by the /api/page auth middleware above)
// ============================================
app.get('/api/page/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const { data, error } = await supabase
            .from('page_content')
            .select('*')
            .eq('page_slug', slug)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        res.json(data || { page_slug: slug });
    } catch (error) {
        console.error('Error fetching page:', error);
        res.status(500).json({ error: 'Error fetching page' });
    }
});

app.post('/api/page/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const content = req.body;

        content.updated_at = new Date().toISOString();
        content.page_slug = slug;

        const { data: existing } = await supabase
            .from('page_content')
            .select('id')
            .eq('page_slug', slug)
            .single();

        let result;
        if (existing) {
            result = await supabase
                .from('page_content')
                .update(content)
                .eq('page_slug', slug);
        } else {
            result = await supabase
                .from('page_content')
                .insert([content]);
        }

        if (result.error) throw result.error;

        res.json({ success: true, message: 'Page updated' });
    } catch (error) {
        console.error('Error saving page:', error);
        res.status(500).json({ error: 'Error saving page' });
    }
});

// ============================================
// GOOGLE SHEETS DATA EXPORT FUNCTION
// ============================================
// Ensures both tabs (Signups, CheckIns) exist in the spreadsheet.
// Runs once at startup. If the sheet was just created blank (only has the
// default "Sheet1"), this creates both tabs we actually need.
// ============================================
async function ensureGoogleSheetTabsExist() {
  if (!sheetsClient) return;

  try {
    const spreadsheet = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existingTitles = spreadsheet.data.sheets.map(s => s.properties.title);

    const neededTabs = ['Signups', 'CheckIns', 'Notes'];
    const tabsToCreate = neededTabs.filter(t => !existingTitles.includes(t));

    if (tabsToCreate.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: {
          requests: tabsToCreate.map(title => ({ addSheet: { properties: { title } } }))
        }
      });
      console.log(`✅ Created Google Sheets tabs: ${tabsToCreate.join(', ')}`);

      // Add header rows to any newly-created tabs
      if (tabsToCreate.includes('Signups')) {
        await appendRowToSheet('Signups', [
          'Timestamp', 'Dog ID', 'Email', 'Dog Name', 'Breed', 'Age', 'Gender', 'Baseline Weight',
          'Baseline Mobility', 'Baseline Energy', 'Baseline Appetite', 'Baseline Cognitive'
        ]);
      }
      if (tabsToCreate.includes('CheckIns')) {
        await appendRowToSheet('CheckIns', [
          'Timestamp', 'Dog ID', 'Dog Name', 'Week Number', 'Mobility', 'Energy', 'Appetite', 'Cognitive', 'Weight', 'Notes'
        ]);
      }
      if (tabsToCreate.includes('Notes')) {
        await appendRowToSheet('Notes', [
          'Timestamp', 'Dog ID', 'Dog Name', 'Note'
        ]);
      }
    }
  } catch (error) {
    console.warn('⚠️ Failed to verify/create Google Sheets tabs:', error.message);
  }
}

// ============================================
// Appends one row to the given tab. Uses the standard "append" API, which
// automatically finds the next empty row — simpler and one fewer network
// call than the old approach (which fetched sheet metadata every time just
// to append cells manually).
// ============================================
async function appendRowToSheet(tabName, rowValues) {
  if (!sheetsClient) {
    console.log('ℹ️ Google Sheets not connected, skipping export');
    return;
  }

  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [rowValues] }
    });
  } catch (error) {
    console.error(`⚠️ Failed to append to Google Sheets tab "${tabName}":`, error.message);
  }
}

// Make sure both tabs exist before anything tries to write to them
ensureGoogleSheetTabsExist();


// ============================================
// PHASE 1: WEEKLY CHECK-IN (Weeks 1-12)
// NEW ENDPOINT
// ============================================
app.post('/api/checkin', async (req, res) => {
    try {
        const {
            user_id,
            pet_id,
            week_number,
            mobility_score,
            observations,
            trend
        } = req.body;

        // ============================================
        // SERVER-SIDE VALIDATION
        // ============================================

        if (!user_id || !pet_id || !week_number || !mobility_score) {
            return res.status(400).json({
                error: 'Missing required fields: user_id, pet_id, week_number, mobility_score'
            });
        }

        // Validate UUID format (user_id and pet_id should be UUIDs)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(user_id)) {
            return res.status(400).json({ error: 'Invalid user_id format' });
        }
        if (!uuidRegex.test(pet_id)) {
            return res.status(400).json({ error: 'Invalid pet_id format' });
        }

        // Validate week_number
        const weekNum = parseInt(week_number);
        if (isNaN(weekNum) || weekNum < 1 || weekNum > 12) {
            return res.status(400).json({ error: 'week_number must be an integer between 1 and 12' });
        }

        // Validate mobility_score
        const mobilityScore = parseInt(mobility_score);
        if (isNaN(mobilityScore) || mobilityScore < 1 || mobilityScore > 8) {
            return res.status(400).json({ error: 'mobility_score must be a number between 1 and 8' });
        }

        // Validate trend if provided
        const validTrends = ['improving', 'stable', 'declining', ''];
        if (trend && !validTrends.includes(trend.toLowerCase())) {
            return res.status(400).json({ error: 'trend must be improving, stable, or declining' });
        }

        // Validate observations if provided (max 500 characters)
        if (observations && observations.length > 500) {
            return res.status(400).json({ error: 'observations must be 500 characters or less' });
        }

        // ============================================
        // INPUT SANITIZATION (AFTER VALIDATION)
        // ============================================
        const sanitizedObservations = observations ? sanitizeString(observations, 500) : null;
        const sanitizedTrend = trend ? sanitizeSelect(trend, ['improving', 'stable', 'declining', '']) : 'stable';

        // Save check-in to survey_weekly_checkins
        const { data: checkin, error: checkinError } = await supabase
            .from('survey_weekly_checkins')
            .upsert([{
                pet_id,
                user_id,
                week_number: parseInt(week_number),
                mobility_score: parseInt(mobility_score),
                observations: sanitizedObservations,
                trend: sanitizedTrend
            }], { onConflict: 'pet_id,week_number' })
            .select();

        if (checkinError) throw checkinError;
        console.log(`✅ Week ${week_number} check-in saved for pet: ${pet_id}`);

        // Queue enrichment question if weeks 1-4
        if (week_number >= 1 && week_number <= 4) {
            const enrichmentType = getEnrichmentForWeek(week_number);
            const nextTuesday = getNextTuesday();

            const { error: enrichError } = await supabase
                .from('sms_queue')
                .insert([{
                    user_id,
                    pet_id,
                    message_type: enrichmentType,
                    scheduled_for: nextTuesday.toISOString(),
                    message_body: getEnrichmentMessage(enrichmentType),
                    status: 'pending'
                }]);

            if (enrichError) console.error('Error queuing enrichment SMS:', enrichError);
        }

        // Queue next week's check-in if not at week 12
        if (week_number < 12) {
            const nextWeekTuesday = getNextTuesday();
            nextWeekTuesday.setDate(nextWeekTuesday.getDate() + 7);

            const { error: nextError } = await supabase
                .from('sms_queue')
                .insert([{
                    user_id,
                    pet_id,
                    message_type: `week_${week_number + 1}_checkin`,
                    scheduled_for: nextWeekTuesday.toISOString(),
                    message_body: `Week ${week_number + 1}: How's ${dog.dog_name} moving? (1-8)`,
                    status: 'pending'
                }]);

            if (nextError) console.error('Error queuing next week SMS:', nextError);
        }

        res.json({
            success: true,
            message: `✅ Week ${week_number} check-in recorded`,
            data: checkin
        });

    } catch (error) {
        console.error('Error processing check-in:', error);
        res.status(500).json({ error: 'Error processing check-in', details: error.message });
    }
});

// ============================================
// PHASE 1A: ENRICHMENT QUESTIONS (Weeks 1-5)
// NEW ENDPOINT
// ============================================
app.post('/api/enrichment', async (req, res) => {
    try {
        const {
            user_id,
            pet_id,
            week_number,
            typical_day_description,
            primary_goal,
            primary_goal_other,
            peer_comparison_interest,
            network_context
        } = req.body;

        if (!user_id || !pet_id || !week_number) {
            return res.status(400).json({ error: 'Missing: user_id, pet_id, week_number' });
        }

        const { data: enrichment, error: enrichError } = await supabase
            .from('survey_enrichment')
            .upsert([{
                user_id,
                pet_id,
                week_number: parseInt(week_number),
                typical_day_description: typical_day_description || null,
                primary_goal: primary_goal || null,
                primary_goal_other: primary_goal_other || null,
                peer_comparison_interest: peer_comparison_interest || null,
                network_context: network_context || null
            }], { onConflict: 'pet_id,week_number' })
            .select();

        if (enrichError) throw enrichError;
        console.log(`✅ Enrichment (week ${week_number}) saved for pet: ${pet_id}`);

        res.json({
            success: true,
            message: `✅ Week ${week_number} enrichment saved`,
            data: enrichment
        });

    } catch (error) {
        console.error('Error saving enrichment:', error);
        res.status(500).json({ error: 'Error saving enrichment', details: error.message });
    }
});

// ============================================
// SMS: QUEUE MANAGEMENT
// NEW ENDPOINTS
// ============================================
app.get('/api/sms/pending', async (req, res) => {
    try {
        const now = new Date().toISOString();

        const { data: pending, error } = await supabase
            .from('sms_queue')
            .select('*')
            .eq('status', 'pending')
            .lte('scheduled_for', now)
            .limit(100);

        if (error) throw error;

        res.json({
            count: pending.length,
            messages: pending
        });
    } catch (error) {
        console.error('Error fetching pending SMS:', error);
        res.status(500).json({ error: 'Error fetching pending SMS' });
    }
});

app.post('/api/sms/send', async (req, res) => {
    try {
        const { message_id, phone, message_body } = req.body;

        if (!phone || !message_body) {
            return res.status(400).json({ error: 'Missing phone or message_body' });
        }

        const sentMessage = await twilioClient.messages.create({
            body: message_body,
            from: TWILIO_PHONE_NUMBER,
            to: phone
        });

        await supabase
            .from('sms_queue')
            .update({
                status: 'sent',
                twilio_sid: sentMessage.sid,
                sent_at: new Date().toISOString()
            })
            .eq('id', message_id);

        console.log(`✅ SMS sent to ${phone} (SID: ${sentMessage.sid})`);

        res.json({
            success: true,
            message: 'SMS sent successfully',
            twilio_sid: sentMessage.sid
        });

    } catch (error) {
        console.error('Error sending SMS:', error);
        res.status(500).json({ error: 'Error sending SMS', details: error.message });
    }
});

app.post('/api/sms/mark-sent', async (req, res) => {
    try {
        const { message_id, twilio_sid } = req.body;

        const { error } = await supabase
            .from('sms_queue')
            .update({
                status: 'sent',
                twilio_sid: twilio_sid,
                sent_at: new Date().toISOString()
            })
            .eq('id', message_id);

        if (error) throw error;

        res.json({ success: true, message: 'SMS marked as sent' });
    } catch (error) {
        console.error('Error marking SMS as sent:', error);
        res.status(500).json({ error: 'Error updating SMS status' });
    }
});

app.post('/api/sms/mark-failed', async (req, res) => {
    try {
        const { message_id, status, error_message } = req.body;

        const { error: updateError } = await supabase
            .from('sms_queue')
            .update({
                status: status || 'failed',
                error_message: error_message,
                updated_at: new Date().toISOString()
            })
            .eq('id', message_id);

        if (updateError) throw updateError;

        if (status === 'opted_out') {
            const { data: smsRow } = await supabase
                .from('sms_queue')
                .select('user_id')
                .eq('id', message_id)
                .single();

            if (smsRow) {
                await supabase
                    .from('sms_preferences')
                    .update({
                        sms_opted_out: true,
                        sms_opted_out_at: new Date().toISOString()
                    })
                    .eq('user_id', smsRow.user_id);
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error marking SMS as failed:', error);
        res.status(500).json({ error: 'Error updating SMS status' });
    }
});

app.post('/api/sms/webhook', async (req, res) => {
    try {
        const { MessageSid, MessageStatus, To } = req.body;

        if (!MessageSid) {
            return res.status(400).json({ error: 'Missing MessageSid' });
        }

        const statusMap = {
            'delivered': 'sent',
            'failed': 'failed',
            'undelivered': 'bounced'
        };

        const mappedStatus = statusMap[MessageStatus] || MessageStatus;

        const { error } = await supabase
            .from('sms_queue')
            .update({
                status: mappedStatus,
                updated_at: new Date().toISOString()
            })
            .eq('twilio_sid', MessageSid);

        if (error) {
            console.error('Error updating SMS status from webhook:', error);
        } else {
            console.log(`✅ SMS status updated: ${MessageSid} → ${mappedStatus}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error processing Twilio webhook:', error);
        res.status(500).json({ error: 'Error processing webhook' });
    }
});

// ============================================
// SENIOR DOGS MOBILITY: CHECK-IN FORM PAGE
// NEW ENDPOINT - STEP 4
// ============================================
app.get('/check-in/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;

    // Get dog details from database
    const { data: dog, error } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (error || !dog) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Dog Not Found</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; }
            .card { background: white; border-radius: 12px; padding: 20px; text-align: center; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>❌ Dog Not Found</h2>
            <p>We couldn't find this dog's profile. Please check your link and try again.</p>
          </div>
        </body>
        </html>
      `);
    }

    // STEP: Block check-in access during the 7-day baseline period, not just
    // hide the button. Matches the same rule used on the dashboard — this
    // closes the side door where someone could reach this page directly
    // (an old link, a bookmark, etc.) before their first update is due.
    const daysSinceSignupForCheckin = (new Date() - new Date(dog.created_at)) / (24 * 60 * 60 * 1000);
    if (Math.floor(daysSinceSignupForCheckin / 7) === 0) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Not ready yet</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; text-align: center; }
            .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            .cta { display: inline-block; margin-top: 20px; background: #A89968; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; }
          </style>
        </head>
        <body>
          <div class="card">
            <p style="font-size: 40px; margin: 0 0 10px 0;"><i data-lucide="clipboard-list"></i></p>
            <h2 style="margin: 0 0 10px 0;">Not quite ready yet</h2>
            <p style="color: #666;">${dog.dog_name}'s first weekly update becomes available 7 days after signing up. You'll get a text when it's time.</p>
            <a href="/dashboard/${dog_id}" class="cta">View Dashboard</a>
          </div>
          <script src="https://unpkg.com/lucide@1.33.0"></script>
          <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
        </body>
        </html>
      `);
    }

    // Get check-in history for comparison. No .limit(1) — weight isn't
    // recorded every week (only every 4th, same as cognitive), so the full
    // history is fetched to find the latest check-in that actually has one.
    const { data: latestCheckins } = await supabase
      .from('mobility_checkins')
      .select('mobility_score, energy_score, appetite_score, cognitive_score, weight_lbs, week_number')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false });

    const latestScore = latestCheckins?.[0]?.mobility_score ?? dog.baseline_mobility_score ?? null;
    const latestEnergy = latestCheckins?.[0]?.energy_score ?? dog.baseline_energy_score ?? null;
    const latestAppetite = latestCheckins?.[0]?.appetite_score ?? dog.baseline_appetite_score ?? null;
    const latestCognitive = latestCheckins?.[0]?.cognitive_score ?? dog.baseline_cognitive_score ?? null;
    const latestWeight = latestCheckins?.find(c => c.weight_lbs != null)?.weight_lbs ?? dog.weight_lbs ?? null;

    // Calculate the actual current week based on when the dog was enrolled
    // (matches the same calculation used at submission time in /api/checkin-senior)
    const created = new Date(dog.created_at);
    const now = new Date();
    const weekNumber = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);

    // Cognitive/behavior is only asked every 4th week (4, 8, 12...)
    const showCognitive = weekNumber % 4 === 0;

    // Send HTML form
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${dog.dog_name}'s Check-In</title>
        <style>
          body {
            font-family: -apple-system, sans-serif;
            max-width: 500px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
          }
          .card {
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          h2 { margin: 0 0 10px 0; color: #333; }
          .subtitle { color: #666; margin: 0 0 20px 0; font-size: 14px; }
          label { display: block; margin: 15px 0 5px 0; font-weight: 600; color: #333; }
          input[type=range] { width: 100%; cursor: pointer; }
          input[type=number] {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-family: inherit;
            font-size: 14px;
            box-sizing: border-box;
          }
          .hint { font-size: 12px; color: #666; margin: 5px 0 0 0; }
          textarea {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 8px;
            font-family: inherit;
            font-size: 14px;
            box-sizing: border-box;
          }
          button {
            background: #007AFF;
            color: white;
            border: none;
            padding: 15px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
            margin-top: 20px;
            font-weight: 600;
          }
          button:hover { background: #0051D5; }
          button:active { opacity: 0.8; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2><i data-lucide="clipboard-check"></i> ${dog.dog_name}'s Check-In</h2>
          <p class="subtitle">Week ${weekNumber} Health Tracker</p>

          <form id="checkinForm">
            <label for="mobility">How's ${dog.dog_name}'s mobility this week?</label>
            <input
              type="range"
              id="mobility"
              name="mobility_score"
              min="1"
              max="8"
              value="${latestScore || 4}"
            >
            <div class="hint" id="mobilityHint">4/8 - Some good days, some bad days</div>

            <label for="energy" style="margin-top: 20px;">How's ${dog.dog_name}'s energy level this week?</label>
            <input
              type="range"
              id="energy"
              name="energy_score"
              min="1"
              max="8"
              value="${latestEnergy || 4}"
            >
            <div class="hint" id="energyHint">4/8 - Average energy</div>

            <label for="appetite" style="margin-top: 20px;">How's ${dog.dog_name}'s appetite this week?</label>
            <input
              type="range"
              id="appetite"
              name="appetite_score"
              min="1"
              max="8"
              value="${latestAppetite || 4}"
            >
            <div class="hint" id="appetiteHint">4/8 - Average appetite</div>

            ${showCognitive ? `
            <label for="cognitive" style="margin-top: 20px;">How's ${dog.dog_name}'s alertness &amp; behavior this week?</label>
            <input
              type="range"
              id="cognitive"
              name="cognitive_score"
              min="1"
              max="8"
              value="${latestCognitive || 4}"
            >
            <div class="hint" id="cognitiveHint">4/8 - Average alertness</div>
            ` : ''}

            ${showCognitive ? `
            <label for="weight" style="margin-top: 20px;">${dog.dog_name}'s weight this week (lbs)</label>
            <input
              type="number"
              id="weight"
              name="weight_lbs"
              min="1"
              max="250"
              value="${latestWeight || ''}"
              placeholder="e.g. 62"
            >
            <div class="hint">Optional — tracked alongside mobility, energy, and appetite.</div>
            ` : ''}

            <label for="observation" style="margin-top: 20px;">Any notes? (optional)</label>
            <textarea
              id="observation"
              name="observation"
              placeholder="E.g., 'Easier on stairs this week' or 'Stiff in morning'"
              style="height: 80px;"
            ></textarea>

            <button type="submit">Submit Check-In ✓</button>
          </form>
        </div>

        <script>
          const mobilitySlider = document.getElementById('mobility');
          const mobilityHints = {
            1: "1/8 - Very stiff/limited movement",
            2: "2/8 - Mostly struggling",
            3: "3/8 - Significant issues",
            4: "4/8 - Some good days, some bad days",
            5: "5/8 - Moderate improvement",
            6: "6/8 - Noticeably better",
            7: "7/8 - Very active",
            8: "8/8 - Excellent, no mobility issues"
          };
          mobilitySlider.addEventListener('input', () => {
            document.getElementById('mobilityHint').textContent = mobilityHints[mobilitySlider.value];
          });

          const energySlider = document.getElementById('energy');
          const energyHints = {
            1: "1/8 - Very low energy",
            2: "2/8 - Mostly lethargic",
            3: "3/8 - Below average energy",
            4: "4/8 - Average energy",
            5: "5/8 - Fairly active",
            6: "6/8 - Active",
            7: "7/8 - Very active",
            8: "8/8 - Extremely energetic"
          };
          energySlider.addEventListener('input', () => {
            document.getElementById('energyHint').textContent = energyHints[energySlider.value];
          });

          const appetiteSlider = document.getElementById('appetite');
          const appetiteHints = {
            1: "1/8 - Barely eating",
            2: "2/8 - Eating very little",
            3: "3/8 - Below average appetite",
            4: "4/8 - Average appetite",
            5: "5/8 - Good appetite",
            6: "6/8 - Very good appetite",
            7: "7/8 - Excellent appetite",
            8: "8/8 - Eating everything in sight"
          };
          appetiteSlider.addEventListener('input', () => {
            document.getElementById('appetiteHint').textContent = appetiteHints[appetiteSlider.value];
          });

          const cognitiveSlider = document.getElementById('cognitive');
          if (cognitiveSlider) {
            const cognitiveHints = {
              1: "1/8 - Often confused/withdrawn",
              2: "2/8 - Frequently disoriented",
              3: "3/8 - Below average alertness",
              4: "4/8 - Average alertness",
              5: "5/8 - Fairly engaged",
              6: "6/8 - Engaged and responsive",
              7: "7/8 - Very sharp",
              8: "8/8 - Sharp and fully engaged"
            };
            cognitiveSlider.addEventListener('input', () => {
              document.getElementById('cognitiveHint').textContent = cognitiveHints[cognitiveSlider.value];
            });
          }

          document.getElementById('checkinForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const formData = new FormData(e.target);
            try {
              const response = await fetch('/api/checkin-senior', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  dog_id: '${dog_id}',
                  mobility_score: parseInt(formData.get('mobility_score')),
                  energy_score: parseInt(formData.get('energy_score')),
                  appetite_score: parseInt(formData.get('appetite_score')),
                  cognitive_score: formData.get('cognitive_score') ? parseInt(formData.get('cognitive_score')) : null,
                  weight_lbs: formData.get('weight_lbs') ? parseInt(formData.get('weight_lbs')) : null,
                  observation: formData.get('observation') || null
                })
              });

              const result = await response.json();

              if (result.success) {
                const streakBadge = result.current_streak > 1 ? \`
                  <div style="background: #FFF3E0; border-radius: 8px; padding: 12px 16px; margin: 16px 0; display: inline-block;">
                    <i data-lucide="flame" style="width: 20px; height: 20px; vertical-align: middle;"></i>
                    <span style="font-size: 16px; font-weight: 600; color: #E65100;">\${result.current_streak} week streak</span>
                  </div>
                \` : '';

                const milestoneBanner = result.milestone_message ? \`
                  <p style="font-size: 14px; color: #2E7D32; font-weight: 600; margin: 12px 0; background: #E8F5E9; border-radius: 8px; padding: 10px;">
                    <i data-lucide="award" style="width: 1em; height: 1em; vertical-align: -0.15em;"></i> \${result.milestone_message}
                  </p>
                \` : '';

                const cognitiveWeekNote = result.was_cognitive_week ? \`
                  <p style="font-size: 13px; color: #555; margin: 12px 0; background: #F5F5F5; border-radius: 8px; padding: 8px 10px;">
                    Also logged: weight and cognitive/behavior — thanks for the extra detail this week.
                  </p>
                \` : '';

                document.body.innerHTML = \`
                  <div class="card" style="text-align: center;">
                    <h2 style="color: green;">✅ Check-In Submitted!</h2>
                    <p style="font-size: 18px; color: #007AFF; margin: 20px 0;">
                      ${dog.dog_name}'s mobility: \${result.mobility_score}/8
                    </p>
                    \${streakBadge}
                    \${milestoneBanner}
                    \${cognitiveWeekNote}
                    <p style="font-size: 14px; color: #666; margin: 20px 0;">
                      \${result.change_text}
                    </p>
                    <p style="font-size: 12px; color: #999;">
                      You'll get SMS updates each week. Thanks for tracking!
                    </p>
                  </div>
                \`;
                lucide.createIcons({ attrs: { width: '1em', height: '1em' } });
              } else {
                alert('Error: ' + (result.error || 'Unknown error'));
              }
            } catch (error) {
              console.error('Error:', error);
              alert('Error submitting check-in. Please try again.');
            }
          });
        </script>
        <script src="https://unpkg.com/lucide@1.33.0"></script>
        <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Error in check-in form:', error);
    res.status(500).send('Error loading check-in form');
  }
});

// ============================================
// SENIOR DOGS MOBILITY: SAVE CHECK-IN DATA
// NEW ENDPOINT - STEP 5 (companion to STEP 4)
// ============================================
// ============================================
// STEP 27B: POST-LOG MICRO-INSIGHTS
// Compares this week's 4 scores to last week's (or baseline, for cognitive
// on weeks it wasn't asked) and writes a sentence about whichever metric
// actually moved the most — not always mobility.
// ============================================
function generatePostLogInsight(dogName, current, previous) {
  // current/previous are objects: { mobility, energy, appetite, cognitive }
  // previous.cognitive may be null if no prior weekly cognitive score exists —
  // caller is responsible for passing baseline_cognitive_score as the fallback in that case.

  const metrics = [
    { key: 'mobility', label: 'mobility' },
    { key: 'energy', label: 'energy' },
    { key: 'appetite', label: 'appetite' },
    { key: 'cognitive', label: 'cognitive sharpness' }
  ];

  // Build a diff for each metric we actually have both values for
  const diffs = metrics
    .filter(m => current[m.key] != null && previous[m.key] != null)
    .map(m => ({
      ...m,
      diff: current[m.key] - previous[m.key],
      currentVal: current[m.key]
    }));

  if (diffs.length === 0) {
    // Shouldn't normally happen (mobility/energy/appetite are always required),
    // but guard against it rather than crash.
    return `Thanks for logging ${dogName}'s check-in this week!`;
  }

  // Find the metric with the biggest absolute change
  const biggest = diffs.reduce((a, b) => (Math.abs(b.diff) > Math.abs(a.diff) ? b : a));

  // Everything flat — no metric moved
  if (biggest.diff === 0) {
    const flatVariants = [
      `${dogName}'s scores held steady across the board this week. Consistency like this makes patterns easier to spot down the line.`,
      `No major changes for ${dogName} this week — steady weeks matter too. Keep the check-ins coming.`,
      `${dogName} looks about the same as last week. That stability itself is worth tracking over time.`
    ];
    return flatVariants[Math.floor(Math.random() * flatVariants.length)];
  }

  const direction = biggest.diff > 0 ? 'up' : 'down';
  const absDiff = Math.abs(biggest.diff);

  const upVariants = [
    `${dogName}'s ${biggest.label} is up ${absDiff} point${absDiff > 1 ? 's' : ''} from last week — nice trend, keep it going.`,
    `Good sign: ${dogName}'s ${biggest.label} improved by ${absDiff} point${absDiff > 1 ? 's' : ''} since last week.`,
    `${dogName}'s ${biggest.label} moved up this week (+${absDiff}). Worth noting if anything changed in the routine.`
  ];

  const downVariants = [
    `${dogName}'s ${biggest.label} is down ${absDiff} point${absDiff > 1 ? 's' : ''} from last week. Nothing to panic about from a single week — but worth watching next week.`,
    `Heads up: ${dogName}'s ${biggest.label} dropped ${absDiff} point${absDiff > 1 ? 's' : ''} since last week. Keep logging so you can see if it's a trend or a one-off.`,
    `${dogName}'s ${biggest.label} was a bit lower this week (-${absDiff}). One week alone isn't a pattern — tracking it is how you'll know.`
  ];

  const variants = direction === 'up' ? upVariants : downVariants;
  return variants[Math.floor(Math.random() * variants.length)];
}

// ============================================
// STEP 27C: STREAK GAMIFICATION
// current_streak is deliberately NOT stored anywhere — it's calculated
// live from mobility_checkins, same logic the dashboard already uses.
// This function is the single shared source of truth for that calculation
// so the dashboard and the check-in endpoint can never disagree.
// ============================================
async function calculateCurrentStreak(dog_id) {
  const { data: checkins } = await supabase
    .from('mobility_checkins')
    .select('week_number')
    .eq('dog_id', dog_id);

  if (!checkins || checkins.length === 0) return 0;

  let streak = 0;
  const sortedByWeek = [...checkins].sort((a, b) => b.week_number - a.week_number);
  // Defensive floor: a stray week_number of 0 or less (bad data, clock skew,
  // pre-fix legacy rows) shouldn't make the countdown loop skip entirely.
  const maxWeek = Math.max(1, sortedByWeek[0].week_number);
  for (let i = maxWeek; i >= 1; i--) {
    const hasWeek = checkins.some(c => c.week_number === i);
    if (hasWeek) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Returns a milestone message for round-number streaks, or null on
// non-milestone weeks (so the front end can just not show anything extra).
function getStreakMilestoneMessage(dogName, streak) {
  const milestones = {
    2: `2 weeks in a row for ${dogName}! You're building a real health journey.`,
    4: `${dogName}'s first month of consistent tracking — 4 weeks straight!`,
    8: `8-week streak for ${dogName}. Patterns are getting clearer with every check-in.`,
    12: `${dogName} made it a full 12 weeks! This is exactly the kind of consistency that builds a real picture of ${dogName}'s health over time.`
  };
  return milestones[streak] || null;
}

// ============================================
// STEP 27D: HEALTH ALERT TRIGGERS
// Dashboard-only (no SMS). Fires on 2+ point swings in EITHER direction
// (threshold is provisional — no real user data yet to tune it).
// De-dupes per dog+metric within a 14-day window so owners aren't shown
// the same alert repeatedly.
// ============================================
const HEALTH_ALERT_THRESHOLD = 2; // points, provisional
const HEALTH_ALERT_DEDUP_DAYS = 14;

async function detectHealthAlerts(dog_id, dogName, current, previous) {
  const metrics = [
    { key: 'mobility', label: 'mobility' },
    { key: 'energy', label: 'energy' },
    { key: 'appetite', label: 'appetite' },
    { key: 'cognitive', label: 'cognitive sharpness' }
  ];

  const fourteenDaysAgo = new Date(Date.now() - HEALTH_ALERT_DEDUP_DAYS * 24 * 60 * 60 * 1000).toISOString();

  for (const m of metrics) {
    if (current[m.key] == null || previous[m.key] == null) continue;

    const diff = current[m.key] - previous[m.key];
    if (Math.abs(diff) < HEALTH_ALERT_THRESHOLD) continue; // didn't cross threshold

    const direction = diff > 0 ? 'up' : 'down';
    const magnitude = Math.abs(diff);

    // De-dup: skip if this dog already got an alert for this exact metric AND
    // direction within the last 14 days. Direction-specific on purpose — a
    // decline alert shouldn't suppress a later improvement alert for the same
    // metric (a recovery is worth surfacing even if a drop fired recently).
    const { data: recentAlerts } = await supabase
      .from('health_alerts')
      .select('id')
      .eq('dog_id', dog_id)
      .eq('metric', m.key)
      .eq('direction', direction)
      .gte('created_at', fourteenDaysAgo)
      .limit(1);

    if (recentAlerts && recentAlerts.length > 0) continue; // already alerted recently

    // SAFE, non-diagnostic framing — no treatment claims, always points to the vet.
    // See project compliance framework: observational only, never interprets
    // what a change "means" medically.
    const message = direction === 'down'
      ? `${dogName}'s ${m.label} dropped ${magnitude} points compared to a recent check-in. This isn't a diagnosis — just a pattern that might be worth mentioning at ${dogName}'s next vet visit.`
      : `${dogName}'s ${m.label} improved ${magnitude} points compared to a recent check-in. Worth noting what's been different lately.`;

    const { error: alertError } = await supabase
      .from('health_alerts')
      .insert({
        dog_id: dog_id,
        metric: m.key,
        direction: direction,
        magnitude: magnitude,
        message: message
      });

    if (alertError) console.warn(`⚠️ Error saving health alert for ${m.key}:`, alertError);
  }
}

app.post('/api/checkin-senior', async (req, res) => {
  try {
    const { dog_id, mobility_score, energy_score, appetite_score, cognitive_score, weight_lbs, observation } = req.body;

    // Validation
    if (!dog_id || !mobility_score || !energy_score || !appetite_score) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: dog_id, mobility_score, energy_score, appetite_score'
      });
    }

    const mobilityScoreInt = parseInt(mobility_score);
    if (isNaN(mobilityScoreInt) || mobilityScoreInt < 1 || mobilityScoreInt > 8) {
      return res.status(400).json({
        success: false,
        error: 'Mobility score must be between 1 and 8'
      });
    }

    const energyScoreInt = parseInt(energy_score);
    if (isNaN(energyScoreInt) || energyScoreInt < 1 || energyScoreInt > 8) {
      return res.status(400).json({
        success: false,
        error: 'Energy score must be between 1 and 8'
      });
    }

    const appetiteScoreInt = parseInt(appetite_score);
    if (isNaN(appetiteScoreInt) || appetiteScoreInt < 1 || appetiteScoreInt > 8) {
      return res.status(400).json({
        success: false,
        error: 'Appetite score must be between 1 and 8'
      });
    }

    // Cognitive/behavior is only asked every 4th week, so it's optional here
    let cognitiveScoreInt = null;
    if (cognitive_score !== undefined && cognitive_score !== null && cognitive_score !== '') {
      cognitiveScoreInt = parseInt(cognitive_score);
      if (isNaN(cognitiveScoreInt) || cognitiveScoreInt < 1 || cognitiveScoreInt > 8) {
        return res.status(400).json({
          success: false,
          error: 'Cognitive score must be between 1 and 8'
        });
      }
    }

    // Weight is also only asked every 4th week, same trigger as cognitive —
    // optional here too, and validated against the same 1-250 range used
    // for the one-time baseline weight at signup.
    let weightLbsInt = null;
    if (weight_lbs !== undefined && weight_lbs !== null && weight_lbs !== '') {
      weightLbsInt = parseInt(weight_lbs);
      if (isNaN(weightLbsInt) || weightLbsInt < 1 || weightLbsInt > 250) {
        return res.status(400).json({
          success: false,
          error: 'Weight must be a number between 1 and 250 lbs'
        });
      }
    }

    // Get the dog info
    const { data: dog } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (!dog) {
      return res.status(404).json({
        success: false,
        error: 'Dog not found'
      });
    }

    // STEP: Real enforcement of the 7-day baseline gate. Blocking the page
    // isn't enough on its own — this is the actual save endpoint, so this
    // is the check that actually matters. Someone POSTing here directly
    // (bypassing the page) still can't save an early check-in.
    const daysSinceSignupForSave = (new Date() - new Date(dog.created_at)) / (24 * 60 * 60 * 1000);
    if (Math.floor(daysSinceSignupForSave / 7) === 0) {
      return res.status(403).json({
        success: false,
        error: `${dog.dog_name}'s first weekly update isn't available yet — it opens up 7 days after signing up.`
      });
    }

    // Calculate week number based on when dog was created
    const created = new Date(dog.created_at);
    const now = new Date();
    // Floor at week 1 — matches the same safety clamp already used on the
    // check-in display page. Without this, clock skew or a created_at that's
    // slightly in the future (found during 27C testing) can save week_number
    // as 0 or negative, which silently breaks streak counting downstream.
    const weekNumber = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);

    // Get previous check-in for comparison — pulling all 4 scores now, not just mobility,
    // so the post-log insight (STEP 27B) can comment on whichever metric actually moved most.
    const { data: prevCheckins } = await supabase
      .from('mobility_checkins')
      .select('mobility_score, energy_score, appetite_score, cognitive_score')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false })
      .limit(1);

    const previousScore = prevCheckins?.[0]?.mobility_score || dog.baseline_mobility_score;
    const scoreDiff = mobilityScoreInt - previousScore;

    // Determine segment (A=improving, B=flat, C=declining)
    let segment = 'B'; // default moderate
    if (scoreDiff >= 1) segment = 'A'; // improving
    if (scoreDiff <= -1) segment = 'C'; // declining

    // ============================================
    // CAPTURE SUBMISSION TIME & CALCULATE REMINDER PREFERENCE
    // ============================================
    const submissionTime = new Date();
    const submissionDayOfWeek = submissionTime.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

    // Determine reminder time based on day of week
    let reminderTime = '07:30'; // default weekday
    if (submissionDayOfWeek === 0 || submissionDayOfWeek === 6) {
      // Weekend (Saturday=6, Sunday=0)
      reminderTime = '14:00'; // 2:00 PM
    }
    // Weekday (Mon-Fri) uses 7:30 AM

    // Update dog's preferred reminder day and time
    const { error: updateError } = await supabase
      .from('senior_dogs')
      .update({
        preferred_reminder_day: submissionDayOfWeek,
        preferred_reminder_time: reminderTime
      })
      .eq('id', dog_id);

    if (updateError) console.warn('⚠️ Error updating reminder preference:', updateError);

    // Save check-in to database
    const { data: checkin, error: saveError } = await supabase
      .from('mobility_checkins')
      .insert({
        dog_id: dog_id,
        week_number: weekNumber,
        mobility_score: mobilityScoreInt,
        energy_score: energyScoreInt,
        appetite_score: appetiteScoreInt,
        cognitive_score: cognitiveScoreInt,
        weight_lbs: weightLbsInt,
        observation: observation || null,
        segment: segment
      });

    if (saveError) throw saveError;

    // ============================================
    // STEP 27C: UPDATE STREAK (current is live-calculated, only longest is stored)
    // ============================================
    const currentStreak = await calculateCurrentStreak(dog_id);
    let longestStreak = dog.longest_streak || 0;

    if (currentStreak > longestStreak) {
      longestStreak = currentStreak;
      const { error: streakError } = await supabase
        .from('senior_dogs')
        .update({ longest_streak: longestStreak })
        .eq('id', dog_id);
      if (streakError) console.warn('⚠️ Error updating longest_streak:', streakError);
    }

    const milestoneMessage = getStreakMilestoneMessage(dog.dog_name, currentStreak);

    // ============================================
    // QUEUE NEXT WEEK'S SMS AT PERSONALIZED TIME
    // ============================================
    const nextReminderDate = getNextReminderDate(submissionDayOfWeek, reminderTime);
    const nextCheckinLink = `${BASE_URL}/check-in/${dog_id}`;

    // Only queue a reminder text if this owner actually opted in to SMS reminders.
    if (dog.sms_consent && dog.phone) {
      const { error: queueError } = await supabase
        .from('sms_queue')
        .insert([{
          pet_id: dog_id,
          phone: dog.phone,
          message_type: `week_${weekNumber + 1}_checkin`,
          scheduled_for: nextReminderDate.toISOString(),
          message_body: `${dog.dog_name}'s week #${weekNumber + 1} check-in: ${nextCheckinLink}`,
          status: 'pending'
        }]);

      if (queueError) console.warn('⚠️ Error queueing next reminder:', queueError);
      console.log(`📅 Next reminder for ${dog.dog_name} scheduled: ${nextReminderDate.toLocaleString()} (${getDayName(submissionDayOfWeek)} at ${reminderTime})`);
    } else {
      console.log(`📅 Skipping reminder queue for ${dog.dog_name} — SMS consent not given`);
    }

    // Generate feedback message (STEP 27B: Post-Log Micro-Insights)
    // Compares all 4 metrics against last week (cognitive falls back to baseline
    // on weeks it isn't asked, since it's only collected every 4th week).
    const prevRow = prevCheckins?.[0];
    const currentScores = {
      mobility: mobilityScoreInt,
      energy: energyScoreInt,
      appetite: appetiteScoreInt,
      cognitive: cognitiveScoreInt // null on non-4th weeks, that's fine — diff just skips it
    };
    const previousScores = {
      mobility: prevRow?.mobility_score ?? dog.baseline_mobility_score,
      energy: prevRow?.energy_score ?? dog.baseline_energy_score,
      appetite: prevRow?.appetite_score ?? dog.baseline_appetite_score,
      cognitive: prevRow?.cognitive_score ?? dog.baseline_cognitive_score
    };

    const changeText = generatePostLogInsight(dog.dog_name, currentScores, previousScores);

    // STEP 27D: Health Alert Triggers — dashboard-only, no SMS. Runs after
    // the insight so it reuses the same current/previous data. Doesn't block
    // or affect the response either way — alerts show up on next dashboard load.
    await detectHealthAlerts(dog_id, dog.dog_name, currentScores, previousScores);

    // Export to Google Sheets (CheckIns tab) — real-time, one row per
    // check-in. Doesn't block or affect the response if this fails.
    await appendRowToSheet('CheckIns', [
      new Date().toISOString(),
      dog_id,
      dog.dog_name || '',
      weekNumber,
      currentScores.mobility ?? '',
      currentScores.energy ?? '',
      currentScores.appetite ?? '',
      currentScores.cognitive ?? '',
      weightLbsInt ?? '',
      observation || ''
    ]);

    console.log(`✅ Week ${weekNumber} check-in saved for ${dog.dog_name}`);
    console.log(`🔥 Current streak: ${currentStreak}, longest: ${longestStreak}`);

    res.json({
      success: true,
      mobility_score: mobilityScoreInt,
      weight_lbs: weightLbsInt,
      change_text: changeText,
      week_number: weekNumber,
      segment: segment,
      current_streak: currentStreak,
      longest_streak: longestStreak,
      milestone_message: milestoneMessage,
      was_cognitive_week: weekNumber % 4 === 0
    });

  } catch (error) {
    console.error('Error saving check-in:', error);
    res.status(500).json({
      success: false,
      error: 'Error saving check-in',
      details: error.message
    });
  }
});

// ============================================
// SENIOR DOGS MOBILITY: DASHBOARD
// NEW ENDPOINT - STEP 7
// Displays: mobility score, trend, streak, peer comparison with Chart.js
// ============================================
// ============================================
// STEP P1D: CONTENT REWARDS (Tier 1 — Breed History)
// Static content, no AI generation, no cohort comparisons — deliberately
// scoped down from the original spec, which called for AI-generated guides
// with "compared to X other dogs on this platform" claims. That kind of
// claim needs a real breed cohort to be honest, and there are zero real
// founding members yet. This version uses only general, well-established
// breed knowledge and shows the dog's OWN score neutrally, never compared
// to other users. Add the cohort-comparison layer once P1C's blocker clears.
//
// Unlock state is NOT stored anywhere — same pattern as current_streak.
// "Unlocked" just means "this dog's current week is >= 2," computed live
// from the same week-number logic already used elsewhere, so there's
// nothing that can drift out of sync.
// ============================================
const BREED_GUIDES = {
  // ===== Larger breeds =====
  'labrador': {
    displayName: 'Labrador Retriever',
    typicalWeight: '55–80 lb',
    history: `Labrador Retrievers originated in Newfoundland, Canada, where they worked alongside fishermen retrieving nets and catch from icy water. Their name comes from the nearby Labrador Sea. They were brought to England in the 1800s, refined into the breed known today, and have been one of the most popular family dogs for decades.`,
    temperament: `Labs are known for being friendly, outgoing, and eager to please — traits that made them natural fits as family companions, service dogs, and working retrievers. They tend to stay playful well into their senior years, though most slow down noticeably by age 9-10.`,
    seniorPatterns: `As Labs age, joint health is one of the most commonly discussed topics among owners, given the breed's size and activity level earlier in life. Morning stiffness, a preference for shorter walks, and more careful movement on stairs are all commonly reported by owners of senior Labs. This isn't universal, and every dog ages differently — but it's a pattern worth being aware of and worth mentioning to your vet if you notice it.`
  },
  'golden retriever': {
    displayName: 'Golden Retriever',
    typicalWeight: '55–75 lb',
    history: `Golden Retrievers were developed in Scotland in the mid-1800s, bred specifically for retrieving waterfowl in the Scottish Highlands. Their soft mouths (for retrieving game undamaged) and warm temperament made them quickly popular beyond hunting, becoming one of the most beloved family breeds worldwide.`,
    temperament: `Goldens are known for being gentle, patient, and intelligent — qualities that make them common choices for therapy and service work. Many stay affectionate and eager to be near their people throughout their senior years.`,
    seniorPatterns: `Golden Retrievers are a breed where owners commonly discuss joint and mobility changes with age, along with skin and coat changes. Many senior Goldens do well with consistent, moderate exercise rather than high-intensity activity. As always, individual dogs vary widely — tracking your own dog's patterns over time is more useful than any breed generalization.`
  },
  'german shepherd': {
    displayName: 'German Shepherd',
    typicalWeight: '50–90 lb',
    history: `German Shepherds were developed in Germany in the late 1800s, originally bred for herding sheep and valued for their intelligence, trainability, and versatility. Those same traits later made them a top choice for police, military, and service work worldwide.`,
    temperament: `German Shepherds are known for loyalty, confidence, and a strong working drive. They tend to bond closely with their families and often remain alert and engaged well into their senior years.`,
    seniorPatterns: `Hind-leg mobility and stability are commonly discussed topics among senior German Shepherd owners, given the breed's build. Owners often notice changes in how a dog navigates stairs or gets up after resting before other changes appear. This is general breed-level context, not a prediction for any individual dog — tracking your own dog's actual patterns is what matters most.`
  },
  'rottweiler': {
    displayName: 'Rottweiler',
    typicalWeight: '80–135 lb',
    history: `Rottweilers trace back to Roman drover dogs used to herd cattle, later refined in the German town of Rottweil, where they were used to drive livestock to market and pull carts. Their strength and work ethic later made them popular for police and guard work.`,
    temperament: `Rottweilers are known for being confident, loyal, and protective of their families. Many remain calm and steady companions well into their senior years, though their size means mobility changes can be more noticeable.`,
    seniorPatterns: `Joint health — particularly hips and elbows — is one of the most commonly discussed topics among Rottweiler owners, given the breed's size and build. Owners often notice changes in willingness to jump, climb stairs, or rise after resting before other signs appear. Weight management is frequently discussed too, since extra weight adds real strain to large joints.`
  },
  'german shorthaired pointer': {
    displayName: 'German Shorthaired Pointer',
    typicalWeight: '45–70 lb',
    history: `German Shorthaired Pointers were developed in Germany in the 1800s as versatile hunting dogs, bred to point, track, and retrieve across a range of terrain and game.`,
    temperament: `GSPs are known for being high-energy, intelligent, and eager to work — traits that made them prized all-purpose hunting companions. Many stay active and engaged well into their senior years, though exercise needs typically taper with age.`,
    seniorPatterns: `Joint health is a commonly discussed topic among GSP owners as the breed ages, given their athletic build and activity level earlier in life. Owners often notice gradual changes in stamina or willingness for longer outings before other signs appear. Adjusting exercise intensity (not necessarily stopping it) is a common conversation senior GSP owners have with their vets.`
  },
  'cane corso': {
    displayName: 'Cane Corso',
    typicalWeight: '85–110 lb',
    history: `Cane Corsos descend from ancient Roman war and guard dogs, developed in southern Italy and traditionally used for guarding property and livestock. The name roughly translates to "bodyguard dog."`,
    temperament: `Cane Corsos are known for being confident, loyal, and protective, with a calm, steady demeanor in a well-socialized dog. Many remain devoted, watchful companions well into their senior years.`,
    seniorPatterns: `Given their large size, joint health — particularly hips and elbows — is a commonly discussed topic among Cane Corso owners as the breed ages. Heart health is also a frequent topic of conversation with vets for large breeds generally. Owners often find that weight management makes a real difference in comfort and mobility as these dogs get older.`
  },
  'doberman pinscher': {
    displayName: 'Doberman Pinscher',
    typicalWeight: '60–100 lb',
    history: `Doberman Pinschers were developed in Germany in the late 1800s by a tax collector who wanted a loyal, protective companion for his rounds. The breed was quickly recognized for intelligence and versatility in guard and police work.`,
    temperament: `Dobermans are known for being loyal, alert, and highly trainable, often forming close bonds with their families. Many remain watchful and devoted companions well into their senior years.`,
    seniorPatterns: `Heart health is one of the most widely discussed topics for Dobermans as they age, and it's an area many vets pay particular attention to during senior wellness visits for this breed specifically. Staying consistent with regular vet checkups alongside your own tracking is commonly recommended.`
  },
  'boxer': {
    displayName: 'Boxer',
    typicalWeight: '50–80 lb',
    history: `Boxers were developed in Germany in the late 1800s, descended from bull-baiting breeds and later refined into versatile working dogs used for guarding, police work, and companionship.`,
    temperament: `Boxers are known for being playful, energetic, and loyal, often maintaining a puppyish enthusiasm well into adulthood. Many stay engaged and affectionate through their senior years, even as activity levels naturally decrease.`,
    seniorPatterns: `Heart health is a commonly discussed topic among Boxer owners as the breed ages, and it's an area many vets pay particular attention to during senior wellness visits. Joint health and gradual changes in exercise tolerance are also frequently discussed. Regular vet checkups alongside your own tracking can help catch changes early.`
  },
  'bernese mountain dog': {
    displayName: 'Bernese Mountain Dog',
    typicalWeight: '70–115 lb',
    history: `Bernese Mountain Dogs originated in the Swiss Alps, bred by farmers as versatile working dogs for driving cattle, pulling carts, and guarding property. Their name comes from the canton of Bern.`,
    temperament: `Berners are known for being gentle, calm, and deeply affectionate with their families. Many remain sweet, easygoing companions well into their senior years, often preferring to be near their people over anything else.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Berner owners given the breed's size, and many owners find that this breed tends to show its age a bit earlier than some other large breeds. Regular, gentle exercise and weight management are commonly discussed with vets as ways to support comfort in the senior years.`
  },
  'great dane': {
    displayName: 'Great Dane',
    typicalWeight: '110–175 lb',
    history: `Great Danes descend from large mastiff-type dogs used in Germany for boar hunting and estate guarding, later refined into the gentle giant companion breed known today.`,
    temperament: `Great Danes are known for being gentle, affectionate, and surprisingly laid-back for their size — often described as "gentle giants." Many remain calm, dignified companions well into their senior years.`,
    seniorPatterns: `Given their exceptionally large size, joint health and heart health are both commonly discussed topics among Great Dane owners as the breed ages. Owners often work closely with their vets on weight management and mobility support, since extra strain on joints and the heart can be more noticeable in giant breeds.`
  },
  'siberian husky': {
    displayName: 'Siberian Husky',
    typicalWeight: '35–60 lb',
    history: `Siberian Huskies were developed by the Chukchi people of northeastern Siberia as endurance sled dogs, bred to pull light loads over long distances in extreme cold. They were brought to Alaska in the early 1900s and gained wider popularity through sled-racing.`,
    temperament: `Huskies are known for being energetic, independent, and highly social with people and other dogs. Many stay spirited and vocal well into their senior years, even as their exercise needs gradually decrease.`,
    seniorPatterns: `Eye health is a commonly discussed topic for Huskies as they age, and joint health is a frequent topic for active breeds generally. Owners often find that adjusting (rather than eliminating) exercise routines helps senior Huskies stay comfortable and engaged.`
  },
  'vizsla': {
    displayName: 'Vizsla',
    typicalWeight: '45–65 lb',
    history: `Vizslas originated in Hungary, developed by nobility as versatile hunting dogs skilled at pointing and retrieving. Their short, sleek coat and lean build reflect their history as an all-purpose field dog.`,
    temperament: `Vizslas are known for being affectionate, energetic, and closely bonded to their people — often nicknamed "velcro dogs" for how closely they like to stay by their owner's side. Many remain eager and attentive well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Vizsla owners as the breed ages, given their athletic build earlier in life. Skin health is also sometimes discussed for the breed generally. Owners often find that keeping a senior Vizsla mentally and physically engaged (at a gentler pace) supports overall wellbeing.`
  },
  'mastiff': {
    displayName: 'Mastiff',
    typicalWeight: '120–230 lb',
    history: `Mastiffs are among the oldest recognized dog breeds, with ancestry tracing back thousands of years to large guardian dogs used across the ancient world. The modern English Mastiff was refined in Britain and valued for its size and protective nature.`,
    temperament: `Mastiffs are known for being calm, dignified, and gentle with their families despite their imposing size. Many remain low-key, affectionate companions well into their senior years.`,
    seniorPatterns: `Given their exceptionally large size, joint health and heart health are both commonly discussed topics among Mastiff owners as the breed ages. Owners often work closely with their vets on weight management specifically, since even modest excess weight adds significant strain to joints in giant breeds.`
  },
  'rhodesian ridgeback': {
    displayName: 'Rhodesian Ridgeback',
    typicalWeight: '70–85 lb',
    history: `Rhodesian Ridgebacks were developed in southern Africa, bred by combining European breeds with a native ridged-back hunting dog kept by the Khoikhoi people. They were historically used to track large game, including lions, though not to attack them.`,
    temperament: `Ridgebacks are known for being loyal, independent, and dignified, often forming a close bond with one family. Many stay alert and steady well into their senior years.`,
    seniorPatterns: `Joint health is a commonly discussed topic among Ridgeback owners as the breed ages, given their athletic build earlier in life. Owners often notice gradual changes in activity tolerance before other signs appear. Regular vet checkups alongside your own tracking are a good way to stay ahead of changes.`
  },
  'newfoundland': {
    displayName: 'Newfoundland',
    typicalWeight: '100–150 lb',
    history: `Newfoundlands originated on the island of Newfoundland, Canada, developed as working dogs for fishermen — known for strength, swimming ability, and a talent for water rescue.`,
    temperament: `Newfoundlands are known for being gentle, patient, and famously good-natured, often called "gentle giants." Many remain calm, sweet companions well into their senior years.`,
    seniorPatterns: `Given their exceptionally large size, joint health and heart health are both commonly discussed topics among Newfoundland owners as the breed ages. Owners often work with their vets on weight management and moderate, joint-friendly exercise (like swimming) to support comfort in the senior years.`
  },

  // ===== Smaller breeds =====
  'french bulldog': {
    displayName: 'French Bulldog',
    typicalWeight: '16–28 lb',
    history: `French Bulldogs descend from small English Bulldogs brought to France by lace workers in the 1800s, where they were crossed with local breeds and refined into the compact companion dog known today. They were recognized by the AKC in 1898.`,
    temperament: `Frenchies are known for being affectionate, easygoing, and adaptable — traits that have made them especially popular with owners in cities and smaller living spaces. Many remain playful and people-focused well into their senior years.`,
    seniorPatterns: `Breathing and airway comfort is one of the most commonly discussed topics for French Bulldogs throughout life, given the breed's short-nosed (brachycephalic) build, and it's especially worth watching in warm weather or during activity. Spinal and joint health are also frequently discussed topics for the breed. Weight management can meaningfully affect comfort and breathing ease.`
  },
  'dachshund': {
    displayName: 'Dachshund',
    typicalWeight: '11–32 lb',
    history: `Dachshunds were developed in Germany, originally bred to hunt badgers — their name literally translates to "badger dog." Their long, low build was specifically suited to tunneling into burrows after game.`,
    temperament: `Dachshunds are known for being spirited, loyal, and sometimes stubborn — traits that likely served them well as independent hunters. Many stay alert and vocal well into their senior years.`,
    seniorPatterns: `Back and spinal health is one of the most commonly discussed topics among Dachshund owners at any age, given the breed's elongated body shape, and it often becomes a bigger focus as dogs age. Owners commonly watch for reluctance to jump, changes in gait, or sensitivity around the back. Weight management is also frequently discussed, since extra weight adds strain to the spine.`
  },
  'cavalier king charles spaniel': {
    displayName: 'Cavalier King Charles Spaniel',
    typicalWeight: '13–18 lb',
    history: `Cavalier King Charles Spaniels descend from small companion spaniels favored in English royal courts for centuries, later refined in the early 1900s into the breed recognized today, named after King Charles II.`,
    temperament: `Cavaliers are known for being gentle, affectionate, and eager to be close to their people — bred specifically as companions. Many remain sweet-natured and devoted well into their senior years.`,
    seniorPatterns: `Heart health is one of the most widely discussed topics for Cavaliers as they age, and it's an area many vets pay close attention to during regular senior wellness visits for this breed specifically. Staying consistent with vet checkups alongside your own tracking is commonly recommended for Cavalier owners.`
  },
  'yorkshire terrier': {
    displayName: 'Yorkshire Terrier',
    typicalWeight: '4–7 lb',
    history: `Yorkshire Terriers originated in 19th-century England, bred by working-class weavers to catch rats in textile mills. Their small size and tenacity made them effective at the job before they became popular companion dogs.`,
    temperament: `Yorkies are known for being confident, energetic, and affectionate with their families, often carrying a "big dog" attitude despite their small size. Many stay lively and attentive well into their senior years.`,
    seniorPatterns: `Like many small breeds, dental health is a commonly discussed topic for Yorkies throughout their lives. Owners also frequently discuss joint and knee health as dogs age. Because of their small size, subtle changes in energy or mobility are often easier for owners to notice early.`
  },
  'pembroke welsh corgi': {
    displayName: 'Pembroke Welsh Corgi',
    typicalWeight: '22–30 lb',
    history: `Pembroke Welsh Corgis originated in Wales, bred as herding dogs for cattle despite their small size — their low build allowed them to nip at heels while avoiding kicks. They later became widely known as a favorite breed of Queen Elizabeth II.`,
    temperament: `Corgis are known for being smart, energetic, and confident, with a strong herding instinct that often shows up in play. Many stay lively and food-motivated well into their senior years.`,
    seniorPatterns: `Back and spinal health is a commonly discussed topic for Corgis given their long body and short legs, similar to other elongated breeds. Weight management is especially frequently discussed for this breed, since extra weight adds real strain to both the spine and joints.`
  },
  'miniature schnauzer': {
    displayName: 'Miniature Schnauzer',
    typicalWeight: '11–20 lb',
    history: `Miniature Schnauzers were developed in Germany by breeding down the Standard Schnauzer, originally used as farm dogs skilled at ratting and general guarding duties.`,
    temperament: `Miniature Schnauzers are known for being alert, friendly, and spirited, often making excellent watchdogs despite their small size. Many stay energetic and engaged well into their senior years.`,
    seniorPatterns: `Dental health and eye health are commonly discussed topics for Miniature Schnauzers as they age. Weight management is also frequently discussed, since the breed can be prone to gaining weight if activity decreases. Regular vet checkups alongside your own tracking are commonly recommended.`
  },
  'pomeranian': {
    displayName: 'Pomeranian',
    typicalWeight: '3–7 lb',
    history: `Pomeranians descend from larger sled-dog-type breeds in the Pomerania region of Central Europe, gradually bred down in size over generations into the small companion dog known today. They became especially popular after Queen Victoria took an interest in the breed in the late 1800s.`,
    temperament: `Pomeranians are known for being lively, alert, and confident, often described as having a big personality in a small package. Many stay spirited and vocal well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Pomeranians throughout life, as it is for many small breeds. Tracheal and joint health are also frequently discussed topics as the breed ages. Because Pomeranians are small, owners often find it easier to spot subtle day-to-day changes than with larger dogs.`
  },
  'shih tzu': {
    displayName: 'Shih Tzu',
    typicalWeight: '9–16 lb',
    history: `Shih Tzus originated in China, believed to be bred from Tibetan breeds and favored as companion dogs in Chinese royal courts for centuries before becoming popular worldwide in the 20th century.`,
    temperament: `Shih Tzus are known for being affectionate, outgoing, and people-oriented — bred specifically to be companions rather than working dogs. Many stay sweet-natured and attentive well into their senior years.`,
    seniorPatterns: `Eye health is a commonly discussed topic for Shih Tzus given their prominent eye shape, and dental health is a frequent topic for small breeds generally. Breathing comfort is also sometimes discussed given the breed's shorter muzzle. Regular grooming and vet checkups alongside your own tracking are commonly recommended.`
  },
  'boston terrier': {
    displayName: 'Boston Terrier',
    typicalWeight: '10–25 lb',
    history: `Boston Terriers were developed in the United States in the late 1800s, one of the first breeds developed specifically in America. They're sometimes called "the American Gentleman" for their tuxedo-like coat pattern.`,
    temperament: `Boston Terriers are known for being friendly, lively, and adaptable, often described as having a comedic personality. Many stay playful and affectionate well into their senior years.`,
    seniorPatterns: `Breathing comfort is a commonly discussed topic for Boston Terriers given their short-nosed (brachycephalic) build, and eye health is also a frequent topic for the breed. Weight management can meaningfully support breathing comfort as the breed ages.`
  },
  'chihuahua': {
    displayName: 'Chihuahua',
    typicalWeight: '2–6 lb',
    history: `Chihuahuas take their name from the Mexican state of Chihuahua, where the breed was discovered by American travelers in the 1850s. Their exact ancestral origins are debated, but they're widely recognized as one of the oldest breeds in the Americas.`,
    temperament: `Chihuahuas are known for big personalities in small bodies — often alert, confident, and deeply bonded to their owners. Many remain feisty and engaged throughout their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Chihuahuas throughout life, given their small jaw size, and often becomes more prominent with age. Knee (patella) health is another frequently discussed topic for small breeds generally. Because Chihuahuas are small, owners sometimes find it easier to notice subtle changes in movement or appetite than with larger dogs.`
  },
  'havanese': {
    displayName: 'Havanese',
    typicalWeight: '7–13 lb',
    history: `Havanese dogs originated in Cuba, descended from small Mediterranean companion breeds brought over by Spanish settlers, and are the only dog breed native to the island.`,
    temperament: `Havanese are known for being friendly, playful, and highly people-oriented, often thriving on close companionship. Many remain sociable and attentive well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Havanese throughout life, as it is for many small breeds. Eye health and joint health are also sometimes discussed as the breed ages. Owners often find this breed adapts well to a gentler activity pace as it gets older.`
  },
  'maltese': {
    displayName: 'Maltese',
    typicalWeight: '4–7 lb',
    history: `Maltese dogs are among the oldest toy breeds, with a history tracing back thousands of years around the Mediterranean, prized as companion dogs by ancient nobility.`,
    temperament: `Maltese are known for being gentle, affectionate, and lively, often forming close bonds with their people. Many stay sweet-natured and alert well into their senior years.`,
    seniorPatterns: `Dental health is one of the most commonly discussed topics for Maltese throughout life, given their small jaw size. Eye health is also a frequently discussed topic for the breed. Regular vet checkups alongside your own tracking are commonly recommended.`
  },
  'pug': {
    displayName: 'Pug',
    typicalWeight: '14–18 lb',
    history: `Pugs originated in China, bred as companion dogs for Chinese royalty, and were later brought to Europe by Dutch traders in the 1500s, where they became popular in royal courts.`,
    temperament: `Pugs are known for being affectionate, playful, and easygoing, often described as having a charming, sociable personality. Many stay warm and people-focused well into their senior years.`,
    seniorPatterns: `Breathing and airway comfort is one of the most commonly discussed topics for Pugs throughout life, given the breed's short-nosed (brachycephalic) build. Weight management is especially frequently discussed for this breed, since extra weight can meaningfully affect breathing comfort and joint health. Skin-fold care is also a common topic.`
  },
  'papillon': {
    displayName: 'Papillon',
    typicalWeight: '5–10 lb',
    history: `Papillons take their name from the French word for "butterfly," referencing their distinctive fringed ears. The breed has a long history as a companion dog in European royal courts, dating back centuries.`,
    temperament: `Papillons are known for being alert, friendly, and surprisingly athletic for their size. Many remain lively and mentally sharp well into their senior years.`,
    seniorPatterns: `Dental health is a commonly discussed topic for Papillons throughout life, as it is for many small breeds. Knee (patella) health is also a frequently discussed topic. Because Papillons are small and often quite active, owners sometimes find it easier to notice subtle changes early.`
  },
  'bichon frise': {
    displayName: 'Bichon Frise',
    typicalWeight: '12–18 lb',
    history: `Bichon Frises descend from small Mediterranean water dogs, with a history tracing through Spain, France, and Italy as beloved companion dogs in European courts for centuries.`,
    temperament: `Bichons are known for being cheerful, affectionate, and playful, often described as having a naturally happy disposition. Many stay sociable and lively well into their senior years.`,
    seniorPatterns: `Skin and coat health are commonly discussed topics for Bichons throughout life, along with dental health, as is common for many small breeds. Eye health is also sometimes discussed as the breed ages. Regular grooming and vet checkups alongside your own tracking are commonly recommended.`
  },

  'mixed breed': {
    displayName: 'Mixed Breed',
    typicalWeight: 'Varies widely',
    history: `Mixed-breed dogs draw from two or more breed lineages, which often gives them a broader, more varied genetic background than purebred dogs. This diversity is sometimes associated with fewer breed-specific hereditary conditions, though every dog's health history is individual.`,
    temperament: `Temperament in mixed-breed dogs varies widely and depends on their specific ancestry, individual personality, and upbringing — there's no single generalization that applies broadly.`,
    seniorPatterns: `Because mixed-breed dogs don't share one specific health profile, tracking your own dog's individual patterns over time — rather than relying on breed generalizations — is especially valuable. That's exactly what consistent weekly check-ins are for.`
  }
};

const GENERIC_BREED_GUIDE = {
  displayName: 'Senior Dogs',
  typicalWeight: 'Varies by breed',
  history: `Dogs have been companions to humans for thousands of years, with countless breeds and mixes developed for different purposes — from herding and hunting to companionship. Every dog's individual history and genetics shape how they age.`,
  temperament: `Every dog's temperament is shaped by a mix of genetics, upbringing, and individual personality — general breed traits are a starting point, not a guarantee.`,
  seniorPatterns: `As dogs enter their senior years, changes in mobility, energy, appetite, and alertness are common across breeds, though the timing and severity vary widely from dog to dog. Regular tracking is one of the most reliable ways to notice real changes early, rather than relying on memory or breed-level assumptions.`
};

function getBreedGuide(breedName) {
  if (!breedName) return GENERIC_BREED_GUIDE;
  const normalized = breedName.trim().toLowerCase();
  return BREED_GUIDES[normalized] || GENERIC_BREED_GUIDE;
}

// ============================================
// SENIOR-BY-BREED-SIZE + WEIGHT-RANGE HELPERS
// Nothing here is stored — both the size tier and the senior flag are
// derived live from a breed's existing typicalWeight string, same pattern
// as the live week-number/streak calculations elsewhere in this file.
// Real vet-consensus senior-age ranges (larger/giant breeds age faster):
//   Giant  (avg >115 lb): senior at 5
//   Large  (avg 50-115 lb): senior at 6
//   Medium (avg 25-50 lb): senior at 8
//   Small/Toy (avg <25 lb): senior at 10
// Giant cutoff is 115, not the naive 90 lb midpoint of the large/giant gap —
// Rottweiler/Cane Corso/Bernese Mountain Dog average 92.5-107.5 lb but are
// standard-classified as large breed, not giant, so 90 misclassified them.
// 115 keeps them Large while still catching genuinely giant breeds (Great
// Dane, Mastiff, Newfoundland all average 125+ lb).
// ============================================

// Parses a typicalWeight string like "55–80 lb" into {min, max}. Returns
// null for the two non-numeric cases ('Varies widely' for mixed breed,
// 'Varies by breed' for the generic fallback) — callers use that null to
// skip tier-specific behavior gracefully rather than showing a broken range.
function parseWeightRange(typicalWeight) {
  if (!typicalWeight) return null;
  const match = typicalWeight.match(/(\d+)\s*[–-]\s*(\d+)/);
  if (!match) return null;
  const min = parseInt(match[1], 10);
  const max = parseInt(match[2], 10);
  if (isNaN(min) || isNaN(max)) return null;
  return { min, max };
}

const SENIOR_AGE_BY_TIER = { giant: 5, large: 6, medium: 8, small: 10 };

// Mixed breed and the generic fallback have no real weight data, so they
// default to 'medium' — the safest middle-ground guess (matches the
// Medium threshold of 8, per the instructions this was built from).
function getBreedSizeTier(breedName) {
  const guide = getBreedGuide(breedName);
  const range = parseWeightRange(guide.typicalWeight);
  if (!range) return 'medium';
  const avg = (range.min + range.max) / 2;
  if (avg > 115) return 'giant';
  if (avg >= 50) return 'large';
  if (avg >= 25) return 'medium';
  return 'small';
}

function isSeniorForBreed(age, breedName) {
  if (age == null || isNaN(age)) return false;
  const tier = getBreedSizeTier(breedName);
  return age >= SENIOR_AGE_BY_TIER[tier];
}

// Forward-looking copy shown on the breed guide for dogs NOT YET flagged
// senior — one per size tier (not per breed), same non-diagnostic register
// as each breed's own seniorPatterns copy above. Deliberately doesn't state
// the exact senior-age threshold, so this copy doesn't need updating if
// SENIOR_AGE_BY_TIER is ever retuned.
const NOT_YET_SENIOR_COPY = {
  giant: `Giant breeds are known for reaching their senior years earlier than smaller dogs, so it's worth starting to pay attention to joint comfort, mobility, and energy well before any real changes show up. Weight management and gentle, consistent exercise earlier in life are commonly discussed as ways to support comfort as giant breeds get older. Tracking your dog's own patterns now — while they're still young for their size — builds a clear picture that makes any future shift much easier to spot.`,
  large: `Large breeds tend to show the effects of aging a bit sooner than medium or small dogs, so it's worth keeping an eye on mobility, stamina, and joint comfort as the years pass, even well ahead of typical senior age. Consistent exercise and healthy weight management earlier in life are commonly discussed among large-breed owners as ways to support long-term comfort. Regular tracking now is the best way to know what's actually normal for your dog, so a real change stands out later.`,
  medium: `Medium-sized breeds generally age a bit more gradually than larger dogs, but it's still worth watching for early shifts in mobility, energy, and appetite as the years go by. Staying consistent with exercise and a healthy weight through adulthood is commonly discussed as good preparation for a smoother transition into the senior years. Tracking your dog's patterns now, well before any real change appears, makes it far easier to notice one later.`,
  small: `Small and toy breeds often stay playful and energetic well past the age that would be considered senior for a larger dog, and they typically reach that stage later too. It's still worth keeping an eye on dental health, joint comfort, and activity level as the years add up, since these are commonly discussed topics for small breeds at any age. Because small dogs are easier to observe closely day to day, owners often find it simple to notice subtle changes early — tracking now builds the baseline that makes that possible.`
};

function getNotYetSeniorCopy(breedName) {
  return NOT_YET_SENIOR_COPY[getBreedSizeTier(breedName)];
}

// Non-diagnostic weight-vs-breed comparison — "within/above/below," never a
// health judgment. Returns null when there's no weight yet, or when the
// breed has no real numeric range to compare against (mixed breed / generic).
function compareWeightToBreedRange(weightLbs, guide) {
  if (weightLbs == null) return null;
  const range = parseWeightRange(guide.typicalWeight);
  if (!range) return null;
  if (weightLbs < range.min) return `below the typical range for ${guide.displayName}s (${guide.typicalWeight})`;
  if (weightLbs > range.max) return `above the typical range for ${guide.displayName}s (${guide.typicalWeight})`;
  return `within the typical range for ${guide.displayName}s (${guide.typicalWeight})`;
}

app.get('/breed-guide/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;

    const { data: dog, error: dogError } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (dogError || !dog) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not Found</title></head>
        <body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 20px; text-align: center;">
          <h2>❌ Dog Not Found</h2>
          <p>We couldn't find this profile. Please check your link and try again.</p>
        </body>
        </html>
      `);
    }

    // Same week-number calculation used everywhere else — no separate
    // "unlocked" flag stored anywhere, computed live.
    const created = new Date(dog.created_at);
    const now = new Date();
    const currentWeek = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);

    if (currentWeek < 2) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${dog.dog_name}'s Breed Guide</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 20px; text-align: center; background: #f5f5f5; }
            .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          </style>
        </head>
        <body>
          <div class="card">
            <p style="font-size: 48px; margin: 0 0 20px 0;"><i data-lucide="lock"></i></p>
            <h2 style="margin: 0 0 10px 0;">Not unlocked yet</h2>
            <p style="color: #666;">${dog.dog_name}'s breed guide unlocks after your Week 2 check-in. Keep logging!</p>
            <a href="/dashboard/${dog_id}" style="display: inline-block; margin-top: 20px; background: #007AFF; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none;">Back to Dashboard</a>
          </div>
          <script src="https://unpkg.com/lucide@1.33.0"></script>
          <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
        </body>
        </html>
      `);
    }

    const guide = getBreedGuide(dog.breed);

    // Show the dog's own current score neutrally — deliberately NOT compared
    // to other dogs, breed averages, or percentiles (see note at top of section).
    // No .limit(1) here (unlike before) — weight isn't recorded every week,
    // so the full history is fetched to find the latest entry that has one.
    const { data: latestCheckins } = await supabase
      .from('mobility_checkins')
      .select('mobility_score, weight_lbs')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false });
    const currentMobility = latestCheckins?.[0]?.mobility_score ?? dog.baseline_mobility_score;

    // Senior-by-breed-size flag — live, nothing stored (see helpers above getBreedGuide).
    const isSenior = isSeniorForBreed(dog.age, dog.breed);
    const seniorSectionHeading = isSenior ? 'Senior Health Patterns' : 'Looking Ahead';
    const seniorSectionCopy = isSenior ? guide.seniorPatterns : getNotYetSeniorCopy(dog.breed);

    // Most recent weight — a check-in weight if one exists yet, else the
    // baseline weight from signup. Compared non-diagnostically against the
    // breed's typical range; null (and hidden entirely) for mixed breed /
    // the generic fallback, which have no real range to compare against.
    const latestWeightCheckin = latestCheckins?.find(c => c.weight_lbs != null);
    const currentWeight = latestWeightCheckin?.weight_lbs ?? dog.weight_lbs ?? null;
    const weightComparisonText = compareWeightToBreedRange(currentWeight, guide);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${dog.dog_name}'s ${guide.displayName} Guide</title>
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 650px; margin: 40px auto; padding: 20px; background: #f5f5f5; color: #333; line-height: 1.6; }
          .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .site-brand { font-size: 13px; font-weight: 700; letter-spacing: 0.5px; color: #A89968; text-transform: uppercase; margin: 0 0 20px 0; }
          .dog-photo { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; margin: 0 0 16px 0; display: block; }
          .dog-photo-placeholder { width: 80px; height: 80px; border-radius: 50%; background: #FFF8E7; display: flex; align-items: center; justify-content: center; font-size: 36px; margin: 0 0 16px 0; }
          h1 { font-size: 24px; margin: 0 0 4px 0; }
          .subtitle { color: #999; font-size: 14px; margin: 0 0 30px 0; }
          h2 { font-size: 16px; color: #A89968; text-transform: uppercase; letter-spacing: 0.5px; margin: 30px 0 10px 0; }
          .dog-snapshot { background: #FFF8E7; border-radius: 8px; padding: 16px 20px; margin: 30px 0; }
          .disclaimer { background: #FAFAFA; border: 1px solid #EEE; border-radius: 8px; padding: 20px; margin-top: 30px; font-size: 13px; color: #777; line-height: 1.6; }
          .disclaimer strong { color: #555; }
          .disclaimer a { color: #A89968; }
          .back-link { display: inline-block; margin-top: 30px; color: #007AFF; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <p class="site-brand">Companion Commons</p>

          ${dog.photo_url
            ? `<img src="${dog.photo_url}" alt="${dog.dog_name}" class="dog-photo" />`
            : `<div class="dog-photo-placeholder"><i data-lucide="paw-print"></i></div>`
          }

          <p style="font-size: 32px; margin: 0 0 10px 0;"><i data-lucide="book-open"></i></p>
          <h1>${guide.displayName}: A Health Journey Guide</h1>
          <p class="subtitle">Unlocked for ${dog.dog_name} — Week 2 milestone${guide.typicalWeight ? ` &nbsp;•&nbsp; Typical weight: ${guide.typicalWeight}` : ''}</p>

          <h2>History</h2>
          <p>${guide.history}</p>

          <h2>Temperament</h2>
          <p>${guide.temperament}</p>

          <h2>${seniorSectionHeading}</h2>
          <p>${seniorSectionCopy}</p>

          <div class="dog-snapshot">
            <strong>${dog.dog_name}'s current mobility:</strong> ${currentMobility}/8
            <p style="margin: 8px 0 0 0; font-size: 13px; color: #888;">This is just ${dog.dog_name}'s own number — not a comparison to other dogs. Keep logging to build a clearer picture over time.</p>
          </div>

          ${weightComparisonText ? `
          <div class="dog-snapshot" style="margin-top: 12px;">
            <strong>${dog.dog_name}'s current weight:</strong> ${currentWeight} lb
            <p style="margin: 8px 0 0 0; font-size: 13px; color: #888;">This is ${weightComparisonText}.</p>
          </div>
          ` : ''}

          <div class="disclaimer">
            <p style="margin: 0;">Companion Commons is not a veterinary service and does not diagnose, treat, prescribe, or provide veterinary advice. Always consult a licensed veterinarian about your companion's health and care. Think this may be an emergency? Contact your veterinarian or the nearest emergency veterinary hospital immediately.</p>
            <p style="margin: 12px 0 0 0;">See our <a href="/terms.html">Terms of Service</a> and <a href="/privacy.html">Privacy Policy</a> for more.</p>
          </div>

          <a href="/dashboard/${dog_id}" class="back-link">← Back to Dashboard</a>
        </div>
        <script src="https://unpkg.com/lucide@1.33.0"></script>
        <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Error loading breed guide:', error);
    res.status(500).send('Error loading breed guide');
  }
});

// ============================================
// STEP: MID-WEEK NOTES (Aug 19)
// Deliberately NOT gated by the 7-day check-in cycle — owners can add an
// observation any time. This is what gives people a real reason to open
// the dashboard between formal weekly updates.
// ============================================
app.post('/api/notes/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;
    const { note_text } = req.body;

    if (!note_text || !note_text.trim()) {
      return res.status(400).json({ error: 'Note text is required' });
    }

    const { error } = await supabase
      .from('dog_notes')
      .insert({ dog_id, note_text: note_text.trim() });

    if (error) throw error;

    // Export to Google Sheets (Notes tab) — real-time, same as signups and
    // check-ins. Needs the dog's name, which the notes table itself doesn't
    // store, so fetch it here.
    const { data: dogForNote } = await supabase
      .from('senior_dogs')
      .select('dog_name')
      .eq('id', dog_id)
      .single();

    await appendRowToSheet('Notes', [
      new Date().toISOString(),
      dog_id,
      dogForNote?.dog_name || '',
      note_text.trim()
    ]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving note:', error);
    res.status(500).json({ error: 'Failed to save note' });
  }
});

app.get('/dashboard/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;
    console.log(`📊 Dashboard request for dog: ${dog_id}`);

    // Fetch dog info
    const { data: dog, error: dogError } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (dogError || !dog) {
      console.error('Dog not found:', dogError);
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Dog Not Found</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
            .card { background: white; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            h2 { color: #d32f2f; margin-bottom: 10px; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>❌ Dog Not Found</h2>
            <p>We couldn't find this dog's profile (ID: ${dog_id}). Please check your link and try again.</p>
          </div>
        </body>
        </html>
      `);
    }

    // Fetch all check-ins for this dog, ordered by date
    const { data: checkins, error: checkinsError } = await supabase
      .from('mobility_checkins')
      .select('*')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: true });

    if (checkinsError) {
      console.error('Error fetching checkins:', checkinsError);
      throw checkinsError;
    }

    // STEP 27D: Fetch any active health alerts (last 14 days) for the banner.
    // Most recent first — if multiple metrics triggered alerts, show the newest.
    const fourteenDaysAgoForDisplay = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: activeAlerts } = await supabase
      .from('health_alerts')
      .select('*')
      .eq('dog_id', dog_id)
      .gte('created_at', fourteenDaysAgoForDisplay)
      .order('created_at', { ascending: false })
      .limit(1);

    const activeAlert = activeAlerts?.[0] || null;

    // STEP: Fetch mid-week notes, most recent first
    const { data: dogNotes } = await supabase
      .from('dog_notes')
      .select('*')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false });

    // Note (Aug 19): dashboard no longer shows a separate placeholder page for
    // zero check-ins. It always renders the real dashboard, using the dog's
    // baseline score as the starting data point until a real check-in exists.
    // This fixes a real UX bug: the old placeholder's only CTA was "Record
    // First Check-In", which new users clicked thinking it was how you access
    // the dashboard at all — conflating viewing the dashboard with submitting
    // a weekly update.

    // Calculate metrics — falls back to baseline score when no check-in
    // exists yet, so the dashboard always has a real starting data point.
    const currentScore = checkins.length > 0
      ? checkins[checkins.length - 1].mobility_score
      : dog.baseline_mobility_score;
    // previous falls back to baseline only when exactly 1 real check-in exists
    // (comparing it against baseline is meaningful) — with 0 check-ins there's
    // no real prior data point at all, so this stays null rather than
    // defaulting to the same baseline value as currentScore, which used to
    // make describeTrendForGlance see two identical numbers and falsely
    // report "held steady" during the baseline-only period.
    const previousScore = checkins.length > 1
      ? checkins[checkins.length - 2].mobility_score
      : checkins.length === 1 ? dog.baseline_mobility_score : null;

    const scoreDiff = currentScore - previousScore;
    const trend = scoreDiff > 0 ? 'up' : scoreDiff < 0 ? 'down' : 'flat';
    const trendEmoji = trend === 'up' ? '📈' : trend === 'down' ? '📉' : '➡️';
    const trendText = checkins.length === 0
      ? 'Baseline'
      : (trend === 'up' ? 'Improving' : trend === 'down' ? 'Declining' : 'Stable');
    const trendColor = trend === 'up' ? '#4CAF50' : trend === 'down' ? '#FF6B6B' : '#FFC107';

    // STEP: Real "This Week at a Glance" data — this section used to be
    // hardcoded static text ("has been more difficult for two weeks") shown
    // identically on every dog's dashboard regardless of their real data.
    // That's a real accuracy problem worth fixing properly, not just
    // cosmetically — these lines now reflect actual score changes.
    const currentEnergyScore = checkins.length > 0
      ? checkins[checkins.length - 1].energy_score
      : dog.baseline_energy_score;
    const previousEnergyScore = checkins.length > 1
      ? checkins[checkins.length - 2].energy_score
      : checkins.length === 1 ? dog.baseline_energy_score : null;
    const currentAppetiteScore = checkins.length > 0
      ? checkins[checkins.length - 1].appetite_score
      : dog.baseline_appetite_score;
    const previousAppetiteScore = checkins.length > 1
      ? checkins[checkins.length - 2].appetite_score
      : checkins.length === 1 ? dog.baseline_appetite_score : null;

    // Weight isn't recorded every week (only on the every-4th-week check-in,
    // same trigger as cognitive/behavior), so unlike the 3 scores above this
    // filters down to just the check-ins that actually have a weight first.
    const weightCheckins = checkins.filter(c => c.weight_lbs != null);
    const currentWeightValue = weightCheckins.length > 0
      ? weightCheckins[weightCheckins.length - 1].weight_lbs
      : dog.weight_lbs;
    const previousWeightValue = weightCheckins.length > 1
      ? weightCheckins[weightCheckins.length - 2].weight_lbs
      : weightCheckins.length === 1 ? dog.weight_lbs : null;

    function describeTrendForGlance(current, previous) {
      // previous is only ever null now during the baseline-only period (see
      // the null fallback above) — current is never null (baseline scores
      // are required at signup), so this branch is effectively "no real
      // check-in yet," not a generic missing-data case.
      if (current == null || previous == null) return "Baseline recorded — first weekly update will show your dog's trend";
      const diff = current - previous;
      if (diff > 0) return `improved (+${diff})`;
      if (diff < 0) return `declined (${diff})`;
      return 'held steady';
    }

    // Separate from describeTrendForGlance above on purpose: weight going up
    // or down isn't inherently "improved" or "declined" the way a higher
    // mobility/energy/appetite score is, so this uses neutral up/down/steady
    // language instead — no health judgment either way.
    function describeWeightTrendForGlance(current, previous) {
      if (current == null || previous == null) return "Baseline recorded — first weekly update will show your dog's trend";
      const diff = current - previous;
      if (diff > 0) return `up ${diff} lb since last recorded`;
      if (diff < 0) return `down ${Math.abs(diff)} lb since last recorded`;
      return 'steady since last recorded';
    }

    // Calculate streak (consecutive weeks with check-ins) — 0 when there
    // are no check-ins yet, guarded before touching the array at all so it
    // can't crash on an empty list.
    let streak = 0;
    if (checkins.length > 0) {
      const sortedByWeek = [...checkins].sort((a, b) => b.week_number - a.week_number);
      // Same defensive floor as calculateCurrentStreak() — a stray week_number
      // of 0 or less shouldn't make this loop skip entirely.
      const maxWeek = Math.max(1, sortedByWeek[0].week_number);
      for (let i = maxWeek; i >= 1; i--) {
        const hasWeek = checkins.some(c => c.week_number === i);
        if (hasWeek) {
          streak++;
        } else {
          break;
        }
      }
    }

    // Get peer average (latest score per dog, then average)
    const { data: allLatestScores } = await supabase
      .from('mobility_checkins')
      .select('dog_id, mobility_score, created_at')
      .order('created_at', { ascending: false });

    const latestPerDog = {};
    if (allLatestScores) {
      for (const checkin of allLatestScores) {
        if (!latestPerDog[checkin.dog_id]) {
          latestPerDog[checkin.dog_id] = checkin.mobility_score;
        }
      }
    }

    const peerScores = Object.values(latestPerDog);
    const peerAverage = peerScores.length > 0
      ? (peerScores.reduce((a, b) => a + b, 0) / peerScores.length).toFixed(1)
      : 0;

    // Calculate rank (how many dogs have lower scores)
    const dogsWithLowerScores = peerScores.filter(s => s < currentScore).length;
    const rank = dogsWithLowerScores + 1;
    const totalDogs = peerScores.length;

    // Prepare chart data
    // Chart shows just the baseline point when there's no real check-in yet,
    // instead of an empty chart.
    const chartScores = checkins.length > 0
      ? checkins.map(c => c.mobility_score)
      : [dog.baseline_mobility_score];
    const chartEnergyScores = checkins.length > 0
      ? checkins.map(c => c.energy_score)
      : [dog.baseline_energy_score];
    const chartAppetiteScores = checkins.length > 0
      ? checkins.map(c => c.appetite_score)
      : [dog.baseline_appetite_score];
    const chartWeeks = checkins.length > 0
      ? checkins.map(c => `W${c.week_number}`)
      : ['Baseline'];

    // Latest scores for pre-filling the check-in modal sliders (STEP P1B: Smart
    // Defaults). Falls back to the dog's baseline score, not a hardcoded 4, so
    // a dog with no prior weekly check-in still gets a real starting point.
    const latestCheckinRow = checkins[checkins.length - 1];
    const latestMobilityScore = latestCheckinRow?.mobility_score ?? dog.baseline_mobility_score ?? 4;
    const latestEnergyScore = latestCheckinRow?.energy_score ?? dog.baseline_energy_score ?? 4;
    const latestAppetiteScore = latestCheckinRow?.appetite_score ?? dog.baseline_appetite_score ?? 4;
    const latestCognitiveScore = latestCheckinRow?.cognitive_score ?? dog.baseline_cognitive_score ?? 4;
    // Weight pre-fill uses the same weightCheckins list computed above (not
    // latestCheckinRow), since the most recent check-in overall often won't
    // be the one that actually recorded a weight.
    const latestWeightScore = weightCheckins.length > 0
      ? weightCheckins[weightCheckins.length - 1].weight_lbs
      : (dog.weight_lbs ?? '');

    // Senior-by-breed-size flag — live, nothing stored (see helpers defined
    // near getBreedGuide/BREED_GUIDES above).
    const isSenior = isSeniorForBreed(dog.age, dog.breed);

    // Calculate the actual current week (matches /api/checkin-senior's calculation)
    // so we know whether to show the every-4th-week cognitive/behavior slider.
    const dogCreatedAt = new Date(dog.created_at);
    const dashboardNow = new Date();
    const nextCheckinWeekNumber = Math.max(1, Math.floor((dashboardNow - dogCreatedAt) / (7 * 24 * 60 * 60 * 1000)) + 1);
    const showCognitiveThisWeek = nextCheckinWeekNumber % 4 === 0;

    // STEP: Real "update due" calculation, separate from nextCheckinWeekNumber
    // above (which is used for saving check-ins and the every-4th-week
    // cognitive question). This one drives what the dashboard actually shows
    // as due — baseline (signup) doesn't count as week 1; week 1 only
    // becomes due 7 full days after signup, matching the real weekly cadence.
    const daysSinceSignup = (dashboardNow - dogCreatedAt) / (24 * 60 * 60 * 1000);
    // Defensive floor: without this, a created_at that's marginally in the
    // future relative to server time (clock skew, a TZ-less timestamp
    // misparsed as local time — the same bug class as the original "Week
    // #0" fix) sends daysSinceSignup slightly negative, which floors to -1
    // instead of 0 — showing "Week -1 of 12" on a real owner's Journey
    // Summary and, since isInBaselinePeriod checks === 0, incorrectly
    // flipping a genuinely-in-baseline dog to "not in baseline" too.
    const weeksSinceSignup = Math.max(0, Math.floor(daysSinceSignup / 7)); // 0 during baseline period, 1 from day 7, etc.
    const mostRecentSubmittedWeek = checkins.length > 0
      ? Math.max(...checkins.map(c => c.week_number))
      : 0;
    const isInBaselinePeriod = weeksSinceSignup === 0;
    const daysUntilFirstUpdate = isInBaselinePeriod ? Math.max(1, 7 - Math.floor(daysSinceSignup)) : 0;
    const hasUpdateDue = !isInBaselinePeriod && weeksSinceSignup > mostRecentSubmittedWeek;
    const dueWeekNumber = weeksSinceSignup; // the week number that's actually due right now, if any

    // ============================================
    // JOURNEY SUMMARY — real data, built from what's already loaded above.
    // Purpose (per the button's own copy): help an owner prep for a
    // conversation with a vet, family member, or sitter. Reuses checkins,
    // dogNotes, activeAlert, and dog — no new queries needed.
    // ============================================
    function describeJourneyTrend(label, baseline, latest) {
      if (baseline == null && latest == null) {
        return `${label}: not enough data yet`;
      }
      if (baseline == null || latest == null || checkins.length === 0) {
        return `${label}: ${latest ?? baseline}/8 (baseline only — no check-ins yet)`;
      }
      const diff = latest - baseline;
      if (diff > 0) return `${label}: ${baseline}/8 → ${latest}/8 (up ${diff} since baseline)`;
      if (diff < 0) return `${label}: ${baseline}/8 → ${latest}/8 (down ${Math.abs(diff)} since baseline)`;
      return `${label}: ${baseline}/8 → ${latest}/8 (steady since baseline)`;
    }

    // Weight-specific variant of describeJourneyTrend — "lb" instead of "/8",
    // otherwise identical neutral up/down/steady phrasing (no "improved" /
    // "declined" — see describeWeightTrendForGlance above for why).
    function describeWeightJourneyTrend(baseline, latest) {
      if (baseline == null && latest == null) return 'Weight: not enough data yet';
      if (baseline == null || latest == null) return `Weight: ${latest ?? baseline} lb (baseline only — no check-in weight yet)`;
      const diff = latest - baseline;
      if (diff > 0) return `Weight: ${baseline} lb → ${latest} lb (up ${diff} lb since baseline)`;
      if (diff < 0) return `Weight: ${baseline} lb → ${latest} lb (down ${Math.abs(diff)} lb since baseline)`;
      return `Weight: ${baseline} lb → ${latest} lb (steady since baseline)`;
    }

    const latestCognitiveCheckin = [...checkins].reverse().find(c => c.cognitive_score != null);
    const journeyTrendLines = [
      describeJourneyTrend('Mobility', dog.baseline_mobility_score, checkins.length > 0 ? currentScore : null),
      describeJourneyTrend('Energy', dog.baseline_energy_score, checkins.length > 0 ? currentEnergyScore : null),
      describeJourneyTrend('Appetite', dog.baseline_appetite_score, checkins.length > 0 ? currentAppetiteScore : null),
      describeJourneyTrend('Cognitive/Behavior', dog.baseline_cognitive_score, latestCognitiveCheckin?.cognitive_score ?? null),
      describeWeightJourneyTrend(dog.weight_lbs, weightCheckins.length > 0 ? currentWeightValue : null)
    ];

    // Weekly table rows, most recent first
    const journeyTableRows = [...checkins]
      .sort((a, b) => b.week_number - a.week_number)
      .map(c => {
        const dateStr = new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return `<tr>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee;">Week ${c.week_number}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee;">${dateStr}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.mobility_score ?? '—'}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.energy_score ?? '—'}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.appetite_score ?? '—'}</td>
          <td style="padding: 8px 10px; border-bottom: 1px solid #eee; text-align: center;">${c.cognitive_score ?? '—'}</td>
        </tr>`;
      }).join('');

    // Notes, most recent first (dogNotes already ordered that way from the query above)
    const journeyNotesHtml = (dogNotes && dogNotes.length > 0)
      ? dogNotes.map(n => {
          const noteDate = new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          return `<div style="padding: 10px 0; border-bottom: 1px solid #eee;">
            <div style="font-size: 12px; color: #888; margin-bottom: 3px;">${noteDate}</div>
            <div style="font-size: 14px; color: #2C2C2C;">${n.note_text}</div>
          </div>`;
        }).join('')
      : `<p style="font-size: 14px; color: #888;">No notes logged yet.</p>`;

    // Active alert, if any (reuses the same activeAlert already fetched for the dashboard banner)
    const journeyAlertHtml = activeAlert
      ? `<div style="background: #FFF8E1; border-left: 4px solid #F5A623; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px;">
          <p style="margin: 0; font-size: 14px; color: #2C2C2C; font-weight: 500;">⚠️ ${activeAlert.message || 'A recent change was flagged for this dog.'}</p>
          <p style="margin: 6px 0 0 0; font-size: 12px; color: #888;">This is not a diagnosis — worth mentioning to your vet.</p>
        </div>`
      : '';

    console.log(`✅ Dashboard loaded for ${dog.dog_name}: score=${currentScore}, trend=${trend}, streak=${streak}, rank=${rank}/${totalDogs}`);

    // Send dashboard HTML with Chart.js visualization
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${dog.dog_name}'s Dashboard</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #F5F1E8;
            min-height: 100vh;
            padding: 20px;
            color: #2C2C2C;
          }
          .container { max-width: 1200px; margin: 0 auto; }
          .header {
            background: #FAFAF8;
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 20px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .header h1 { font-size: 28px; margin-bottom: 8px; color: #2C2C2C; font-weight: 600; }
          .header p { font-size: 14px; color: #888; font-weight: 400; }
          .week-progress {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-top: 12px;
            font-size: 13px;
            color: #666;
          }
          .week-dots {
            display: flex;
            gap: 4px;
          }
          .week-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #ddd;
          }
          .week-dot.completed {
            background: #A89968;
          }
          .dashboard-layout {
            display: grid;
            grid-template-columns: 2.2fr 1.2fr;
            gap: 20px;
            margin-bottom: 30px;
          }
          @media (max-width: 1024px) {
            .dashboard-layout {
              grid-template-columns: 1fr;
            }
          }
          @media (max-width: 600px) {
            body { padding: 10px; }
            .header { padding: 14px; }
            .header h1 { font-size: 18px; }
            /* Several buttons/links were built with white-space: nowrap,
               which is fine on desktop but forces horizontal overflow on a
               narrow phone screen since the text can't wrap or shrink.
               Letting them wrap and go full-width on small screens fixes
               the "page is too wide" problem on mobile. */
            a[style*="white-space: nowrap"],
            button[style*="white-space: nowrap"] {
              white-space: normal !important;
              width: 100%;
              text-align: center;
              box-sizing: border-box;
            }
            /* Banners that put a label and a button side-by-side need to
               stack on narrow screens instead of squeezing both onto one
               line. Deliberately specific (matches flex-wrap:wrap too) so
               this doesn't also catch the check-in modal's title/close-
               button row, which should stay side-by-side on mobile too. */
            div[style*="justify-content: space-between"][style*="flex-wrap: wrap"] {
              flex-direction: column;
              align-items: stretch !important;
            }
            /* Photo-upload mini-form + primary CTA button row (above the
               Baseline Score box): the file input has a fixed 100px width
               and the button's text can't fit alongside it in the space
               left on a narrow phone. Letting the row wrap — combined with
               the white-space:normal + width:100% rule above, which already
               applies to this button — drops the button cleanly onto its
               own line under the photo form instead of forcing both onto
               one line and overflowing the card. */
            .photo-and-checkin-row {
              flex-wrap: wrap;
            }
            /* Baseline Score shares .baseline-info-grid's 2-column row with
               Current Streak on desktop, which only leaves it half the
               card's width — cramped for 4 mini-columns (Mobility/Energy/
               Appetite/Weight) on a narrow phone. Spanning it across both
               grid columns gives it the full row; Current Streak and Best
               Streak then auto-flow onto their own 2-column row beneath it. */
            .baseline-score-item {
              grid-column: 1 / -1;
            }
          }
          .metrics-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 12px;
            background: #FAFAF8;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          }
          .metric-card {
            background: #FAFAF8;
            border-radius: 8px;
            padding: 16px;
            text-align: center;
            border: 1px solid #E8E4DA;
          }
          .metric-card h3 { color: #999; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
          .metric-value { font-size: 24px; font-weight: 500; color: #2C2C2C; margin-bottom: 6px; }
          .metric-label { font-size: 13px; color: #999; }
          .trend-indicator {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 16px;
            font-size: 11px;
            font-weight: 600;
            margin-top: 8px;
            background: #F0F0F0;
            color: #666;
          }
          .chart-card {
            background: #FAFAF8;
            border-radius: 12px;
            padding: 20px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .chart-card h2 { font-size: 16px; color: #2C2C2C; margin-bottom: 15px; font-weight: 500; }
          #mobilityChart { max-height: 280px; }
          .tips-card {
            background: white;
            border-radius: 12px;
            padding: 18px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            margin-bottom: 16px;
          }
          .tips-card:last-child { margin-bottom: 0; }
          .tips-card h2 { font-size: 15px; color: #2C2C2C; margin-bottom: 10px; font-weight: 700; }
          .tip-item {
            font-size: 13px;
            line-height: 1.6;
            color: #666;
            margin: 0;
          }
          .peer-card {
            background: #FAFAF8;
            border-radius: 12px;
            padding: 20px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .peer-card h2 { font-size: 16px; color: #2C2C2C; margin-bottom: 15px; font-weight: 500; }
          .peer-stat {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid #E8E4DA;
            font-size: 13px;
          }
          .peer-stat:last-child { border-bottom: none; }
          .peer-stat-label { color: #999; font-weight: 400; }
          .peer-stat-value { font-size: 18px; font-weight: 500; color: #2C2C2C; }
          .rank-badge {
            display: inline-block;
            background: #D4AF88;
            color: white;
            padding: 6px 14px;
            border-radius: 16px;
            font-weight: 500;
            font-size: 12px;
            margin-top: 10px;
          }
          .back-link {
            color: #A89968;
            text-decoration: none;
            font-size: 13px;
            display: inline-block;
            margin-bottom: 20px;
            font-weight: 500;
          }
          .back-link:hover { color: #8B7D5B; }
          .baseline-card {
            background: #FAFAF8;
            border-radius: 12px;
            padding: 20px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
            margin-bottom: 30px;
          }
          button {
            font-family: inherit;
          }
          button:hover {
            opacity: 0.9;
          }
          .baseline-photo {
            text-align: center;
            position: relative;
            width: 80px;
            height: 80px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          .baseline-photo img {
            width: 80px;
            height: 80px;
            border-radius: 8px;
            object-fit: cover;
          }
          .baseline-photo-placeholder {
            width: 80px;
            height: 80px;
            background: #E8E4DA;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            color: #bbb;
          }
          .baseline-info {
            display: flex;
            flex-direction: column;
          }
          .baseline-info h2 {
            font-size: 24px;
            color: #2C2C2C;
            margin-bottom: 15px;
            font-weight: 500;
          }
          .baseline-info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-bottom: 15px;
          }
          .baseline-info-item {
            padding: 12px;
            background: #FAFAF8;
            border-radius: 12px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .baseline-info-label {
            font-size: 11px;
            color: #999;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 5px;
            font-weight: 600;
          }
          .baseline-info-value {
            font-size: 18px;
            font-weight: 500;
            color: #2C2C2C;
          }
          .baseline-notes {
            padding: 12px;
            background: #FAFAF8;
            border-radius: 12px;
            margin-top: 15px;
            border: 1.5px solid #D4CDB8;
            box-shadow: 0 2px 8px rgba(44, 44, 44, 0.06);
          }
          .baseline-notes p {
            font-size: 13px;
            color: #555;
            line-height: 1.5;
            margin: 0;
          }
          .btn-primary {
            background: #A89968;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.2s;
          }
          .btn-primary:hover {
            opacity: 0.85;
          }
          .btn-secondary {
            background: #D4AF88;
            color: white;
            border: none;
            padding: 8px 14px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.2s;
          }
          .btn-secondary:hover {
            opacity: 0.85;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <a href="/check-in/${dog_id}" class="back-link">← Back to Check-In</a>
          ${dog.owner_id ? `<a href="/add-dog.html?owner_id=${dog.owner_id}" class="back-link" style="margin-left: 16px;">+ Add Another Dog</a>` : ''}

          <div class="header">
            <h1><i data-lucide="bar-chart-3"></i> ${dog.dog_name}'s Mobility Dashboard</h1>
            <p>${dog.breed || ''} • ${dog.age || 'Age unknown'} years old • ${dog.gender || 'Gender unknown'}</p>
            <div class="week-progress">
              <span>Baseline ✓</span>
              <span>·</span>
              <span>Week ${mostRecentSubmittedWeek} of 12</span>
              <div class="week-dots">
                ${Array.from({length: 12}, (_, i) => {
                  const weekNum = i + 1;
                  const isCompleted = weekNum <= mostRecentSubmittedWeek;
                  return `<div class="week-dot ${isCompleted ? 'completed' : ''}"></div>`;
                }).join('')}
              </div>
            </div>
            ${isSenior ? `<p style="margin: 8px 0 0 0; font-size: 13px; color: #666;">${dog.dog_name} is considered a senior for their breed.</p>` : ''}
          </div>

          ${isInBaselinePeriod ? `
          <div style="background: #EEF2F5; border-left: 4px solid #8B9BA8; border-radius: 8px; padding: 16px 20px; margin: 20px 0;">
            <p style="margin: 0; color: #4A5A66; font-size: 14px;"><i data-lucide="clipboard-list"></i> ${dog.dog_name}'s first weekly update will be ready in ${daysUntilFirstUpdate} day${daysUntilFirstUpdate === 1 ? '' : 's'}. You'll get a text when it's time.</p>
          </div>
          ` : hasUpdateDue ? `
          <div style="background: #FFF8E7; border-left: 4px solid #A89968; border-radius: 8px; padding: 16px 20px; margin: 20px 0; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div>
              <p style="margin: 0 0 4px 0; font-weight: 600; color: #8A7A4F; font-size: 14px;"><i data-lucide="clipboard-edit"></i> Week ${dueWeekNumber} update due</p>
              <p style="margin: 0; color: #5D4E37; font-size: 14px;">Takes about 30 seconds.</p>
            </div>
            <a href="/check-in/${dog_id}" style="background: #A89968; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; white-space: nowrap;">Complete Week ${dueWeekNumber} Update →</a>
          </div>
          ` : ''}

          ${activeAlert ? `
          <div style="background: #FFF3E0; border-left: 4px solid #FF9800; border-radius: 8px; padding: 16px 20px; margin: 20px 0;">
            <p style="margin: 0 0 4px 0; font-weight: 600; color: #E65100; font-size: 14px;">⚠️ Worth a look</p>
            <p style="margin: 0; color: #5D4037; font-size: 14px; line-height: 1.5;">${activeAlert.message}</p>
          </div>
          ` : ''}

          ${nextCheckinWeekNumber >= 2 ? `
          <div style="background: #FFF8E7; border-left: 4px solid #A89968; border-radius: 8px; padding: 16px 20px; margin: 20px 0; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div>
              <p style="margin: 0 0 4px 0; font-weight: 600; color: #8A7A4F; font-size: 14px;"><i data-lucide="book-open"></i> Breed guide unlocked</p>
              <p style="margin: 0; color: #5D4E37; font-size: 14px;">${dog.dog_name}'s ${dog.breed || 'breed'} guide is ready to read.</p>
            </div>
            <a href="/breed-guide/${dog_id}" style="background: #A89968; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; white-space: nowrap;">Read it →</a>
          </div>
          ` : ''}

          <div class="dashboard-layout">
            <!-- LEFT COLUMN: DOG INFO + CHARTS -->
            <div>
              <div class="baseline-card">
                <div style="display: flex; gap: 15px; align-items: flex-start; margin-bottom: 20px;">
                  <div class="baseline-photo">
                    ${dog.photo_url
                      ? `<img src="${dog.photo_url}" alt="${dog.dog_name}" />`
                      : `<div class="baseline-photo-placeholder"><i data-lucide="paw-print"></i></div>`
                    }
                  </div>
                  <div style="flex: 1;">
                    <h2 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 500; color: #2C2C2C;">${dog.dog_name}'s Health Journey</h2>
                    <p style="margin: 0 0 4px 0; font-size: 13px; color: #999; font-weight: 400;">
                      ${dog.breed || 'Breed unknown'} • ${dog.age || 'Age unknown'} years old • ${dog.gender || 'Gender unknown'}
                      ${dog.spayed_neutered ? ` • ${dog.spayed_neutered === 'yes' ? 'Fixed' : 'Not Fixed'}` : ''}
                      ${dog.diet_type ? ` • ${DIET_TYPE_LABELS[dog.diet_type] || dog.diet_type}` : ''}
                      ${dog.pet_insurance ? ` • ${dog.pet_insurance === 'yes' ? 'Insured' : dog.pet_insurance === 'no' ? 'No Insurance' : 'Insurance Unknown'}` : ''}
                    </p>
                    ${(() => {
                      const meds = (dog.treatment_category || [])
                        .filter(t => t !== 'none' && TREATMENT_CATEGORY_LABELS[t])
                        .map(t => TREATMENT_CATEGORY_LABELS[t]);
                      return meds.length > 0
                        ? `<p style="margin: 0 0 12px 0; font-size: 13px; color: #999; font-weight: 400;">${meds.join(' - ')}</p>`
                        : '';
                    })()}
                    <div class="photo-and-checkin-row" style="display: flex; gap: 8px; margin-bottom: 12px;">
                      <form id="quickPhotoUpload" style="display: flex; gap: 4px; align-items: center;">
                        <input type="file" id="quickPhotoInput" accept="image/*" style="padding: 8px 10px; border: 1.5px solid #D4CDB8; border-radius: 8px; font-size: 12px; width: 130px;">
                        <button type="submit" class="btn-secondary"><i data-lucide="camera"></i> Update ${dog.dog_name}'s Photo</button>
                      </form>
                      ${isInBaselinePeriod ? `
                      <button class="btn-primary" disabled style="white-space: nowrap; padding: 8px 16px; opacity: 0.5; cursor: not-allowed;">
                        Available in ${daysUntilFirstUpdate} day${daysUntilFirstUpdate === 1 ? '' : 's'}
                      </button>
                      ` : `
                      <button id="openCheckInBtn" class="btn-primary" style="white-space: nowrap; padding: 8px 16px;">
                        ${hasUpdateDue ? `Complete Week ${dueWeekNumber} Update` : "Share This Week's Update"}
                      </button>
                      `}
                    </div>
                  </div>
                </div>
                <div class="baseline-info">
                  <div class="baseline-info-grid">
                    <div class="baseline-info-item baseline-score-item">
                      <div class="baseline-info-label">Baseline Score</div>
                      <div style="display: flex; gap: 8px; margin-top: 4px;">
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Mobility</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.baseline_mobility_score ?? '—'}/8</div>
                        </div>
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Energy</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.baseline_energy_score ?? '—'}/8</div>
                        </div>
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Appetite</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.baseline_appetite_score ?? '—'}/8</div>
                        </div>
                        <div style="flex: 1; text-align: center;">
                          <div style="font-size: 9px; color: #AAA; text-transform: uppercase; letter-spacing: 0.3px;">Weight</div>
                          <div class="baseline-info-value" style="font-size: 15px;">${dog.weight_lbs ?? '—'} lb</div>
                        </div>
                      </div>
                    </div>
                    <div class="baseline-info-item">
                      <div class="baseline-info-label">Current Streak</div>
                      <div class="baseline-info-value">${streak > 0 ? '<i data-lucide="flame" style="width:14px;height:14px;vertical-align:-2px;"></i> ' : ''}${streak}w</div>
                      <p style="margin: 4px 0 0 0; font-size: 11px; color: #999;">${streak > 0 ? 'Keep it going!' : 'Complete your first check-in to start a streak'}</p>
                    </div>
                    <div class="baseline-info-item">
                      <div class="baseline-info-label">Best Streak</div>
                      <div class="baseline-info-value">${dog.longest_streak || streak}w</div>
                    </div>
                  </div>
                  ${dog.baseline_notes ? `
                  <div class="baseline-notes">
                    <p><strong>Baseline Notes:</strong> ${dog.baseline_notes}</p>
                  </div>
                  ` : ''}
                </div>
              </div>

              <div class="chart-card">
                <h2>Health observations over time</h2>
                <canvas id="mobilityChart"></canvas>
                <p style="font-size: 12px; color: #999; margin: 16px 0 6px 0;">Exact values by week (scroll sideways if needed):</p>
                <div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
                  <table style="border-collapse: collapse; width: 100%; min-width: ${Math.max(300, chartWeeks.length * 55)}px; font-size: 13px;">
                    <thead>
                      <tr>
                        <th style="text-align: left; padding: 6px 10px; border-bottom: 2px solid #EEE; color: #999; font-weight: 500; white-space: nowrap;"></th>
                        ${chartWeeks.map(w => `<th style="text-align: center; padding: 6px 10px; border-bottom: 2px solid #EEE; color: #999; font-weight: 500; white-space: nowrap;">${escapeHtml(w)}</th>`).join('')}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style="padding: 6px 10px; color: #667eea; font-weight: 600; white-space: nowrap;">Mobility</td>
                        ${chartScores.map(v => `<td style="text-align: center; padding: 6px 10px;">${v ?? '—'}</td>`).join('')}
                      </tr>
                      <tr>
                        <td style="padding: 6px 10px; color: #F5A623; font-weight: 600; white-space: nowrap;">Energy</td>
                        ${chartEnergyScores.map(v => `<td style="text-align: center; padding: 6px 10px;">${v ?? '—'}</td>`).join('')}
                      </tr>
                      <tr>
                        <td style="padding: 6px 10px; color: #4CAF50; font-weight: 600; white-space: nowrap;">Appetite</td>
                        ${chartAppetiteScores.map(v => `<td style="text-align: center; padding: 6px 10px;">${v ?? '—'}</td>`).join('')}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div class="chart-card">
                <h2><i data-lucide="file-text"></i> Notes</h2>
                <p style="font-size: 13px; color: #999; margin: -8px 0 16px 0;">Jot down anything worth remembering between check-ins — these are saved with ${dog.dog_name}'s health journey.</p>
                <form id="addNoteForm" style="display: flex; gap: 8px; margin-bottom: 16px;">
                  <input type="text" id="noteInput" placeholder="e.g. Seemed stiffer after our walk today" maxlength="500" style="flex: 1; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px;" required>
                  <button type="submit" style="background: #A89968; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap;">Add Note</button>
                </form>
                <div id="notesList">
                  ${dogNotes && dogNotes.length > 0
                    ? dogNotes.map(n => `
                      <div style="padding: 10px 0; border-bottom: 1px solid #F0EDE5;">
                        <p style="margin: 0 0 4px 0; font-size: 14px; color: #2C2C2C;">${escapeHtml(n.note_text)}</p>
                        <p style="margin: 0; font-size: 12px; color: #AAA;">${new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                      </div>
                    `).join('')
                    : `<p style="font-size: 13px; color: #AAA; text-align: center; padding: 10px 0;">No notes yet — add one whenever something's worth remembering.</p>`
                  }
                </div>
              </div>

              <div class="peer-card">
                <h2>How ${dog.dog_name} compares across the community</h2>
                <div class="peer-stat">
                  <span class="peer-stat-label">Your dog's rank</span>
                  <span class="peer-stat-value">#${rank} / ${totalDogs}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Community average score</span>
                  <span class="peer-stat-value">${peerAverage}/8</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Status</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #A89968; font-weight: 600;"><i data-lucide="target"></i> ${currentScore > peerAverage ? 'Above average!' : currentScore === parseFloat(peerAverage) ? 'At average' : 'Below average'}</span>
                </div>
                <p style="margin: 12px 0 0 0; font-size: 12px; color: #999; line-height: 1.5;">This compares ${dog.dog_name} to all dogs currently logging, not specifically ${dog.breed || 'this breed'} — breed-specific comparisons will be added once enough dogs of the same breed are logging regularly.</p>
              </div>
            </div>

            <!-- MIDDLE COLUMN: SUMMARY -->
            <div>
              <div class="peer-card">
                <h2>This week at a glance</h2>
                <div class="peer-stat">
                  <span class="peer-stat-label">Mobility</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">${describeTrendForGlance(currentScore, previousScore)}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Energy</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">${describeTrendForGlance(currentEnergyScore, previousEnergyScore)}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Appetite</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">${describeTrendForGlance(currentAppetiteScore, previousAppetiteScore)}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Weight</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">${describeWeightTrendForGlance(currentWeightValue, previousWeightValue)}</span>
                </div>
              </div>
            </div>

          </div>

          <!-- BOTTOM SECTION: INFO & SUMMARY -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px;">
            <div style="background: #FAFAF8; border-radius: 12px; padding: 18px; border-left: 4px solid #D4AF88;">
              <p style="margin: 0; font-size: 13px; color: #2C2C2C; line-height: 1.6;">
                Based on anonymized observations from all dogs currently logging on Companion Commons, not specifically ${dog.breed || 'this breed'}. For context only — not a diagnosis or veterinary assessment.
              </p>
            </div>

            <div style="background: #FAFAF8; border-radius: 12px; padding: 18px; border-left: 4px solid #D4AF88;">
              <div style="display: flex; align-items: flex-start; gap: 12px;">
                <i data-lucide="circle-help" style="width: 20px; height: 20px; flex-shrink: 0;"></i>
                <div>
                  <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 500; color: #2C2C2C;">Prepare for a conversation with ${dog.dog_name}'s vet, family, babysitter etc.</p>
                  <p style="margin: 0; font-size: 13px; color: #2C2C2C;">Review recent notes and highlights to help you share what matters most.</p>
                </div>
              </div>
            </div>
          </div>

          <div style="display: flex; gap: 15px; margin-bottom: 30px;">
            <button id="viewSummaryBtn" style="flex: 1; background: #A89968; color: white; border: none; padding: 16px 20px; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer;">
              Click to View ${dog.dog_name}'s Journey Summary
            </button>
          </div>

          <p style="font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 14px; margin: 0;">
            Companion Commons is not a veterinary service and does not diagnose, treat, prescribe, or provide veterinary advice. Always consult a licensed veterinarian about your companion's health and care. Think this may be an emergency? Contact your veterinarian or the nearest emergency veterinary hospital immediately.
          </p>
        </div>

        <!-- CHECK-IN MODAL -->
        <div id="checkInModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; overflow-y: auto;">
          <div style="background: white; margin: 20px auto; border-radius: 12px; padding: 30px; max-width: 500px; position: relative; top: 50px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
              <h2 style="margin: 0; color: #333;"><i data-lucide="clipboard-check"></i> ${dog.dog_name}'s Check-In</h2>
              <button id="closeCheckInBtn" style="background: none; border: none; font-size: 24px; cursor: pointer;">✕</button>
            </div>

            <form id="checkInForm">
              <label style="display: block; margin: 15px 0 5px 0; font-weight: 500; color: #333;">How's ${dog.dog_name}'s mobility this week?</label>
              <input type="range" id="mobility" name="mobility_score" min="1" max="8" value="${latestMobilityScore}" style="width: 100%; cursor: pointer;">
              <div id="mobilityHint" style="font-size: 12px; color: #666; margin: 5px 0 0 0;">4/8 - Some good days, some bad days</div>

              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">How's ${dog.dog_name}'s energy level this week?</label>
              <input type="range" id="energy" name="energy_score" min="1" max="8" value="${latestEnergyScore}" style="width: 100%; cursor: pointer;">
              <div id="energyHint" style="font-size: 12px; color: #666; margin: 5px 0 0 0;">4/8 - Average energy</div>

              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">How's ${dog.dog_name}'s appetite this week?</label>
              <input type="range" id="appetite" name="appetite_score" min="1" max="8" value="${latestAppetiteScore}" style="width: 100%; cursor: pointer;">
              <div id="appetiteHint" style="font-size: 12px; color: #666; margin: 5px 0 0 0;">4/8 - Average appetite</div>

              ${showCognitiveThisWeek ? `
              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">How's ${dog.dog_name}'s alertness &amp; behavior this week?</label>
              <input type="range" id="cognitive" name="cognitive_score" min="1" max="8" value="${latestCognitiveScore}" style="width: 100%; cursor: pointer;">
              <div id="cognitiveHint" style="font-size: 12px; color: #666; margin: 5px 0 0 0;">4/8 - Average alertness</div>
              ` : ''}

              ${showCognitiveThisWeek ? `
              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">${dog.dog_name}'s weight this week (lbs)</label>
              <input type="number" id="weight" name="weight_lbs" min="1" max="250" value="${latestWeightScore}" placeholder="e.g. 62" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-family: inherit; font-size: 14px; box-sizing: border-box;">
              <div style="font-size: 12px; color: #666; margin: 5px 0 0 0;">Optional — tracked alongside mobility, energy, and appetite.</div>
              ` : ''}

              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">Any notes? (optional)</label>
              <textarea id="observation" name="observation" placeholder="E.g., 'Easier on stairs this week' or 'Stiff in morning'" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-family: inherit; font-size: 14px; box-sizing: border-box; height: 80px;"></textarea>

              <button type="submit" style="background: #A89968; color: white; border: none; padding: 15px; border-radius: 8px; font-size: 16px; cursor: pointer; width: 100%; margin-top: 20px; font-weight: 500;">Submit Check-In ✓</button>
            </form>
          </div>
        </div>

        <!-- JOURNEY SUMMARY MODAL -->
        <div id="journeySummaryModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; overflow-y: auto;">
          <div id="journeySummaryPrintArea" style="background: white; margin: 20px auto; border-radius: 12px; padding: 14px; max-width: 650px; position: relative; top: 30px; border: 2px solid #D4CDB8;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;" class="no-print">
              <h2 style="margin: 0; color: #333;"><i data-lucide="clipboard-list"></i> ${dog.dog_name}'s Journey Summary</h2>
              <button id="closeJourneyBtn" style="background: none; border: none; font-size: 24px; cursor: pointer;">✕</button>
            </div>

            <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 12px;">
              ${dog.photo_url
                ? `<img src="${dog.photo_url}" alt="${dog.dog_name}" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; flex-shrink: 0;" />`
                : `<div style="width: 64px; height: 64px; border-radius: 50%; background: #FFF8E7; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i data-lucide="paw-print" style="width: 28px; height: 28px;"></i></div>`
              }
              <div>
                <p style="margin: 0 0 2px 0; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; color: #A89968; text-transform: uppercase;">Companion Commons</p>
                <h3 style="margin: 0; font-size: 18px; color: #2C2C2C;">${dog.dog_name}'s Journey Summary</h3>
              </div>
            </div>
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #666;">
              ${dog.breed || 'Breed unknown'} • ${dog.age || 'Age unknown'} years old • ${dog.gender || 'Gender unknown'}
              ${dog.spayed_neutered ? ` • ${dog.spayed_neutered === 'yes' ? 'Fixed' : 'Not Fixed'}` : ''}
              ${dog.diet_type ? ` • ${DIET_TYPE_LABELS[dog.diet_type] || dog.diet_type}` : ''}
              ${dog.pet_insurance ? ` • ${dog.pet_insurance === 'yes' ? 'Insured' : dog.pet_insurance === 'no' ? 'No Insurance' : 'Insurance Unknown'}` : ''}
            </p>
            ${(() => {
              const journeyMeds = (dog.treatment_category || [])
                .filter(t => t !== 'none' && TREATMENT_CATEGORY_LABELS[t])
                .map(t => TREATMENT_CATEGORY_LABELS[t]);
              return journeyMeds.length > 0
                ? `<p style="margin: 0 0 8px 0; font-size: 13px; color: #666;">Medications/treatments: ${journeyMeds.join(', ')}</p>`
                : `<p style="margin: 0 0 8px 0; font-size: 13px; color: #666;"></p>`;
            })()}
            <p style="margin: 0 0 6px 0; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999;">Prepared ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · Baseline ✓ · Week ${weeksSinceSignup} of 12</p>

            <hr style="border: none; border-top: 1.5px solid #D4CDB8; margin: 0 0 8px 0;">

            ${journeyAlertHtml}

            <h3 style="font-size: 15px; margin-bottom: 8px; color: #2C2C2C;">Trends since baseline</h3>
            <div style="background: #FAFAF8; border-radius: 8px; padding: 6px 16px; margin-bottom: 10px; break-inside: avoid; page-break-inside: avoid;">
              ${journeyTrendLines.map(line => `<p style="margin: 0 0 6px 0; font-size: 14px; color: #2C2C2C;">${line}</p>`).join('')}
            </div>

            <!-- Chart snapshot: visible in the on-screen modal at all times,
                 not just in print, so what John sees before printing matches
                 what actually prints. Populated from the live Chart.js
                 canvas via toDataURL as soon as the modal opens (see
                 viewSummaryBtn's click handler) — reuses the exact same
                 chart already rendered on the dashboard instead of
                 maintaining a second one. Height is capped (with
                 object-fit:contain so nothing distorts) since the on-screen
                 canvas can render fairly tall on a wide desktop viewport —
                 this keeps the printed summary from growing past one page
                 for a typical baseline-only case. -->
            <div id="journeyChartPrintOnly" style="margin-bottom: 10px; break-inside: avoid; page-break-inside: avoid;">
              <img id="journeyChartImg" style="width: 100%; max-width: 100%; max-height: 160px; object-fit: contain; display: block;" alt="${dog.dog_name}'s mobility, energy, and appetite chart" />
              <p style="margin: 4px 0 0 0; font-size: 11px; color: #999; line-height: 1.4;">As ${dog.dog_name}'s weekly health journey updates are submitted, this chart will contain more information, giving you a better health journey picture.</p>
            </div>

            <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 8px 0;">

            <h3 style="font-size: 15px; margin-bottom: 8px; color: #2C2C2C;">Weekly log</h3>
            ${journeyTableRows ? `
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; break-inside: avoid; page-break-inside: avoid;">
              <thead>
                <tr style="background: #FAFAF8;">
                  <th style="padding: 8px 10px; text-align: left; font-weight: 600; color: #666;">Week</th>
                  <th style="padding: 8px 10px; text-align: left; font-weight: 600; color: #666;">Date</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Mobility</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Energy</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Appetite</th>
                  <th style="padding: 8px 10px; text-align: center; font-weight: 600; color: #666;">Cognitive</th>
                </tr>
              </thead>
              <tbody>
                ${journeyTableRows}
              </tbody>
            </table>
            ` : `<p style="font-size: 14px; color: #888; margin-bottom: 10px;">No weekly check-ins yet — this will fill in after ${dog.dog_name}'s first update.</p>`}

            <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 8px 0;">

            <h3 style="font-size: 15px; margin-bottom: 8px; color: #2C2C2C;">Notes</h3>
            <div style="margin-bottom: 10px; break-inside: avoid; page-break-inside: avoid;">
              ${journeyNotesHtml}
            </div>

            <p style="font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 8px; margin: 0; break-inside: avoid; page-break-inside: avoid;">
              Companion Commons is not a veterinary service and does not diagnose, treat, prescribe, or provide veterinary advice. Always consult a licensed veterinarian about your companion's health and care. Think this may be an emergency? Contact your veterinarian or the nearest emergency veterinary hospital immediately.
            </p>
            <p style="font-size: 12px; color: #999; margin: 4px 0 0 0;">
              As community grows, comparisons will also print on this summary as well.
            </p>

            <div class="no-print" style="display: flex; gap: 12px; margin-top: 20px;">
              <button id="printJourneyBtn" style="flex: 1; background: #A89968; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;"><i data-lucide="printer"></i> Print / Save as PDF</button>
            </div>
          </div>
        </div>

        <style>
          @media print {
            /* display:none (not visibility:hidden) actually removes hidden
               content from the layout flow. visibility:hidden kept
               .container's full multi-page height even while invisible, so
               the browser generated that many pages and repeated the
               absolutely-positioned print area on each one. Hiding every
               direct body child except the modal (the real ancestor of
               #journeySummaryPrintArea) collapses the printed page down to
               the print area's actual height. */
            body > *:not(#journeySummaryModal) { display: none !important; }
            #journeySummaryModal { position: static !important; background: none !important; overflow: visible !important; z-index: auto !important; }
            #journeySummaryPrintArea { position: absolute; top: 0; left: 0; width: 100%; margin: 0; box-shadow: none; }
            .no-print { display: none !important; }
          }
        </style>

        <script>
          // Modal controls
          const modal = document.getElementById('checkInModal');
          const openBtn = document.getElementById('openCheckInBtn');
          const closeBtn = document.getElementById('closeCheckInBtn');

          const mobilitySlider = document.getElementById('mobility');
          const mobilityHints = {
            1: "1/8 - Very stiff/limited movement",
            2: "2/8 - Mostly struggling",
            3: "3/8 - Significant issues",
            4: "4/8 - Some good days, some bad days",
            5: "5/8 - Moderate improvement",
            6: "6/8 - Noticeably better",
            7: "7/8 - Very active",
            8: "8/8 - Excellent, no mobility issues"
          };

          const energySlider = document.getElementById('energy');
          const energyHints = {
            1: "1/8 - Very low energy",
            2: "2/8 - Mostly lethargic",
            3: "3/8 - Below average energy",
            4: "4/8 - Average energy",
            5: "5/8 - Fairly active",
            6: "6/8 - Active",
            7: "7/8 - Very active",
            8: "8/8 - Extremely energetic"
          };

          const appetiteSlider = document.getElementById('appetite');
          const appetiteHints = {
            1: "1/8 - Barely eating",
            2: "2/8 - Eating very little",
            3: "3/8 - Below average appetite",
            4: "4/8 - Average appetite",
            5: "5/8 - Good appetite",
            6: "6/8 - Very good appetite",
            7: "7/8 - Excellent appetite",
            8: "8/8 - Eating everything in sight"
          };

          const cognitiveSlider = document.getElementById('cognitive');
          const cognitiveHints = {
            1: "1/8 - Often confused/withdrawn",
            2: "2/8 - Frequently disoriented",
            3: "3/8 - Below average alertness",
            4: "4/8 - Average alertness",
            5: "5/8 - Fairly engaged",
            6: "6/8 - Engaged and responsive",
            7: "7/8 - Very sharp",
            8: "8/8 - Sharp and fully engaged"
          };

          // openBtn won't exist during the baseline period (disabled button
          // has no id then) — guard so this doesn't crash the rest of the
          // page's JS (photo upload, chart rendering, etc.)
          if (openBtn) {
            openBtn.addEventListener('click', () => {
              modal.style.display = 'block';
            });
          }

          // Mid-week notes — submits via the API, then reloads to show it
          // in the list. Simple and reliable; no need for fancier in-place
          // DOM updates for something used this occasionally.
          const addNoteForm = document.getElementById('addNoteForm');
          if (addNoteForm) {
            addNoteForm.addEventListener('submit', async (e) => {
              e.preventDefault();
              const input = document.getElementById('noteInput');
              const text = input.value.trim();
              if (!text) return;

              try {
                const response = await fetch('/api/notes/${dog_id}', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ note_text: text })
                });
                if (response.ok) {
                  window.location.reload();
                } else {
                  alert('Could not save note. Please try again.');
                }
              } catch (err) {
                console.error('Error saving note:', err);
                alert('Could not save note. Please try again.');
              }
            });
          }

          closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
          });

          modal.addEventListener('click', (e) => {
            if (e.target === modal) {
              modal.style.display = 'none';
            }
          });

          mobilitySlider.addEventListener('input', () => {
            document.getElementById('mobilityHint').textContent = mobilityHints[mobilitySlider.value];
          });
          energySlider.addEventListener('input', () => {
            document.getElementById('energyHint').textContent = energyHints[energySlider.value];
          });
          appetiteSlider.addEventListener('input', () => {
            document.getElementById('appetiteHint').textContent = appetiteHints[appetiteSlider.value];
          });
          if (cognitiveSlider) {
            cognitiveSlider.addEventListener('input', () => {
              document.getElementById('cognitiveHint').textContent = cognitiveHints[cognitiveSlider.value];
            });
          }

          // Journey Summary — opens a real modal built from actual check-in
          // history, notes, and any active alert (see journeySummaryModal below).
          const journeyModal = document.getElementById('journeySummaryModal');
          document.getElementById('viewSummaryBtn').addEventListener('click', () => {
            journeyModal.style.display = 'block';
            // Snapshot the live Chart.js canvas as a static image as soon as
            // the modal opens, not at print time — so what's shown on screen
            // in the modal is exactly what prints, instead of the chart
            // appearing invisibly only once Print is clicked. Reuses the
            // exact same chart already rendered on the dashboard instead of
            // maintaining a second one.
            const mobilityCanvas = document.getElementById('mobilityChart');
            const journeyChartImg = document.getElementById('journeyChartImg');
            if (mobilityCanvas && journeyChartImg) {
              journeyChartImg.src = mobilityCanvas.toDataURL('image/png');
            }
          });
          document.getElementById('closeJourneyBtn').addEventListener('click', () => {
            journeyModal.style.display = 'none';
          });
          document.getElementById('printJourneyBtn').addEventListener('click', () => {
            window.print();
          });

          // Form submission
          document.getElementById('checkInForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            try {
              const response = await fetch('/api/checkin-senior', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  dog_id: '${dog_id}',
                  mobility_score: parseInt(formData.get('mobility_score')),
                  energy_score: parseInt(formData.get('energy_score')),
                  appetite_score: parseInt(formData.get('appetite_score')),
                  cognitive_score: formData.get('cognitive_score') ? parseInt(formData.get('cognitive_score')) : null,
                  weight_lbs: formData.get('weight_lbs') ? parseInt(formData.get('weight_lbs')) : null,
                  observation: formData.get('observation') || null
                })
              });

              const result = await response.json();

              if (result.success) {
                modal.style.display = 'none';
                // Reload dashboard to show updated data
                location.reload();
              } else {
                alert('Error: ' + (result.error || 'Unknown error'));
              }
            } catch (error) {
              console.error('Error:', error);
              alert('Error submitting check-in. Please try again.');
            }
          });

          // Quick photo upload
          document.getElementById('quickPhotoUpload').addEventListener('submit', async (e) => {
            e.preventDefault();
            const photoInput = document.getElementById('quickPhotoInput');

            if (!photoInput.files.length) {
              alert('Please select a photo');
              return;
            }

            const file = photoInput.files[0];
            const maxSize = 5 * 1024 * 1024; // 5MB

            if (file.size > maxSize) {
              alert('Photo must be less than 5MB');
              return;
            }

            const formData = new FormData();
            formData.append('photo', file);
            formData.append('dog_id', '${dog_id}');

            try {
              const response = await fetch('/api/upload-dog-photo', {
                method: 'POST',
                body: formData
              });

              const result = await response.json();

              if (result.success) {
                // Reload dashboard to show updated photo
                location.reload();
              } else {
                alert('Error: ' + (result.error || 'Upload failed'));
              }
            } catch (error) {
              console.error('Error:', error);
              alert('Error uploading photo. Please try again.');
            }
          });

          const ctx = document.getElementById('mobilityChart').getContext('2d');
          const chart = new Chart(ctx, {
            type: 'line',
            data: {
              labels: ${JSON.stringify(chartWeeks)},
              datasets: [
                {
                  label: 'Mobility',
                  data: ${JSON.stringify(chartScores)},
                  borderColor: '#667eea',
                  backgroundColor: 'rgba(102, 126, 234, 0.08)',
                  borderWidth: 2,
                  fill: false,
                  tension: 0.4,
                  pointStyle: 'circle',
                  pointRadius: 3,
                  pointBackgroundColor: '#667eea',
                  pointBorderColor: '#fff',
                  pointBorderWidth: 2,
                  pointHoverRadius: 6
                },
                {
                  label: 'Energy',
                  data: ${JSON.stringify(chartEnergyScores)},
                  borderColor: '#F5A623',
                  backgroundColor: 'rgba(245, 166, 35, 0.08)',
                  borderWidth: 2,
                  borderDash: [6, 3],
                  fill: false,
                  tension: 0.4,
                  pointStyle: 'triangle',
                  pointRadius: 3,
                  pointBackgroundColor: '#F5A623',
                  pointBorderColor: '#fff',
                  pointBorderWidth: 2,
                  pointHoverRadius: 6
                },
                {
                  label: 'Appetite',
                  data: ${JSON.stringify(chartAppetiteScores)},
                  borderColor: '#4CAF50',
                  backgroundColor: 'rgba(76, 175, 80, 0.08)',
                  borderWidth: 2,
                  borderDash: [2, 2],
                  fill: false,
                  tension: 0.4,
                  pointStyle: 'rect',
                  pointRadius: 3,
                  pointBackgroundColor: '#4CAF50',
                  pointBorderColor: '#fff',
                  pointBorderWidth: 2,
                  pointHoverRadius: 6
                }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              plugins: {
                legend: {
                  display: true,
                  position: 'top',
                  labels: { font: { size: 12 }, usePointStyle: true, boxWidth: 8 }
                },
                tooltip: {
                  mode: 'index',
                  intersect: false
                }
              },
              interaction: {
                mode: 'index',
                intersect: false
              },
              scales: {
                y: {
                  beginAtZero: true,
                  max: 8,
                  ticks: { stepSize: 1 },
                  grid: { drawBorder: false }
                },
                x: {
                  grid: { display: false }
                }
              }
            }
          });
        </script>
        <script src="https://unpkg.com/lucide@1.33.0"></script>
        <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// ============================================
// GET ENDPOINTS (Dashboard/Testing)
// NEW ENDPOINTS
// ============================================
app.get('/api/user/:user_id', async (req, res) => {
    try {
        const { user_id } = req.params;

        const { data: user, error: userError } = await supabase
            .from('users')
            .select(`
                id, email, phone, status, created_at,
                pets (
                    id, name, breed, birthday, gender,
                    survey_baselines (health_score, activity_score, treatments),
                    survey_weekly_checkins (week_number, mobility_score, trend),
                    survey_enrichment (week_number, primary_goal, peer_comparison_interest)
                ),
                sms_preferences (preferred_time, frequency, sms_opted_out)
            `)
            .eq('id', user_id)
            .single();

        if (userError) throw userError;

        res.json({ success: true, user });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Error fetching user' });
    }
});

app.get('/api/pet/:pet_id/progress', async (req, res) => {
    try {
        const { pet_id } = req.params;

        const { data: checkins, error } = await supabase
            .from('survey_weekly_checkins')
            .select('week_number, mobility_score, trend, created_at')
            .eq('pet_id', pet_id)
            .order('week_number', { ascending: true });

        if (error) throw error;

        const completedWeeks = checkins.length;
        const weeksRemaining = Math.max(0, 12 - completedWeeks);

        res.json({
            pet_id,
            completed_weeks: completedWeeks,
            weeks_remaining: weeksRemaining,
            retention_rate: completedWeeks > 0 ? Math.round((completedWeeks / 12) * 100) : 0,
            progression: checkins
        });
    } catch (error) {
        console.error('Error fetching progress:', error);
        res.status(500).json({ error: 'Error fetching progress' });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select(`
                id, email, phone, status, created_at,
                pets (
                    id, name
                )
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, total: users.length, users });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Error fetching users' });
    }
});

// ============================================
// BACKWARD COMPATIBILITY: Old /api/signups endpoint
// Returns data from Supabase (not signups.json)
// ============================================
app.get('/api/signups', async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            total: users.length,
            signups: users
        });
    } catch (error) {
        console.error('Error fetching signups:', error);
        res.status(500).json({ error: 'Error fetching signups' });
    }
});

// ============================================
// GOVERNANCE: Live Metrics (Transparent Dashboard)
// ============================================
app.get('/api/governance/stats', async (req, res) => {
    try {
        // Signup count from senior_dogs — the real, live table. This used
        // to read from `users`, which is a fully abandoned parallel schema
        // (users/pets/survey_*/sms_preferences — confirmed at 0 rows, no FK
        // to senior_dogs, an earlier owner-entity attempt that was never
        // wired up) that never received data, so this endpoint always
        // reported zero regardless of real signups.
        const { count: dogCount, error: dogsError } = await supabase
            .from('senior_dogs')
            .select('id', { count: 'exact', head: true });

        if (dogsError) throw dogsError;
        const memberCount = dogCount || 0;

        // Today's model is one dog per signup, so "founding members" and
        // "pets registered" are the same count for now. These will only
        // diverge once a real Owner entity exists (see the multi-dog-owner
        // project) and can distinguish unique owners from unique dogs.
        const petsRegistered = memberCount;

        // SMS opt-in rate from senior_dogs.sms_consent — the real,
        // actively-used consent field (same one the churn cron and the
        // check-in reminder gate already check) — not the dead
        // sms_preferences table.
        const { count: smsOptIns, error: smsError } = await supabase
            .from('senior_dogs')
            .select('id', { count: 'exact', head: true })
            .eq('sms_consent', true);

        if (smsError) console.warn('SMS consent query issue:', smsError);
        const smsOptInCount = smsOptIns || 0;
        const smsOptInRate = memberCount > 0 ? Math.round((smsOptInCount / memberCount) * 100) : 0;

        // Weekly check-in count from mobility_checkins — the real
        // check-ins table, not the dead survey_weekly_checkins table.
        const { count: checkInCount, error: checkinsError } = await supabase
            .from('mobility_checkins')
            .select('id', { count: 'exact', head: true });

        if (checkinsError) console.warn('Check-ins query issue:', checkinsError);
        const weeklyCheckIns = checkInCount || 0;

        // Total data points = baseline assessments (one per dog) + weekly check-ins
        const totalDataPoints = memberCount + weeklyCheckIns;

        res.status(200).json({
            foundingMembers: memberCount,
            petsRegistered,
            totalDataPoints,
            weeklyCheckIns,
            smsOptInRate: `${smsOptInRate}%`,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error fetching governance stats:', error);
        res.status(500).json({
            error: 'Failed to fetch metrics',
            message: error.message
        });
    }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        supabase: 'connected'
    });
});

// ============================================
// TEST EMAIL (STEP 9 - Testing SendGrid)
// ============================================
app.post('/api/test-email', async (req, res) => {
  try {
    const { email, dogName, lastScore, lastCheckInDate, dogId } = req.body;

    if (!email || !dogName || !dogId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: email, dogName, dogId'
      });
    }

    const result = await sendChurnAlertEmail(
      email,
      dogName,
      lastScore || 5,
      lastCheckInDate || new Date().toISOString(),
      dogId
    );

    if (result.success) {
      res.json({
        success: true,
        message: `Test email sent to ${email}`
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// TEST CHURN DETECTION (STEP 10 - Manual trigger)
// ============================================
app.post('/api/test-churn-detection', async (req, res) => {
  try {
    console.log('🔍 Manual churn detection trigger...');
    let alertsSent = 0;
    let dogsChecked = 0;

    // Get all senior dogs
    const { data: allDogs } = await supabase
      .from('senior_dogs')
      .select('id, dog_name, baseline_mobility_score, created_at');

    if (!allDogs || allDogs.length === 0) {
      return res.json({
        success: true,
        message: 'No dogs found',
        dogsChecked: 0,
        alertsSent: 0
      });
    }

    dogsChecked = allDogs.length;
    const now = new Date();

    // For each dog, run the exact same shared churn-check the real cron
    // uses (see processDogForChurn) — no SMS reminders (a manual trigger
    // shouldn't have SMS side effects), and always emails SENDGRID_FROM_EMAIL
    // instead of the real owner, so a test run never emails an actual user.
    for (const dog of allDogs) {
      try {
        const result = await processDogForChurn(dog, { emailOverride: SENDGRID_FROM_EMAIL });
        if (!result.skipped && result.alertSent) {
          alertsSent++;
        }
      } catch (dogError) {
        console.error(`Error processing dog ${dog.id}:`, dogError.message);
      }
    }

    res.json({
      success: true,
      message: `Churn detection complete`,
      dogsChecked,
      alertsSent,
      timestamp: now.toISOString()
    });

  } catch (error) {
    console.error('Error in test churn detection:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// AGE BELLA'S DATA (for STEP 11 testing)
// ============================================
app.post('/api/age-bella-data', async (req, res) => {
  try {
    const bellaId = '550e8400-e29b-41d4-a716-446655440002';

    // Set her last check-in to 8 days ago AND update week_number to an older week
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

    // Get Bella's dog info to calculate what week 8 days ago was
    const { data: bellaInfo } = await supabase
      .from('senior_dogs')
      .select('created_at')
      .eq('id', bellaId)
      .single();

    if (!bellaInfo) throw new Error('Bella not found');

    // Calculate week number for 8 days ago
    const created = new Date(bellaInfo.created_at);
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 8);
    const pastWeek = Math.floor((pastDate - created) / (7 * 24 * 60 * 60 * 1000)) + 1;

    const { error } = await supabase
      .from('mobility_checkins')
      .update({
        created_at: eightDaysAgo.toISOString(),
        week_number: Math.max(1, pastWeek) // Ensure week_number is at least 1
      })
      .eq('dog_id', bellaId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;

    res.json({
      success: true,
      message: `Bella's last check-in aged to week ${Math.max(1, pastWeek)} (${eightDaysAgo.toLocaleDateString()})`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error aging Bella data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// CLEAR BELLA'S CHURN FLAG (for STEP 11 testing)
// ============================================
app.post('/api/clear-bella-alert', async (req, res) => {
  try {
    const bellaId = '550e8400-e29b-41d4-a716-446655440002';

    // Delete Bella's recent churn flags
    const { error } = await supabase
      .from('churn_flags')
      .delete()
      .eq('dog_id', bellaId);

    if (error) throw error;

    res.json({
      success: true,
      message: `Bella's churn flags cleared. She can now be alerted again.`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error clearing Bella alert:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// SEND MAGIC LINK (STEP 19 - Authentication Flow)
// Baseline survey → Magic link token → SMS delivery
// ============================================
app.post('/api/send-magic-link', async (req, res) => {
  try {
    // Extract and validate form data
    const {
      dog_name,
      breed,
      age,
      gender,
      baseline_mobility_score,
      baseline_energy_score,
      baseline_appetite_score,
      baseline_cognitive_score,
      observations,
      email,
      phone,
      consent,
      owner_name,
      contact_preference,
      weight_lbs,
      spayed_neutered,
      zip_code,
      diet_type,
      pet_insurance,
      treatment_category
    } = req.body;

    // Validate required fields
    if (!dog_name || !breed || !age || !gender || !email || !phone || !consent) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Stage 3: contact_preference replaces the old sms_consent checkbox
    // with a real 3-way choice, matching owners.preferred_contact_method's
    // CHECK constraint exactly.
    if (!['sms', 'email', 'both'].includes(contact_preference)) {
      return res.status(400).json({
        success: false,
        error: 'Please choose how we should contact you (SMS, email, or both)'
      });
    }

    // Sanitize inputs
    // dog_name capped at 40 (tighter than sanitizeName's 100 default) so a
    // long name can't push any SMS template — verification, reminders, the
    // churn email — past a single 160-char GSM-7 segment. See the SMS
    // length audit this cap was added for.
    const cleanName = sanitizeName(dog_name, 40);
    const cleanBreed = sanitizeName(breed);
    // Optional — matches the Stage 3 design decision to not require a
    // human name. Empty string when omitted, not null, matching how the
    // rest of this route already handles optional fields (e.g. observations).
    const cleanOwnerName = owner_name ? sanitizeName(owner_name, 100) : '';
    const cleanAge = parseInt(age);
    const cleanGender = sanitizeSelect(gender, ['male', 'female', 'unknown']);
    const cleanBaseline = parseInt(baseline_mobility_score);
    const cleanEnergy = parseInt(baseline_energy_score);
    const cleanAppetite = parseInt(baseline_appetite_score);
    const cleanCognitive = parseInt(baseline_cognitive_score);
    const cleanEmail = sanitizeEmail(email);
    const cleanPhone = sanitizePhone(phone);
    const cleanObservations = sanitizeString(observations, 500);

    console.log(`📝 Baseline received for ${cleanName}: mobility=${cleanBaseline}, energy=${cleanEnergy}, appetite=${cleanAppetite}, cognitive=${cleanCognitive}`);

    // Validate parsed values
    if (!cleanName || !cleanBreed || isNaN(cleanAge) || isNaN(cleanBaseline) || isNaN(cleanEnergy) || isNaN(cleanAppetite) || isNaN(cleanCognitive)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid input values'
      });
    }

    // Validate age and mobility score ranges
    if (cleanAge < 1 || cleanAge > 30) {
      return res.status(400).json({
        success: false,
        error: 'Age must be between 1 and 30'
      });
    }

    if (cleanBaseline < 1 || cleanBaseline > 8) {
      return res.status(400).json({
        success: false,
        error: 'Mobility score must be between 1 and 8'
      });
    }

    if (cleanEnergy < 1 || cleanEnergy > 8) {
      return res.status(400).json({
        success: false,
        error: 'Energy score must be between 1 and 8'
      });
    }

    if (cleanAppetite < 1 || cleanAppetite > 8) {
      return res.status(400).json({
        success: false,
        error: 'Appetite score must be between 1 and 8'
      });
    }

    if (cleanCognitive < 1 || cleanCognitive > 8) {
      return res.status(400).json({
        success: false,
        error: 'Cognitive score must be between 1 and 8'
      });
    }

    // Validate phone format
    if (!cleanPhone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number. Must be 10+ digits.'
      });
    }

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email address'
      });
    }

    // ============================================
    // NEW BASELINE FIELDS (weight, spay/neuter, zip,
    // diet, insurance, treatment category)
    // ============================================
    const cleanWeight = parseInt(weight_lbs);
    if (isNaN(cleanWeight) || cleanWeight < 1 || cleanWeight > 250) {
      return res.status(400).json({
        success: false,
        error: 'Weight must be a number between 1 and 250 lbs'
      });
    }

    const cleanSpayedNeutered = sanitizeSelect(spayed_neutered, ['yes', 'no']);
    if (spayed_neutered && !['yes', 'no'].includes(String(spayed_neutered).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Spayed/neutered must be yes or no'
      });
    }

    const cleanZip = typeof zip_code === 'string' ? zip_code.trim() : '';
    if (!/^\d{5}$/.test(cleanZip)) {
      return res.status(400).json({
        success: false,
        error: 'ZIP code must be exactly 5 digits'
      });
    }

    const allowedDietTypes = ['dry', 'wet', 'raw', 'prescription', 'mixed', 'other'];
    const cleanDietType = sanitizeSelect(diet_type, allowedDietTypes);
    if (!diet_type || !allowedDietTypes.includes(String(diet_type).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Diet type must be one of: ' + allowedDietTypes.join(', ')
      });
    }

    const allowedInsuranceValues = ['yes', 'no', 'not_sure'];
    const cleanPetInsurance = sanitizeSelect(pet_insurance, allowedInsuranceValues);
    if (!pet_insurance || !allowedInsuranceValues.includes(String(pet_insurance).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: 'Pet insurance must be one of: ' + allowedInsuranceValues.join(', ')
      });
    }

    const allowedTreatmentCategories = [
      'none', 'joint_supplement', 'nsaid', 'steroid',
      'pain_medication', 'other_prescription', 'other_supplement'
    ];
    const rawTreatmentCategories = Array.isArray(treatment_category)
      ? treatment_category
      : (treatment_category ? [treatment_category] : []);
    const cleanTreatmentCategories = rawTreatmentCategories
      .filter(v => allowedTreatmentCategories.includes(v));

    // Stage 3 returning-owner check: does an owner already exist for this
    // phone number? maybeSingle() (not single()) since the common case —
    // a brand-new signup — has zero matches, which single() would treat
    // as an error rather than a normal "no match" result.
    const { data: existingOwner, error: ownerLookupError } = await supabase
      .from('owners')
      .select('id')
      .eq('phone', cleanPhone)
      .maybeSingle();

    if (ownerLookupError) {
      console.error('Error checking for existing owner:', ownerLookupError);
      return res.status(500).json({
        success: false,
        error: 'Server error. Please try again later.'
      });
    }

    const existingOwnerId = existingOwner ? existingOwner.id : null;

    // Generate a secure random token (32 bytes = 64 hex characters)
    const token = crypto.randomBytes(32).toString('hex');

    // Token expiry: 15 minutes from now
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Store the magic link token in database. Fields below are stored
    // regardless of existingOwnerId (useful for audit/debugging even when
    // unused) — but /verify only trusts them for a brand-new owner. When
    // existingOwnerId is set, /verify pulls contact info from the real
    // owners record instead, never from this resubmitted-but-unverified
    // form data (see Stage 3's design).
    const { error: tokenError } = await supabase
      .from('magic_link_tokens')
      .insert({
        token,
        email: cleanEmail,
        phone: cleanPhone,
        dog_name: cleanName,
        breed: cleanBreed,
        age: cleanAge,
        gender: cleanGender,
        baseline_mobility_score: cleanBaseline,
        baseline_energy_score: cleanEnergy,
        baseline_appetite_score: cleanAppetite,
        baseline_cognitive_score: cleanCognitive,
        observations: cleanObservations,
        // Derived boolean, kept for senior_dogs.sms_consent (still a
        // boolean per Stage 1's mapping) — 'sms' or 'both' count as
        // consenting to SMS, 'email' alone does not.
        sms_consent: contact_preference === 'sms' || contact_preference === 'both',
        contact_preference,
        owner_name: cleanOwnerName || null,
        weight_lbs: cleanWeight,
        spayed_neutered: cleanSpayedNeutered,
        zip_code: cleanZip,
        diet_type: cleanDietType,
        pet_insurance: cleanPetInsurance,
        treatment_category: cleanTreatmentCategories,
        existing_owner_id: existingOwnerId,
        expires_at: expiresAt,
        used_at: null,
        created_at: new Date().toISOString()
      });

    if (tokenError) {
      console.error('Error storing magic link token:', tokenError);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate verification link'
      });
    }

    // Build verification URL
    const verifyUrl = `${BASE_URL}/verify?token=${token}`;

    // Send SMS with magic link via Twilio. Different copy for a returning
    // owner (see Stage 3's design) — the real phone owner should know this
    // adds a dog to an existing account rather than assuming a fresh signup.
    const smsBody = existingOwnerId
      ? `Add ${cleanName} to your account: ${verifyUrl} (15 min)`
      : `${cleanName}'s profile - tap to finish: ${verifyUrl} (15 min)`;

    try {
      const smsMessage = await twilioClient.messages.create({
        body: smsBody,
        from: TWILIO_PHONE_NUMBER,
        to: cleanPhone
      });

      console.log(`✅ Magic link SMS sent to ${cleanPhone} (SID: ${smsMessage.sid})`);
    } catch (smsError) {
      console.error('Error sending magic link SMS:', smsError.message);
      // Note: We could optionally email the link as fallback
      // For now, we'll return an error
      return res.status(500).json({
        success: false,
        error: 'Failed to send verification SMS. Please check your phone number.'
      });
    }

    // Success response
    res.json({
      success: true,
      message: 'Magic link sent! Check your SMS for a verification link.',
      phone: cleanPhone,
      existingOwner: !!existingOwnerId
    });

  } catch (error) {
    console.error('Error in send-magic-link endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Server error. Please try again later.'
    });
  }
});

// ============================================
// VERIFY MAGIC LINK (STEP 20 - Profile Creation)
// Validates token, creates senior_dogs profile, redirects to dashboard
// ============================================
app.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;

    // Validate token parameter
    if (!token) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Verification Failed | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              a {
                display: inline-block;
                background: #007AFF;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ Invalid Link</h1>
              <p>This verification link is missing or invalid. Please start your Baseline Health Journey again.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
          </body>
        </html>
      `);
    }

    // Fetch the magic link token from database
    const { data: tokenData, error: fetchError } = await supabase
      .from('magic_link_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (fetchError || !tokenData) {
      console.log('Magic link token not found:', token);
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Link Not Found | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              a {
                display: inline-block;
                background: #007AFF;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ Link Not Found</h1>
              <p>This verification link doesn't exist. Please request a new one by completing the Baseline Health Journey.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
          </body>
        </html>
      `);
    }

    // Check if token has already been used
    if (tokenData.used_at) {
      console.log('Magic link token already used:', token);
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Link Already Used | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              a {
                display: inline-block;
                background: #007AFF;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ Link Already Used</h1>
              <p>This verification link has already been used. If you need a new one, complete the Baseline Health Journey again.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
          </body>
        </html>
      `);
    }

    // Check if token has expired
    const expiresAt = new Date(tokenData.expires_at);
    if (expiresAt < new Date()) {
      console.log('Magic link token expired:', token);
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Link Expired | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              a {
                display: inline-block;
                background: #007AFF;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                text-decoration: none;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1><i data-lucide="clock"></i> Link Expired</h1>
              <p>This verification link expired after 15 minutes. Complete the Baseline Health Journey again to get a new link.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
            <script src="https://unpkg.com/lucide@1.33.0"></script>
            <script>lucide.createIcons({ attrs: { width: '1em', height: '1em' } });</script>
          </body>
        </html>
      `);
    }

    // Token is valid! Resolve the owner first — either link to the
    // existing one (Stage 3's returning-owner path) or create a brand-new
    // one. Either way, phone/email/zip for the new senior_dogs row below
    // come from this resolved owner, never straight from tokenData, so a
    // returning owner's dog is always tied to their real, trusted contact
    // info rather than whatever was resubmitted (and not yet verified) on
    // this particular form.
    const now = new Date().toISOString();
    let ownerId, ownerPhone, ownerEmail, ownerZip, ownerSmsConsent;

    if (tokenData.existing_owner_id) {
      const { data: existingOwnerRow, error: existingOwnerError } = await supabase
        .from('owners')
        .select('id, email, phone, zip_code, preferred_contact_method')
        .eq('id', tokenData.existing_owner_id)
        .single();

      if (existingOwnerError || !existingOwnerRow) {
        console.error('Error fetching existing owner for verify:', existingOwnerError);
        return res.status(500).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>Error | Companion Commons</title>
              <style>
                body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 50px auto; text-align: center; padding: 20px; }
                .error-box { background: #fee; border-radius: 12px; padding: 30px; }
                h1 { color: #c33; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>❌ Error Creating Profile</h1>
                <p>Something went wrong finding your account. Please contact support or try again later.</p>
              </div>
            </body>
          </html>
        `);
      }

      ownerId = existingOwnerRow.id;
      ownerPhone = existingOwnerRow.phone;
      ownerEmail = existingOwnerRow.email;
      ownerZip = existingOwnerRow.zip_code;
      ownerSmsConsent = existingOwnerRow.preferred_contact_method === 'sms' || existingOwnerRow.preferred_contact_method === 'both';
    } else {
      const { data: newOwner, error: newOwnerError } = await supabase
        .from('owners')
        .insert({
          email: tokenData.email,
          phone: tokenData.phone,
          preferred_contact_method: tokenData.contact_preference,
          zip_code: tokenData.zip_code,
          name: tokenData.owner_name || null,
          preferred_reminder_day: 3,        // Wednesday (mid-week, neutral) — same default senior_dogs uses below
          preferred_reminder_time: '14:00', // 2:00 PM (afternoon, safe for all)
          created_at: now
        })
        .select()
        .single();

      if (newOwnerError || !newOwner) {
        console.error('Error creating owner:', newOwnerError);
        return res.status(500).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>Error | Companion Commons</title>
              <style>
                body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 50px auto; text-align: center; padding: 20px; }
                .error-box { background: #fee; border-radius: 12px; padding: 30px; }
                h1 { color: #c33; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>❌ Error Creating Profile</h1>
                <p>Something went wrong. Please contact support or try again later.</p>
              </div>
            </body>
          </html>
        `);
      }

      ownerId = newOwner.id;
      ownerPhone = tokenData.phone;
      ownerEmail = tokenData.email;
      ownerZip = tokenData.zip_code;
      ownerSmsConsent = tokenData.sms_consent === true || tokenData.sms_consent === 'true';
    }

    const { data: newDog, error: dogError } = await supabase
      .from('senior_dogs')
      .insert({
        dog_name: tokenData.dog_name,
        breed: tokenData.breed,
        age: tokenData.age,
        gender: tokenData.gender,
        baseline_mobility_score: tokenData.baseline_mobility_score,
        baseline_energy_score: tokenData.baseline_energy_score,
        baseline_appetite_score: tokenData.baseline_appetite_score,
        baseline_cognitive_score: tokenData.baseline_cognitive_score,
        baseline_notes: tokenData.observations,
        phone: ownerPhone,
        email: ownerEmail,
        sms_consent: ownerSmsConsent,
        weight_lbs: tokenData.weight_lbs,
        spayed_neutered: tokenData.spayed_neutered,
        zip_code: ownerZip,
        diet_type: tokenData.diet_type,
        pet_insurance: tokenData.pet_insurance,
        treatment_category: tokenData.treatment_category,
        owner_id: ownerId,
        created_at: now,
        preferred_reminder_day: 3,        // Wednesday (mid-week, neutral)
        preferred_reminder_time: '14:00'  // 2:00 PM (afternoon, safe for all)
      })
      .select();

    if (dogError || !newDog || newDog.length === 0) {
      console.error('Error creating senior_dog profile:', dogError);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>Error | Companion Commons</title>
            <style>
              body {
                font-family: -apple-system, sans-serif;
                max-width: 500px;
                margin: 50px auto;
                text-align: center;
                padding: 20px;
              }
              .error-box {
                background: #fee;
                border-radius: 12px;
                padding: 30px;
              }
              h1 {
                color: #c33;
              }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ Error Creating Profile</h1>
              <p>Something went wrong. Please contact support or try again later.</p>
            </div>
          </body>
        </html>
      `);
    }

    const dogId = newDog[0].id;

    // Store user contact info (create/update users table entry)
    const { error: userError } = await supabase
      .from('users')
      .insert({
        email: tokenData.email,
        phone: tokenData.phone,
        sms_consent: tokenData.sms_consent,
        created_at: now
      })
      .select();

    if (userError) {
      console.warn('Warning: Error storing user contact info:', userError);
      // Non-fatal error - continue to mark token as used
    }

    // Mark the token as used
    const { error: updateError } = await supabase
      .from('magic_link_tokens')
      .update({ used_at: now })
      .eq('token', token);

    if (updateError) {
      console.error('Error marking token as used:', updateError);
      // Non-fatal - continue to redirect
    }

    console.log(`✅ Profile created for ${tokenData.dog_name} (ID: ${dogId})`);

    // Export to Google Sheets (Signups tab) — real signup + baseline data,
    // fired after everything above is confirmed successful. Doesn't block
    // or affect the redirect either way if this fails.
    // Dog ID is the real join key across all three tabs — dog names aren't
    // unique (two people can both name their dog "Max"), and email isn't a
    // reliable per-dog key either. This is the same UUID already used
    // throughout the app itself (dashboard/check-in URLs).
    await appendRowToSheet('Signups', [
      new Date().toISOString(),
      dogId,
      ownerEmail || '',
      tokenData.dog_name || '',
      tokenData.breed || '',
      tokenData.age || '',
      tokenData.gender || '',
      tokenData.weight_lbs ?? '',
      tokenData.baseline_mobility_score ?? '',
      tokenData.baseline_energy_score ?? '',
      tokenData.baseline_appetite_score ?? '',
      tokenData.baseline_cognitive_score ?? ''
    ]);

    // Redirect to dashboard with the new dog ID
    res.redirect(`/dashboard/${dogId}`);

  } catch (error) {
    console.error('Error in verify endpoint:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Error | Companion Commons</title>
          <style>
            body {
              font-family: -apple-system, sans-serif;
              max-width: 500px;
              margin: 50px auto;
              text-align: center;
              padding: 20px;
            }
            .error-box {
              background: #fee;
              border-radius: 12px;
              padding: 30px;
            }
            h1 {
              color: #c33;
            }
          </style>
        </head>
        <body>
          <div class="error-box">
            <h1>❌ Server Error</h1>
            <p>An unexpected error occurred. Please try again later.</p>
          </div>
        </body>
      </html>
    `);
  }
});

// ============================================
// ADD ANOTHER DOG (Stage 3 — multi-dog owner project)
// Phase-B-only creation for an already-known owner. No magic-link/SMS
// step here — reached from a link the owner only sees after already
// verifying their phone once (on the post-verification confirmation page
// or dashboard), so re-verifying again would be redundant friction, not
// extra safety. See Stage 3's design for the reasoning.
// ============================================
app.post('/api/add-dog', async (req, res) => {
  try {
    const {
      owner_id,
      dog_name,
      breed,
      age,
      gender,
      baseline_mobility_score,
      baseline_energy_score,
      baseline_appetite_score,
      baseline_cognitive_score,
      observations,
      consent,
      weight_lbs,
      spayed_neutered,
      diet_type,
      pet_insurance,
      treatment_category
    } = req.body;

    if (!owner_id || !dog_name || !breed || !age || !gender || !consent) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Confirm the owner is real before creating anything against it.
    const { data: owner, error: ownerError } = await supabase
      .from('owners')
      .select('id, email, phone, zip_code, preferred_contact_method')
      .eq('id', owner_id)
      .maybeSingle();

    if (ownerError) {
      console.error('Error looking up owner for add-dog:', ownerError);
      return res.status(500).json({ success: false, error: 'Server error. Please try again later.' });
    }

    if (!owner) {
      return res.status(404).json({ success: false, error: 'We could not find your account. Please use the link from your confirmation page, or start a new signup.' });
    }

    // Same 40-char cap as the main signup route, for the same reason (SMS
    // segment length across every template that interpolates dog_name).
    const cleanName = sanitizeName(dog_name, 40);
    const cleanBreed = sanitizeName(breed);
    const cleanAge = parseInt(age);
    const cleanGender = sanitizeSelect(gender, ['male', 'female', 'unknown']);
    const cleanBaseline = parseInt(baseline_mobility_score);
    const cleanEnergy = parseInt(baseline_energy_score);
    const cleanAppetite = parseInt(baseline_appetite_score);
    const cleanCognitive = parseInt(baseline_cognitive_score);
    const cleanObservations = sanitizeString(observations, 500);

    if (!cleanName || !cleanBreed || isNaN(cleanAge) || isNaN(cleanBaseline) || isNaN(cleanEnergy) || isNaN(cleanAppetite) || isNaN(cleanCognitive)) {
      return res.status(400).json({ success: false, error: 'Invalid input values' });
    }

    if (cleanAge < 1 || cleanAge > 30) {
      return res.status(400).json({ success: false, error: 'Age must be between 1 and 30' });
    }
    if (cleanBaseline < 1 || cleanBaseline > 8) {
      return res.status(400).json({ success: false, error: 'Mobility score must be between 1 and 8' });
    }
    if (cleanEnergy < 1 || cleanEnergy > 8) {
      return res.status(400).json({ success: false, error: 'Energy score must be between 1 and 8' });
    }
    if (cleanAppetite < 1 || cleanAppetite > 8) {
      return res.status(400).json({ success: false, error: 'Appetite score must be between 1 and 8' });
    }
    if (cleanCognitive < 1 || cleanCognitive > 8) {
      return res.status(400).json({ success: false, error: 'Cognitive score must be between 1 and 8' });
    }

    const cleanWeight = parseInt(weight_lbs);
    if (isNaN(cleanWeight) || cleanWeight < 1 || cleanWeight > 250) {
      return res.status(400).json({ success: false, error: 'Weight must be a number between 1 and 250 lbs' });
    }

    const cleanSpayedNeutered = sanitizeSelect(spayed_neutered, ['yes', 'no']);
    if (spayed_neutered && !['yes', 'no'].includes(String(spayed_neutered).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Spayed/neutered must be yes or no' });
    }

    const allowedDietTypes = ['dry', 'wet', 'raw', 'prescription', 'mixed', 'other'];
    const cleanDietType = sanitizeSelect(diet_type, allowedDietTypes);
    if (!diet_type || !allowedDietTypes.includes(String(diet_type).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Diet type must be one of: ' + allowedDietTypes.join(', ') });
    }

    const allowedInsuranceValues = ['yes', 'no', 'not_sure'];
    const cleanPetInsurance = sanitizeSelect(pet_insurance, allowedInsuranceValues);
    if (!pet_insurance || !allowedInsuranceValues.includes(String(pet_insurance).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Pet insurance must be one of: ' + allowedInsuranceValues.join(', ') });
    }

    const allowedTreatmentCategories = [
      'none', 'joint_supplement', 'nsaid', 'steroid',
      'pain_medication', 'other_prescription', 'other_supplement'
    ];
    const rawTreatmentCategories = Array.isArray(treatment_category)
      ? treatment_category
      : (treatment_category ? [treatment_category] : []);
    const cleanTreatmentCategories = rawTreatmentCategories
      .filter(v => allowedTreatmentCategories.includes(v));

    const now = new Date().toISOString();
    const ownerSmsConsent = owner.preferred_contact_method === 'sms' || owner.preferred_contact_method === 'both';

    const { data: newDog, error: dogError } = await supabase
      .from('senior_dogs')
      .insert({
        dog_name: cleanName,
        breed: cleanBreed,
        age: cleanAge,
        gender: cleanGender,
        baseline_mobility_score: cleanBaseline,
        baseline_energy_score: cleanEnergy,
        baseline_appetite_score: cleanAppetite,
        baseline_cognitive_score: cleanCognitive,
        baseline_notes: cleanObservations,
        phone: owner.phone,
        email: owner.email,
        sms_consent: ownerSmsConsent,
        weight_lbs: cleanWeight,
        spayed_neutered: cleanSpayedNeutered,
        zip_code: owner.zip_code,
        diet_type: cleanDietType,
        pet_insurance: cleanPetInsurance,
        treatment_category: cleanTreatmentCategories,
        owner_id: owner.id,
        created_at: now,
        preferred_reminder_day: 3,
        preferred_reminder_time: '14:00'
      })
      .select();

    if (dogError || !newDog || newDog.length === 0) {
      console.error('Error creating senior_dog profile via add-dog:', dogError);
      return res.status(500).json({ success: false, error: 'Something went wrong creating the profile. Please try again later.' });
    }

    const dogId = newDog[0].id;
    console.log(`✅ Profile created via add-dog for ${cleanName} (ID: ${dogId}, owner: ${owner.id})`);

    // Same Signups tab, same join key (dog UUID) as the main signup route.
    await appendRowToSheet('Signups', [
      new Date().toISOString(),
      dogId,
      owner.email || '',
      cleanName,
      cleanBreed,
      cleanAge,
      cleanGender,
      cleanWeight ?? '',
      cleanBaseline ?? '',
      cleanEnergy ?? '',
      cleanAppetite ?? '',
      cleanCognitive ?? ''
    ]);

    res.json({ success: true, dogId });
  } catch (error) {
    console.error('Error in add-dog endpoint:', error);
    res.status(500).json({ success: false, error: 'Server error. Please try again later.' });
  }
});

// ============================================
// UPLOAD DOG PHOTO (STEP 23 - Photo Upload)
// POST /api/upload-dog-photo
// ============================================

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(), // Store in memory before uploading to Supabase
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 MB max
  },
  fileFilter: (req, file, cb) => {
    // Only allow image MIME types
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed. Only JPEG, PNG, and WebP images are supported.`));
    }
  }
});

app.post('/api/upload-dog-photo', upload.single('photo'), async (req, res) => {
  try {
    // Validate file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    // Extract dog_id from request
    const { dog_id } = req.body;
    if (!dog_id) {
      return res.status(400).json({
        success: false,
        error: 'Dog ID is required'
      });
    }

    console.log(`📸 Uploading photo for dog: ${dog_id}`);
    console.log(`📦 File: ${req.file.originalname} (${req.file.size} bytes)`);

    // Verify dog exists
    const { data: dog, error: dogError } = await supabase
      .from('senior_dogs')
      .select('id')
      .eq('id', dog_id)
      .single();

    if (dogError || !dog) {
      return res.status(404).json({
        success: false,
        error: 'Dog not found'
      });
    }

    // Generate unique filename: dog_id + timestamp + random + original extension
    const ext = path.extname(req.file.originalname);
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex');
    const filename = `${dog_id}/${timestamp}-${randomStr}${ext}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('Dog_Photos')
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase Storage upload error:', uploadError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload photo to storage'
      });
    }

    // Get public URL for the uploaded file
    const { data: { publicUrl } } = supabase
      .storage
      .from('Dog_Photos')
      .getPublicUrl(filename);

    console.log(`✅ Photo uploaded: ${publicUrl}`);

    // Update senior_dogs table with photo URL
    const { error: updateError } = await supabase
      .from('senior_dogs')
      .update({ photo_url: publicUrl })
      .eq('id', dog_id);

    if (updateError) {
      console.error('Error updating dog photo URL:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Photo uploaded but failed to save URL'
      });
    }

    // Success response
    res.json({
      success: true,
      message: `Photo uploaded successfully for ${dog_id}`,
      photo_url: publicUrl,
      filename: filename
    });

  } catch (error) {
    console.error('Error in upload-dog-photo endpoint:', error);

    // Handle multer file size errors
    if (error.message.includes('File too large')) {
      return res.status(400).json({
        success: false,
        error: 'File is too large. Maximum size is 5 MB.'
      });
    }

    // Handle multer file type errors
    if (error.message.includes('File type not allowed')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Server error uploading photo'
    });
  }
});

// ============================================
// STATIC PAGES (UNCHANGED)
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'index.html'));
});

app.get('/about.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'about.html'));
});

app.get('/independent.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'independent.html'));
});

app.get('/privacy.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'privacy.html'));
});

app.get('/governance.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'governance.html'));
});

app.get('/faq.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'faq.html'));
});

app.get('/founding.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'founding.html'));
});

// ============================================
// HELPER FUNCTIONS
// ============================================

// Send churn alert email (dog hasn't checked in)
async function sendChurnAlertEmail(ownerEmail, dogName, lastScore, lastCheckInDate, dogId) {
  if (!SENDGRID_API_KEY) {
    console.warn('⚠️ SendGrid not configured. Email not sent.');
    return;
  }

  try {
    // lastCheckInDate is null when the dog has never had a real check-in —
    // in that case there's no real date to cite (the caller no longer
    // falls back to the signup date, which used to make this line stay
    // stuck on the same stale date forever). Only cite an actual date when
    // we have one.
    const sinceLine = lastCheckInDate
      ? `We noticed we haven't heard from you since <strong>${new Date(lastCheckInDate).toLocaleDateString()}</strong>. No pressure — we know life gets busy.`
      : `We noticed you haven't logged a check-in yet. No pressure — we know life gets busy.`;

    const msg = {
      to: ownerEmail,
      from: SENDGRID_FROM_EMAIL,
      subject: `How's ${dogName} this week? 👋`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="background: #f5f5f5; border-radius: 12px; padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px; text-align: center;">Hey there! 👋</h2>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              ${sinceLine}
            </p>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              When you get a moment, we'd love to know how ${dogName}'s doing this week. One quick check-in takes 30 seconds and helps build a clear picture of ${dogName} and all the pet families participating.
            </p>
            <p style="color: #666; font-size: 14px; margin: 15px 0; line-height: 1.6;">
              <strong>Bonus:</strong> Every check-in helps us build a clearer picture of pet health for the whole community. 🐾
            </p>
            <div style="text-align: center; margin-top: 25px;">
              <a href="${BASE_URL}/dashboard/${dogId}" style="display: inline-block; background: #d96f56; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                View ${dogName}'s Progress and Update
              </a>
            </div>
            <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
              Companion Commons — Together we can change the future of pet health understanding
            </p>
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log(`✅ Churn alert email sent to ${ownerEmail} for ${dogName}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error sending churn alert email for ${dogName}:`, error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// SHARED CHURN-DETECTION LOGIC FOR ONE DOG
// Used by both the real hourly cron and the manual /api/test-churn-detection
// endpoint, so there's exactly one implementation to fix going forward —
// this is exactly why the baseline-period fix from earlier today lived in
// the cron but not the test endpoint until this refactor: two copies of the
// same logic had already started to drift.
//
// options:
//   sendSmsReminders (bool) — the real cron queues SMS check-in reminders;
//     the manual test endpoint never has, on purpose — a manual trigger
//     shouldn't have SMS side effects.
//   emailOverride (string|null) — the manual test endpoint always sends to
//     SENDGRID_FROM_EMAIL instead of the real owner's address, so running a
//     test never emails an actual user. The real cron leaves this null and
//     falls back to the dog's own email on file.
//
// Returns { skipped: true, reason, currentWeek? } or
//         { skipped: false, alertSent: true, currentWeek }
// so each caller can log/count in whatever style it already uses.
// ============================================
async function processDogForChurn(dog, options = {}) {
  const { sendSmsReminders = false, emailOverride = null } = options;

  // Defensive floor: a created_at slightly in the future (timezone quirk,
  // clock skew) can make (now - created) negative, which would floor to
  // week 0 without this guard — this is what produced the real "Week #0"
  // text a user received. Same bug class as the streak week-0 issue from
  // the 27C session.
  const created = new Date(dog.created_at);
  const now = new Date();

  // Baseline-period gate — same pattern already used by the check-in
  // submission routes (daysSinceSignupForCheckin / daysSinceSignupForSave)
  // and the dashboard (isInBaselinePeriod): a dog's first check-in isn't
  // even available until 7 full days after signup, so they can't be
  // "missing" one before then. Skip entirely — no email, no SMS reminder
  // queue, no churn_flags record — there's nothing to flag yet.
  const daysSinceSignupForChurn = (now - created) / (24 * 60 * 60 * 1000);
  const isInBaselinePeriod = Math.floor(daysSinceSignupForChurn / 7) === 0;
  if (isInBaselinePeriod) {
    return { skipped: true, reason: 'baseline_period' };
  }

  const currentWeek = Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1);

  // Check if dog has a check-in for this week
  const { data: thisWeekCheckin } = await supabase
    .from('mobility_checkins')
    .select('id')
    .eq('dog_id', dog.id)
    .eq('week_number', currentWeek)
    .limit(1);

  // If they DO have a check-in this week, skip them
  if (thisWeekCheckin && thisWeekCheckin.length > 0) {
    return { skipped: true, reason: 'has_checkin_this_week', currentWeek };
  }

  // Calculate reminder times based on CURRENT WEEK (not creation date).
  // Computed unconditionally (not just inside the sendSmsReminders block
  // below) because the churn-email gate further down also needs
  // reminderDay1, regardless of whether this call is queueing SMS.
  // Week 1 starts on creation date
  // Week 2 starts 7 days after creation
  // Week X starts on (creation + (7 * (X-1)) days)
  const weekStartDate = new Date(created);
  weekStartDate.setDate(weekStartDate.getDate() + (7 * (currentWeek - 1)));

  // Reminder #1: Start of week at 2pm
  const reminderDay1 = new Date(weekStartDate);
  reminderDay1.setHours(14, 0, 0, 0); // 2pm

  if (sendSmsReminders) {
    // ============================================
    // FLOW 2: AUTO SMS REMINDERS (Missing check-in notifications)
    // Sends SMS at 2pm (Day 7), 7pm (+4h), and 7:30am next day
    // ============================================

    // Reminder #2: Same day at 7pm (+4 hours)
    const reminderDay2At7pm = new Date(reminderDay1);
    reminderDay2At7pm.setHours(19, 0, 0, 0); // 7pm

    // Reminder #3: Next day at 7:30am (weekday) or 2pm (weekend)
    const reminderDay3 = new Date(reminderDay1);
    reminderDay3.setDate(reminderDay3.getDate() + 1);
    const day3OfWeek = reminderDay3.getDay();
    const day3Time = (day3OfWeek === 0 || day3OfWeek === 6) ? '14:00' : '07:30'; // 2pm weekend, 7:30am weekday
    const [day3Hours, day3Mins] = day3Time.split(':').map(Number);
    reminderDay3.setHours(day3Hours, day3Mins, 0, 0);

    // Check what SMS reminders have been queued/sent for this dog/week
    const { data: sentSms } = await supabase
      .from('sms_queue')
      .select('id, scheduled_for, status, message_type')
      .eq('pet_id', dog.id)
      .like('message_type', `week_${currentWeek}%`)
      .order('scheduled_for', { ascending: true });

    // Check if specific reminders have been sent
    const reminder1Sent = sentSms?.some(s => s.message_type.includes('reminder_1'));
    const reminder2Sent = sentSms?.some(s => s.message_type.includes('reminder_2'));
    const reminder3Sent = sentSms?.some(s => s.message_type.includes('reminder_3'));

    // Debug: Show reminder timing
    if (currentWeek >= 2) {
      console.log(`  ⏰ ${dog.dog_name}: Reminder #1 fires at ${reminderDay1.toLocaleString()}, Reminder #2 at ${reminderDay2At7pm.toLocaleString()}, Reminder #3 at ${reminderDay3.toLocaleString()}`);
    }

    const reminderCheckinLink = `${BASE_URL}/check-in/${dog.id}`;
    const canTextThisDog = !!(dog.phone && dog.sms_consent);

    if (!dog.phone) {
      console.warn(`⚠️ ${dog.dog_name} has no phone on file — skipping reminder queue (they signed up before phone numbers were saved to the profile)`);
    } else if (!dog.sms_consent) {
      console.log(`ℹ️ ${dog.dog_name}'s owner didn't opt in to SMS reminders — skipping`);
    }

    // REMINDER #1 (2pm): Queue if it's time and hasn't been sent yet
    if (now >= reminderDay1 && !reminder1Sent && canTextThisDog) {
      const { error: queueError1 } = await supabase
        .from('sms_queue')
        .insert({
          pet_id: dog.id,
          phone: dog.phone,
          message_type: `week_${currentWeek}_reminder_1`,
          scheduled_for: reminderDay1.toISOString(),
          message_body: `${dog.dog_name}'s #${currentWeek} week check-in time! Click here to complete a 30-second update: ${reminderCheckinLink}`,
          status: 'pending'
        });
      if (queueError1) {
        console.error(`❌ Error queueing reminder #1 for ${dog.dog_name}:`, queueError1.message);
      } else {
        console.log(`📱 Queued reminder #1 (2pm) for ${dog.dog_name}`);
      }
    }

    // REMINDER #2 (7pm): Queue if it's time and hasn't been sent yet
    if (now >= reminderDay2At7pm && !reminder2Sent && canTextThisDog) {
      const { error: queueError2 } = await supabase
        .from('sms_queue')
        .insert({
          pet_id: dog.id,
          phone: dog.phone,
          message_type: `week_${currentWeek}_reminder_2`,
          scheduled_for: reminderDay2At7pm.toISOString(),
          message_body: `${dog.dog_name}'s week #${currentWeek} check-in - no rush, update when you can: ${reminderCheckinLink}`,
          status: 'pending'
        });
      if (queueError2) {
        console.error(`❌ Error queueing reminder #2 for ${dog.dog_name}:`, queueError2.message);
      } else {
        console.log(`📱 Queued reminder #2 (7pm) for ${dog.dog_name}`);
      }
    }

    // REMINDER #3 (7:30am/2pm next day): Queue if it's time and hasn't been sent yet
    if (now >= reminderDay3 && !reminder3Sent && canTextThisDog) {
      const { error: queueError3 } = await supabase
        .from('sms_queue')
        .insert({
          pet_id: dog.id,
          phone: dog.phone,
          message_type: `week_${currentWeek}_reminder_3`,
          scheduled_for: reminderDay3.toISOString(),
          message_body: `${dog.dog_name}'s week #${currentWeek} check-in - every update helps the community: ${reminderCheckinLink}`,
          status: 'pending'
        });
      if (queueError3) {
        console.error(`❌ Error queueing reminder #3 for ${dog.dog_name}:`, queueError3.message);
      } else {
        console.log(`📱 Queued reminder #3 (${day3Time}) for ${dog.dog_name}`);
      }
    }
  }

  // Don't send the churn email before Reminder #1 would have gone out
  // (2pm on the first day of the missed week) — same time-check pattern
  // already used for the SMS reminders themselves, just above. Without
  // this, the email had no gate at all and could fire on the very first
  // cron tick after midnight, hours before any SMS reminder went out.
  if (now < reminderDay1) {
    return { skipped: true, reason: 'before_first_reminder_time', currentWeek };
  }

  // Dog is missing this week's check-in. Check if we've already alerted recently.
  const { data: recentAlert } = await supabase
    .from('churn_flags')
    .select('id, created_at')
    .eq('dog_id', dog.id)
    .eq('week_number', currentWeek)
    .order('created_at', { ascending: false })
    .limit(1);

  // Skip if already alerted this week
  if (recentAlert && recentAlert.length > 0) {
    const alertedAt = new Date(recentAlert[0].created_at);
    const hoursSinceAlert = (now - alertedAt) / (1000 * 60 * 60);
    if (hoursSinceAlert < 24) {
      console.log(`⏭️  ${dog.dog_name}: already emailed ${Math.round(hoursSinceAlert)}h ago`);
      return { skipped: true, reason: 'recently_alerted', currentWeek };
    }
  }

  // Resolve who gets the email — the manual test endpoint overrides this to
  // SENDGRID_FROM_EMAIL, so a real dog's owner is never emailed by a test
  // run. The real cron leaves this null and falls back to the dog's own
  // email on file, skipping (dogs created before the email field existed
  // won't have one) rather than sending to nobody.
  const ownerEmail = emailOverride || dog.email;
  if (!ownerEmail) {
    console.warn(`⚠️ ${dog.dog_name} has no email on file — skipping churn alert email`);
    return { skipped: true, reason: 'no_email', currentWeek };
  }

  // Get last check-in to show context
  const { data: lastCheckin } = await supabase
    .from('mobility_checkins')
    .select('mobility_score, created_at')
    .eq('dog_id', dog.id)
    .order('created_at', { ascending: false })
    .limit(1);

  const lastScore = lastCheckin?.[0]?.mobility_score || dog.baseline_mobility_score;
  // null (not dog.created_at) when there's no real check-in yet — see
  // sendChurnAlertEmail, which now branches on this instead of citing the
  // signup date as if it were a check-in date.
  const lastCheckInDate = lastCheckin?.[0]?.created_at || null;

  // Send churn alert email
  const emailResult = await sendChurnAlertEmail(ownerEmail, dog.dog_name, lastScore, lastCheckInDate, dog.id);

  // sendChurnAlertEmail returns undefined if SendGrid isn't configured at
  // all, or { success: false, error } if the send itself failed (e.g. the
  // SendGrid 403s seen during today's testing). Either way, this must not
  // be logged as a success and must NOT write a churn_flags row — a failed
  // send isn't "already alerted," and writing the flag anyway would block a
  // legitimate retry on the next churn-detection pass, i.e. a real owner
  // could silently never get re-engaged while the system insists it worked.
  if (!emailResult || !emailResult.success) {
    const reason = emailResult?.error || 'SendGrid not configured';
    console.error(`❌ Churn alert email FAILED for ${dog.dog_name}: ${reason}`);
    return { skipped: false, alertSent: false, reason: 'email_failed', currentWeek };
  }

  // Log the alert to churn_flags table
  const { error: flagError } = await supabase
    .from('churn_flags')
    .insert({
      dog_id: dog.id,
      week_number: currentWeek
    });

  if (flagError) {
    console.error(`Error logging churn flag for ${dog.dog_name}:`, flagError);
  } else {
    console.log(`✅ Churn alert email sent for ${dog.dog_name} (week ${currentWeek})`);
  }

  return { skipped: false, alertSent: true, currentWeek };
}

// Get next Tuesday at a specific time
function getNextTuesday() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysUntilTuesday = (2 - dayOfWeek + 7) % 7 || 7;
    const nextTuesday = new Date(now);
    nextTuesday.setDate(nextTuesday.getDate() + daysUntilTuesday);
    nextTuesday.setHours(14, 0, 0, 0); // Default 2pm (afternoon)
    return nextTuesday;
}

// ============================================
// PERSONALIZED REMINDER SCHEDULING (STEP 26)
// Calculates next reminder based on user's submission day + personalized time
// Weekday (M-F): 7:30 AM | Weekend (Sat-Sun): 2:00 PM
// ============================================

// Get day name from day of week number
function getDayName(dayOfWeek) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[dayOfWeek];
}

// Calculate next reminder date (7 days from submission, same day, at personalized time)
function getNextReminderDate(submissionDayOfWeek, reminderTime) {
    // reminderTime format: "07:30" or "14:00"
    const [hours, minutes] = reminderTime.split(':').map(Number);

    // Start from 7 days from now
    const nextReminder = new Date();
    nextReminder.setDate(nextReminder.getDate() + 7);

    // Adjust to the same day of week as submission day
    const nextDayOfWeek = nextReminder.getDay();
    const daysToAdjust = (submissionDayOfWeek - nextDayOfWeek + 7) % 7;

    if (daysToAdjust !== 0) {
        nextReminder.setDate(nextReminder.getDate() + daysToAdjust);
    }

    // Set the time
    nextReminder.setHours(hours, minutes, 0, 0);

    return nextReminder;
}

// Get enrichment type for week
function getEnrichmentForWeek(week) {
    const enrichments = {
        1: 'enrichment_p3',  // Typical day
        2: 'enrichment_p5',  // Primary goal
        3: 'enrichment_p6',  // Peer comparison
        4: 'enrichment_p7'   // Network context
    };
    return enrichments[week] || null;
}

// Get enrichment SMS message
function getEnrichmentMessage(enrichmentType) {
    const messages = {
        'enrichment_p3': 'Bonus question: Describe a typical day for [PetName]. What activities happen morning, afternoon, evening?',
        'enrichment_p5': 'Bonus question: What\'s your main goal for [PetName]\'s health? (1) reduce pain, (2) increase activity, (3) monitor, (4) post-surgery, (5) weight mgmt',
        'enrichment_p6': 'Bonus question: Would you like to see how [PetName] compares to other [Breed], similar age? (Yes/No)',
        'enrichment_p7': 'Bonus question: Do you know other dogs with similar issues? (1) no others, (2) household, (3) friend group, (4) at vet'
    };
    return messages[enrichmentType] || '';
}

// ============================================
// CHURN DETECTION CRON JOB (Runs every 60 minutes)
// STEP 10 - Detects dogs missing check-ins and sends alerts
// ============================================
console.log('⏰ Churn detection interval scheduled (1 minute for testing)');
setInterval(async () => {
  try {
    console.log('🔍 Churn detection running...');

    // Get all senior dogs
    const { data: allDogs, error: dogsError } = await supabase
      .from('senior_dogs')
      .select('id, dog_name, phone, email, sms_consent, baseline_mobility_score, created_at');

    if (dogsError) {
      console.error('❌ Error fetching senior dogs:', dogsError.message);
      return;
    }

    if (!allDogs || allDogs.length === 0) {
      console.log('ℹ️ No dogs found for churn detection');
      return;
    }

    console.log(`📊 Checking ${allDogs.length} dogs for missing check-ins...`);

    // For each dog, run the shared churn-check (baseline-period fix,
    // this-week-checkin check, SMS reminders, dedup, and email) — see
    // processDogForChurn above.
    for (const dog of allDogs) {
      try {
        await processDogForChurn(dog, { sendSmsReminders: true });
      } catch (dogError) {
        console.error(`Error processing dog ${dog.id}:`, dogError.message);
      }
    }

    console.log('✅ Churn detection cycle complete');

  } catch (error) {
    console.error('❌ Error in churn detection cron:', error);
  }
}, 60 * 60 * 1000); // Run every 60 minutes (production)

// ============================================
// SMS CRON JOB (Runs every 60 seconds)
// Automatically sends pending SMS messages
// ============================================
setInterval(async () => {
    try {
        const { data: pending } = await supabase
            .from('sms_queue')
            .select(`id, pet_id, phone, message_body`)
            .eq('status', 'pending')
            .lte('scheduled_for', new Date().toISOString())
            .limit(10);

        if (!pending || pending.length === 0) return;

        for (const msg of pending) {
            if (!msg.phone) {
                console.warn(`⚠️ No phone on queued message ${msg.id} (pet_id: ${msg.pet_id}), skipping SMS`);
                await supabase
                    .from('sms_queue')
                    .update({ status: 'failed', error_message: 'No phone number' })
                    .eq('id', msg.id);
                continue;
            }

            try {
                const sent = await twilioClient.messages.create({
                    body: msg.message_body,
                    from: TWILIO_PHONE_NUMBER,
                    to: msg.phone
                });

                await supabase
                    .from('sms_queue')
                    .update({
                        status: 'sent',
                        twilio_sid: sent.sid,
                        sent_at: new Date().toISOString()
                    })
                    .eq('id', msg.id);

                console.log(`✅ SMS sent to ${msg.phone}`);
            } catch (error) {
                console.error(`❌ Error sending SMS for message ${msg.id}:`, error.message);
                await supabase
                    .from('sms_queue')
                    .update({
                        status: 'failed',
                        error_message: error.message
                    })
                    .eq('id', msg.id);
            }
        }
    } catch (error) {
        console.error('Error in SMS cron:', error);
    }
}, 60000); // Run every 60 seconds

// ============================================
// GET ALL DOGS (for testing/debugging)
// ============================================
app.get('/api/get-all-dogs', async (req, res) => {
  try {
    const { data: dogs, error } = await supabase
      .from('senior_dogs')
      .select('id, dog_name, breed, age, gender, baseline_mobility_score, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      total: dogs.length,
      dogs: dogs
    });
  } catch (error) {
    console.error('Error fetching dogs:', error);
    res.status(500).json({ error: 'Failed to fetch dogs' });
  }
});

// ============================================
// GET DASHBOARD DATA (JSON API for client-side rendering)
// ============================================
app.get('/api/get-dog-dashboard/:dog_id', async (req, res) => {
  try {
    const { dog_id } = req.params;

    // Fetch dog info
    const { data: dog, error: dogError } = await supabase
      .from('senior_dogs')
      .select('*')
      .eq('id', dog_id)
      .single();

    if (dogError || !dog) {
      return res.status(404).json({ error: 'Dog not found', dog_id });
    }

    // Fetch all check-ins for this dog
    const { data: checkins, error: checkinsError } = await supabase
      .from('mobility_checkins')
      .select('*')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: true });

    if (checkinsError) {
      throw checkinsError;
    }

    // If no check-ins, return dog info with empty checkins
    if (!checkins || checkins.length === 0) {
      return res.json({
        dog: {
          id: dog.id,
          dog_name: dog.dog_name,
          breed: dog.breed,
          age: dog.age,
          gender: dog.gender,
          baseline_mobility_score: dog.baseline_mobility_score,
          created_at: dog.created_at
        },
        checkins: [],
        currentScore: null,
        comparisonData: []
      });
    }

    // Calculate metrics
    const currentScore = checkins[checkins.length - 1].mobility_score;
    const currentWeek = Math.ceil(checkins.length / 7); // Approximate week

    // Build chart data for line chart (all checkins)
    const chartData = checkins.map((c, idx) => ({
      week: Math.ceil((idx + 1) / 7),
      score: c.mobility_score,
      date: new Date(c.created_at).toLocaleDateString()
    }));

    // Get comparison data (similar dogs - anonymized)
    // For now, simulate with random data since we don't have other dogs' data
    const comparisonData = chartData.map(d => ({
      week: d.week,
      similar: Math.round((d.score + Math.random() * 2 - 1) * 10) / 10 // Slight variation
    }));

    return res.json({
      dog: {
        id: dog.id,
        dog_name: dog.dog_name,
        breed: dog.breed,
        age: dog.age,
        gender: dog.gender,
        baseline_mobility_score: dog.baseline_mobility_score,
        created_at: dog.created_at
      },
      checkins: checkins,
      currentScore: currentScore,
      currentWeek: currentWeek,
      chartData: chartData,
      comparisonData: comparisonData,
      lastCheckIn: new Date(checkins[checkins.length - 1].created_at).toLocaleDateString()
    });

  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// ============================================
// 404 HANDLER (must be last)
// ============================================
app.use((req, res) => {
    res.status(404).json({ error: 'Page not found' });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`\n✅ CompanionCommons Server Running`);
    console.log(`📍 Web:   ${BASE_URL}`);
    console.log(`🎯 Admin: ${BASE_URL}/admin`);
    console.log(`📊 API:   ${BASE_URL}/api/signups`);
    console.log(`\n🗄️  Survey data now saves to Supabase (not signups.json)`);
    console.log(`💬 SMS cron running (sends pending SMS every 60 seconds)\n`);
});
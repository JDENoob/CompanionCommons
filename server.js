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
const SHEET_ID = '1MSej8ul_HvjpVSL2CoRxxEgse1VILoJv3eFV02AYQnk';
let sheetsClient = null;

// Find and load Google service account key
function loadGoogleSheetsAuth() {
  try {
    // Look for JSON key file in project root
    const files = fs.readdirSync('./');
    const keyFile = files.find(f => f.endsWith('.json') && f.includes('companioncommons'));

    if (!keyFile) {
      console.warn('⚠️ Google Sheets key file not found. Skipping Google Sheets integration.');
      return null;
    }

    const keyPath = path.join('./', keyFile);

    // Read and parse JSON file properly
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

    const auth = new google.auth.GoogleAuth({
      credentials: keyData,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log(`✅ Google Sheets authenticated (${keyFile})`);
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
        <h1>🎯 CompanionCommons Admin</h1>

        <div id="login">
            <h2>Login</h2>
            <input type="password" id="password" placeholder="Enter admin password">
            <button onclick="checkPassword()">Login</button>
        </div>

        <div id="admin" style="display:none;">
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

            <button onclick="savePage()">💾 Save Changes</button>
        </div>
    </div>

    <script>
        const PASSWORD = 'Beauregard123110!!';

        function checkPassword() {
            if (document.getElementById('password').value === PASSWORD) {
                document.getElementById('login').style.display = 'none';
                document.getElementById('admin').style.display = 'block';
                loadPage();
            } else {
                alert('Incorrect password');
            }
        }

        function logout() {
            document.getElementById('login').style.display = 'block';
            document.getElementById('admin').style.display = 'none';
            document.getElementById('password').value = '';
        }

        async function loadPage() {
            const page = document.getElementById('page').value;
            try {
                const res = await fetch('/api/page/' + page);
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
                showMessage('Saved successfully!', 'success');
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
    </script>
</body>
</html>`);
});

// ============================================
// PAGE CONTENT API (UNCHANGED)
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
async function appendToGoogleSheets(data) {
  if (!sheetsClient) {
    console.log('ℹ️ Google Sheets not connected, skipping export');
    return;
  }

  try {
    const now = new Date().toISOString();
    const values = [
      [
        now,                          // timestamp
        data.email || '',             // email
        data.petName || '',           // petName
        data.breed || '',             // breed
        data.age || '',               // age
        data.mobility || '',          // mobility
        '',                           // week (empty for signup)
        '',                           // trend (empty for signup)
        data.observations || ''       // observations
      ]
    ];

    // First, get the sheet ID for Sheet1
    const spreadsheet = await sheetsClient.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });

    const sheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Sheet1');
    if (!sheet) {
      throw new Error('Sheet1 not found in spreadsheet');
    }

    const sheetId = sheet.properties.sheetId;

    // Append using batchUpdate
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [
          {
            appendCells: {
              sheetId: sheetId,
              rows: [
                {
                  values: values[0].map(v => ({ userEnteredValue: { stringValue: String(v) } }))
                }
              ],
              fields: 'userEnteredValue'
            }
          }
        ]
      }
    });

    console.log(`✅ Survey data exported to Google Sheets for ${data.email}`);
  } catch (error) {
    console.error('⚠️ Failed to export to Google Sheets:', error.message);
    if (error.errors) {
      console.error('   API Errors:', error.errors);
    }
    if (error.config) {
      console.error('   Request URL:', error.config.url);
    }
  }
}

// ============================================
// PHASE 0: SIGNUP (Day 0 Progressive Profiling)
// NEW: Saves to Supabase instead of signups.json
// ============================================
app.post('/api/signup', async (req, res) => {
    try {
        const {
            email,
            phone,
            companionName,
            birthday,
            breed,
            gender,
            health,
            activity,
            treatments,
            treatmentNames,
            consent,
            smsConsent,
            preferredSmsTime,
            smsFrequency
        } = req.body;

        // ============================================
        // INPUT SANITIZATION (AFTER VALIDATION)
        // ============================================
        const sanitizedEmail = sanitizeEmail(email);
        const sanitizedCompanionName = sanitizeName(companionName);
        const sanitizedPhone = phone ? sanitizePhone(phone) : null;
        const sanitizedBreed = breed ? sanitizeName(breed, 50) : null;
        const sanitizedGender = gender ? sanitizeSelect(gender, ['male', 'female', 'unknown', '']) : null;
        const sanitizedTreatmentNames = treatmentNames ? sanitizeArray([treatmentNames]).join(', ') : null;
        const sanitizedPreferredSmsTime = preferredSmsTime ? sanitizeSelect(preferredSmsTime, ['morning', 'afternoon', 'evening', '']) : 'afternoon';
        const sanitizedSmsFrequency = smsFrequency ? sanitizeSelect(smsFrequency, ['1x_per_week', '2x_per_week', 'daily', '']) : '1x_per_week';

        // Parse birthday format (MM/DD/YYYY or MM/YYYY) to YYYY-MM-DD
        let formattedBirthday = null;
        if (birthday) {
            const parts = birthday.split('/');

            // Helper to convert 2-digit year to 4-digit
            const formatYear = (yr) => {
                if (yr.length === 2) {
                    const numYear = parseInt(yr);
                    return numYear > 30 ? `19${yr}` : `20${yr}`;
                }
                return yr;
            };

            if (parts.length === 3) {
                // MM/DD/YYYY format
                const [month, day, year] = parts;
                formattedBirthday = `${formatYear(year)}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
            } else if (parts.length === 2) {
                // MM/YYYY format - assume mid-month
                const [month, year] = parts;
                formattedBirthday = `${formatYear(year)}-${month.padStart(2, '0')}-15`;
            }
        }

        // ============================================
        // SERVER-SIDE VALIDATION (SECURITY CRITICAL)
        // ============================================

        // Validate required fields
        if (!email || !companionName || !consent) {
            return res.status(400).json({ error: 'Missing required fields: email, companionName, consent' });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Companion name validation
        if (companionName.trim().length === 0) {
            return res.status(400).json({ error: 'Companion name cannot be empty' });
        }
        if (companionName.length > 100) {
            return res.status(400).json({ error: 'Companion name must be 100 characters or less' });
        }

        // Phone validation (if provided)
        if (phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            // Must be 10 digits (US) or 11+ digits (international)
            if (cleanPhone.length < 10 || cleanPhone.length > 15) {
                return res.status(400).json({ error: 'Invalid phone number format' });
            }
        }

        // Birthday validation (if provided)
        if (birthday) {
            const parts = birthday.split('/');
            if (parts.length !== 2 && parts.length !== 3) {
                return res.status(400).json({ error: 'Birthday must be MM/YYYY or MM/DD/YYYY format' });
            }

            const month = parseInt(parts[0]);
            if (month < 1 || month > 12) {
                return res.status(400).json({ error: 'Birthday month must be 01-12' });
            }

            if (parts.length === 3) {
                const day = parseInt(parts[1]);
                if (day < 1 || day > 31) {
                    return res.status(400).json({ error: 'Birthday day must be 01-31' });
                }
            }

            // Validate year is reasonable (1900-current year)
            const year = parts[parts.length - 1];
            const fourDigitYear = year.length === 2
                ? (parseInt(year) > 30 ? `19${year}` : `20${year}`)
                : year;
            const birthYear = parseInt(fourDigitYear);
            const currentYear = new Date().getFullYear();
            if (birthYear < 1900 || birthYear > currentYear) {
                return res.status(400).json({ error: 'Birthday year must be between 1900 and current year' });
            }
        }

        // Breed validation (if provided)
        if (breed && (typeof breed !== 'string' || breed.trim().length === 0)) {
            return res.status(400).json({ error: 'Breed must be a non-empty string' });
        }

        // Gender validation (if provided)
        const validGenders = ['male', 'female', 'unknown', ''];
        if (gender && !validGenders.includes(gender.toLowerCase())) {
            return res.status(400).json({ error: 'Gender must be male, female, or unknown' });
        }

        // Health score validation (1-8 scale)
        if (health !== undefined && health !== null) {
            const healthScore = parseInt(health);
            if (isNaN(healthScore) || healthScore < 1 || healthScore > 8) {
                return res.status(400).json({ error: 'Health score must be a number between 1 and 8' });
            }
        }

        // Activity score validation (1-8 scale)
        if (activity !== undefined && activity !== null) {
            const activityScore = parseInt(activity);
            if (isNaN(activityScore) || activityScore < 1 || activityScore > 8) {
                return res.status(400).json({ error: 'Activity score must be a number between 1 and 8' });
            }
        }

        // Consent validation (must be true)
        if (consent !== true && consent !== 'true') {
            return res.status(400).json({ error: 'Consent must be given to proceed' });
        }

        // SMS Consent validation (if provided, must be boolean-like)
        if (smsConsent !== undefined && smsConsent !== null && smsConsent !== true && smsConsent !== false && smsConsent !== 'true' && smsConsent !== 'false') {
            return res.status(400).json({ error: 'SMS consent must be true or false' });
        }

        // STEP 1: Create or get user
        let { data: user, error: userError } = await supabase
            .from('users')
            .select('id')
            .eq('email', sanitizedEmail)
            .single();

        if (userError && userError.code !== 'PGRST116') {
            throw userError;
        }

        let userId;
        if (!user) {
            // Create new user
            const { data: newUser, error: createError } = await supabase
                .from('users')
                .insert([{ email: sanitizedEmail, phone: sanitizedPhone, status: 'active' }])
                .select('id')
                .single();

            if (createError) throw createError;
            userId = newUser.id;
            console.log(`✅ User created: ${email}`);
        } else {
            userId = user.id;
            console.log(`✅ User found: ${email}`);
        }

        // STEP 2: Create pet profile
        const { data: pet, error: petError } = await supabase
            .from('pets')
            .insert([{
                user_id: userId,
                name: sanitizedCompanionName,
                breed: sanitizedBreed,
                birthday: formattedBirthday,
                birthday_estimated: req.body.birthdayEstimated || false,
                gender: sanitizedGender
            }])
            .select('id')
            .single();

        if (petError) throw petError;
        const petId = pet.id;
        console.log(`✅ Pet created: ${companionName}`);

        // STEP 3: Save Phase 0 baseline survey
        const { error: baselineError } = await supabase
            .from('survey_baselines')
            .insert([{
                pet_id: petId,
                user_id: userId,
                health_score: parseInt(health),
                activity_score: parseInt(activity),
                treatments: Array.isArray(treatments) ? treatments : [treatments],
                treatment_names: sanitizedTreatmentNames || null,
                consent_given: consent === true || consent === 'true',
                consent_timestamp: new Date().toISOString()
            }]);

        if (baselineError) throw baselineError;
        console.log(`✅ Baseline survey saved for pet: ${petId}`);

        // STEP 4: Save SMS preferences (upsert to handle existing users)
        const { error: smsError } = await supabase
            .from('sms_preferences')
            .upsert([{
                user_id: userId,
                preferred_time: sanitizedPreferredSmsTime,
                frequency: sanitizedSmsFrequency,
                sms_consent_given: smsConsent === true || smsConsent === 'true',
                sms_consent_timestamp: new Date().toISOString()
            }], { onConflict: 'user_id' });

        if (smsError) throw smsError;
        console.log(`✅ SMS preferences saved for user: ${userId}`);

        // STEP 5: Queue first SMS (Week 1 check-in at default time - Wednesday 2pm, THIS WEEK)
        // For initial signup: send first check-in reminder on upcoming Wednesday at 2:00 PM
        // After first check-in, reminders personalize to user's actual submission time
        const today = new Date();
        const todayDay = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const wednesdayDay = 3;

        // Calculate days until next Wednesday (but this week if possible)
        let daysUntilWednesday = (wednesdayDay - todayDay + 7) % 7;
        if (daysUntilWednesday === 0) daysUntilWednesday = 7; // If today is Wednesday, schedule for next week

        const firstCheckInReminder = new Date(today);
        firstCheckInReminder.setDate(firstCheckInReminder.getDate() + daysUntilWednesday);
        firstCheckInReminder.setHours(14, 0, 0, 0); // 2:00 PM

        const { error: queueError } = await supabase
            .from('sms_queue')
            .insert([{
                user_id: userId,
                pet_id: petId,
                message_type: 'week_1_checkin',
                scheduled_for: firstCheckInReminder.toISOString(),
                message_body: `Hi! 👋 Welcome to ${sanitizedCompanionName}'s health journey. How is ${sanitizedCompanionName} moving this week? (Reply with a number 1-8, where 1 is very stiff and 8 is moving great)`,
                status: 'pending'
            }]);

        if (queueError) throw queueError;
        console.log(`✅ SMS queued for ${email} at ${firstCheckInReminder.toLocaleString()} (${getDayName(firstCheckInReminder.getDay())} 2:00 PM)`);

        // STEP 6: Send immediate welcome SMS
        if (sanitizedPhone && (smsConsent === true || smsConsent === 'true')) {
            // Check SMS rate limit
            const smsLimit = smsRateLimit(userId);
            if (!smsLimit.allowed) {
                console.warn(`⚠️ SMS rate limit exceeded for user ${userId}`);
            } else {
                try {
                    // Personalized welcome message based on whether they selected a preferred time
                    let welcomeMessage;
                    if (sanitizedPreferredSmsTime && sanitizedPreferredSmsTime !== '') {
                        // Message for users who selected a preferred time
                        welcomeMessage = `Welcome to CompanionCommons! 🐾 We're excited to follow ${sanitizedCompanionName}'s health journey with you. We see you selected ${sanitizedPreferredSmsTime} for ${sanitizedCompanionName}'s health journey update. You should receive the first update request in 7 days!!`;
                    } else {
                        // Message for users who didn't select a time
                        welcomeMessage = `Welcome to CompanionCommons! 🐾 We're excited to follow ${sanitizedCompanionName}'s health journey with you. ${sanitizedCompanionName}'s first health journey reminder should arrive in 7 days. After ${sanitizedCompanionName}'s first update, we personalize the timing to fit your schedule.`;
                    }

                    await twilioClient.messages.create({
                        body: welcomeMessage,
                        from: TWILIO_PHONE_NUMBER,
                        to: sanitizedPhone
                    });
                    console.log(`✅ Welcome SMS sent to ${sanitizedPhone}`);
                } catch (smsError) {
                    console.error('Error sending welcome SMS:', smsError);
                }
            }
        }

        // STEP 7: Export survey data to Google Sheets
        await appendToGoogleSheets({
            email: sanitizedEmail,
            petName: sanitizedCompanionName,
            breed: sanitizedBreed,
            age: birthday ? new Date().getFullYear() - parseInt(formattedBirthday.split('-')[0]) : '',
            mobility: health || '',
            observations: ''
        });

        // Response
        res.status(200).json({
            success: true,
            message: 'Welcome to CompanionCommons! Your first check-in SMS will arrive on Tuesday.',
            data: {
                user_id: userId,
                pet_id: petId,
                email: sanitizedEmail,
                pet_name: sanitizedCompanionName
            }
        });

    } catch (error) {
        console.error('Error processing signup:', error);
        res.status(500).json({ error: 'Error processing signup', details: error.message });
    }
});

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

    // Get the latest check-in for comparison
    const { data: latestCheckin } = await supabase
      .from('mobility_checkins')
      .select('mobility_score, energy_score, appetite_score, week_number')
      .eq('dog_id', dog_id)
      .order('created_at', { ascending: false })
      .limit(1);

    const latestScore = latestCheckin?.[0]?.mobility_score || null;
    const latestEnergy = latestCheckin?.[0]?.energy_score || null;
    const latestAppetite = latestCheckin?.[0]?.appetite_score || null;

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
          <h2>📱 ${dog.dog_name}'s Check-In</h2>
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
              value="4"
            >
            <div class="hint" id="cognitiveHint">4/8 - Average alertness</div>
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
                  observation: formData.get('observation') || null
                })
              });

              const result = await response.json();

              if (result.success) {
                document.body.innerHTML = \`
                  <div class="card" style="text-align: center;">
                    <h2 style="color: green;">✅ Check-In Submitted!</h2>
                    <p style="font-size: 18px; color: #007AFF; margin: 20px 0;">
                      ${dog.dog_name}'s mobility: \${result.mobility_score}/8
                    </p>
                    <p style="font-size: 14px; color: #666; margin: 20px 0;">
                      \${result.change_text}
                    </p>
                    <p style="font-size: 12px; color: #999;">
                      You'll get SMS updates each week. Thanks for tracking!
                    </p>
                  </div>
                \`;
              } else {
                alert('Error: ' + (result.error || 'Unknown error'));
              }
            } catch (error) {
              console.error('Error:', error);
              alert('Error submitting check-in. Please try again.');
            }
          });
        </script>
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
      `No major changes for ${dogName} this week — steady is good data too. Keep the check-ins coming.`,
      `${dogName} looks about the same as last week. That stability itself is useful to track over time.`
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
    `${dogName}'s ${biggest.label} is down ${absDiff} point${absDiff > 1 ? 's' : ''} from last week. Nothing to panic about from one data point — but worth watching next week.`,
    `Heads up: ${dogName}'s ${biggest.label} dropped ${absDiff} point${absDiff > 1 ? 's' : ''} since last week. Keep logging so you can see if it's a trend or a one-off.`,
    `${dogName}'s ${biggest.label} was a bit lower this week (-${absDiff}). One week alone isn't a pattern — tracking it is how you'll know.`
  ];

  const variants = direction === 'up' ? upVariants : downVariants;
  return variants[Math.floor(Math.random() * variants.length)];
}

app.post('/api/checkin-senior', async (req, res) => {
  try {
    const { dog_id, mobility_score, energy_score, appetite_score, cognitive_score, observation } = req.body;

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

    // Calculate week number based on when dog was created
    const created = new Date(dog.created_at);
    const now = new Date();
    const weekNumber = Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1;

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
        observation: observation || null,
        segment: segment
      });

    if (saveError) throw saveError;

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
          message_body: `${dog.dog_name}'s #${weekNumber + 1} week check-in time! Click here to complete a 30-second update: ${nextCheckinLink}`,
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
    const changeText = generatePostLogInsight(
      dog.dog_name,
      {
        mobility: mobilityScoreInt,
        energy: energyScoreInt,
        appetite: appetiteScoreInt,
        cognitive: cognitiveScoreInt // null on non-4th weeks, that's fine — diff just skips it
      },
      {
        mobility: prevRow?.mobility_score ?? dog.baseline_mobility_score,
        energy: prevRow?.energy_score ?? dog.baseline_energy_score,
        appetite: prevRow?.appetite_score ?? dog.baseline_appetite_score,
        cognitive: prevRow?.cognitive_score ?? dog.baseline_cognitive_score
      }
    );

    console.log(`✅ Week ${weekNumber} check-in saved for ${dog.dog_name}`);

    res.json({
      success: true,
      mobility_score: mobilityScoreInt,
      change_text: changeText,
      week_number: weekNumber,
      segment: segment
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

    // If no check-ins yet, show empty state
    if (!checkins || checkins.length === 0) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${dog.dog_name}'s Dashboard</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
            .card { background: white; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            h1 { color: #333; margin-bottom: 20px; }
            p { color: #666; font-size: 16px; line-height: 1.6; }
            .cta { background: #007AFF; color: white; padding: 15px 30px; border-radius: 8px; text-decoration: none; display: inline-block; margin-top: 20px; font-weight: 600; }
            .cta:hover { background: #0051D5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>📊 ${dog.dog_name}'s Mobility Dashboard</h1>
            <p style="font-size: 48px; margin: 20px 0;">📝</p>
            <p>No check-ins recorded yet. Start tracking ${dog.dog_name}'s mobility to see insights here.</p>
            <a href="/check-in/${dog_id}" class="cta">Record First Check-In</a>
          </div>
        </body>
        </html>
      `);
    }

    // Calculate metrics
    const currentScore = checkins[checkins.length - 1].mobility_score;
    const previousScore = checkins.length > 1
      ? checkins[checkins.length - 2].mobility_score
      : dog.baseline_mobility_score;

    const scoreDiff = currentScore - previousScore;
    const trend = scoreDiff > 0 ? 'up' : scoreDiff < 0 ? 'down' : 'flat';
    const trendEmoji = trend === 'up' ? '📈' : trend === 'down' ? '📉' : '➡️';
    const trendText = trend === 'up' ? 'Improving' : trend === 'down' ? 'Declining' : 'Stable';
    const trendColor = trend === 'up' ? '#4CAF50' : trend === 'down' ? '#FF6B6B' : '#FFC107';

    // Calculate streak (consecutive weeks with check-ins)
    let streak = 0;
    const sortedByWeek = [...checkins].sort((a, b) => b.week_number - a.week_number);
    const maxWeek = sortedByWeek[0].week_number;
    for (let i = maxWeek; i >= 1; i--) {
      const hasWeek = checkins.some(c => c.week_number === i);
      if (hasWeek) {
        streak++;
      } else {
        break;
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
    const chartScores = checkins.map(c => c.mobility_score);
    const chartWeeks = checkins.map(c => `W${c.week_number}`);

    // Latest energy/appetite for pre-filling the check-in modal sliders
    const latestCheckinRow = checkins[checkins.length - 1];
    const latestEnergyScore = latestCheckinRow?.energy_score || 4;
    const latestAppetiteScore = latestCheckinRow?.appetite_score || 4;

    // Calculate the actual current week (matches /api/checkin-senior's calculation)
    // so we know whether to show the every-4th-week cognitive/behavior slider.
    const dogCreatedAt = new Date(dog.created_at);
    const dashboardNow = new Date();
    const nextCheckinWeekNumber = Math.max(1, Math.floor((dashboardNow - dogCreatedAt) / (7 * 24 * 60 * 60 * 1000)) + 1);
    const showCognitiveThisWeek = nextCheckinWeekNumber % 4 === 0;

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
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
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
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
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
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
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
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
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
            border-radius: 8px;
            border: 1px solid #E8E4DA;
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
            border-radius: 8px;
            margin-top: 15px;
            border: 1px solid #E8E4DA;
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
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 11px;
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

          <div class="header">
            <h1>📊 ${dog.dog_name}'s Mobility Dashboard</h1>
            <p>${dog.breed || ''} • ${dog.age || 'Age unknown'} years old • ${dog.gender || 'Gender unknown'}</p>
            <div class="week-progress">
              <span>Week ${checkins[checkins.length - 1].week_number} of 12</span>
              <div class="week-dots">
                ${Array.from({length: 12}, (_, i) => {
                  const weekNum = i + 1;
                  const isCompleted = weekNum <= checkins[checkins.length - 1].week_number;
                  return `<div class="week-dot ${isCompleted ? 'completed' : ''}"></div>`;
                }).join('')}
              </div>
            </div>
          </div>

          <div class="dashboard-layout">
            <!-- LEFT COLUMN: DOG INFO + CHARTS -->
            <div>
              <div class="baseline-card">
                <div style="display: flex; gap: 15px; align-items: flex-start; margin-bottom: 20px;">
                  <div class="baseline-photo">
                    ${dog.photo_url
                      ? `<img src="${dog.photo_url}" alt="${dog.dog_name}" />`
                      : `<div class="baseline-photo-placeholder">🐕</div>`
                    }
                  </div>
                  <div style="flex: 1;">
                    <h2 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 500; color: #2C2C2C;">${dog.dog_name}'s Health Journey</h2>
                    <p style="margin: 0 0 12px 0; font-size: 13px; color: #999; font-weight: 400;">${dog.breed || 'Breed unknown'} • ${dog.age || 'Age unknown'} years old • ${dog.gender || 'Gender unknown'}</p>
                    <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                      <form id="quickPhotoUpload" style="display: flex; gap: 4px; align-items: center;">
                        <input type="file" id="quickPhotoInput" accept="image/*" style="padding: 4px 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 11px; width: 100px;">
                        <button type="submit" class="btn-secondary">📷 Update ${dog.dog_name}'s Photo</button>
                      </form>
                      <button id="openCheckInBtn" class="btn-primary" style="white-space: nowrap; padding: 8px 16px;">
                        Share This Week's Update
                      </button>
                    </div>
                  </div>
                </div>
                <div class="baseline-info">
                  <div class="baseline-info-grid">
                    <div class="baseline-info-item">
                      <div class="baseline-info-label">Baseline Score</div>
                      <div class="baseline-info-value">${dog.baseline_mobility_score}/8</div>
                    </div>
                    <div class="baseline-info-item">
                      <div class="baseline-info-label">Weeks Tracked</div>
                      <div class="baseline-info-value">${streak}w</div>
                    </div>
                  </div>
                  ${dog.baseline_notes ? `
                  <div class="baseline-notes">
                    <p><strong>Notes:</strong> ${dog.baseline_notes}</p>
                  </div>
                  ` : ''}
                </div>
              </div>

              <div class="chart-card">
                <h2>Mobility observations over time</h2>
                <canvas id="mobilityChart"></canvas>
              </div>

              <div class="peer-card">
                <h2>How ${dog.dog_name} compares with similar ${dog.breed || 'dogs'}</h2>
                <div class="peer-stat">
                  <span class="peer-stat-label">Your dog's rank</span>
                  <span class="peer-stat-value">#${rank} / ${totalDogs}</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Peer average score</span>
                  <span class="peer-stat-value">${peerAverage}/8</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Status</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #A89968; font-weight: 600;">🎯 ${currentScore > peerAverage ? 'Above average!' : currentScore === parseFloat(peerAverage) ? 'At average' : 'Below average'}</span>
                </div>
              </div>
            </div>

            <!-- MIDDLE COLUMN: SUMMARY -->
            <div>
              <div class="peer-card">
                <h2>This week at a glance</h2>
                <div class="peer-stat">
                  <span class="peer-stat-label">Walking comfort</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">has remained consistent</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Getting up after rest</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">has been more difficult for two weeks</span>
                </div>
                <div class="peer-stat">
                  <span class="peer-stat-label">Active days</span>
                  <span class="peer-stat-value" style="font-size: 14px; color: #555;">fewer this week</span>
                </div>
              </div>
            </div>

          </div>

          <!-- BOTTOM SECTION: INFO & SUMMARY -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px;">
            <div style="background: #FAFAF8; border-radius: 12px; padding: 18px; border-left: 4px solid #D4AF88;">
              <p style="margin: 0; font-size: 13px; color: #2C2C2C; line-height: 1.6;">
                Based on anonymized observations from participating ${dog.breed || 'dogs'} of a similar age. For context only—not a diagnosis or veterinary assessment.<br>
                For context only—not a diagnosis or veterinary assessment.
              </p>
            </div>

            <div style="background: #FAFAF8; border-radius: 12px; padding: 18px; border-left: 4px solid #D4AF88;">
              <div style="display: flex; align-items: flex-start; gap: 12px;">
                <span style="font-size: 20px; flex-shrink: 0;">❓</span>
                <div>
                  <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 500; color: #2C2C2C;">Prepare for a conversation with [dog_name]'s vet, family, babysitter etc.</p>
                  <p style="margin: 0; font-size: 13px; color: #2C2C2C;">Review recent notes and highlights to help you share what matters most.</p>
                </div>
              </div>
            </div>
          </div>

          <div style="display: flex; gap: 15px; margin-bottom: 30px;">
            <button id="viewSummaryBtn" style="flex: 1; background: #A89968; color: white; border: none; padding: 16px 20px; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer;">
              View ${dog.dog_name}'s Journey Summary
            </button>
          </div>
        </div>

        <!-- CHECK-IN MODAL -->
        <div id="checkInModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; overflow-y: auto;">
          <div style="background: white; margin: 20px auto; border-radius: 12px; padding: 30px; max-width: 500px; position: relative; top: 50px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
              <h2 style="margin: 0; color: #333;">📝 ${dog.dog_name}'s Check-In</h2>
              <button id="closeCheckInBtn" style="background: none; border: none; font-size: 24px; cursor: pointer;">✕</button>
            </div>

            <form id="checkInForm">
              <label style="display: block; margin: 15px 0 5px 0; font-weight: 500; color: #333;">How's ${dog.dog_name}'s mobility this week?</label>
              <input type="range" id="mobility" name="mobility_score" min="1" max="8" value="4" style="width: 100%; cursor: pointer;">
              <div id="mobilityHint" style="font-size: 12px; color: #666; margin: 5px 0 0 0;">4/8 - Some good days, some bad days</div>

              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">How's ${dog.dog_name}'s energy level this week?</label>
              <input type="range" id="energy" name="energy_score" min="1" max="8" value="${latestEnergyScore}" style="width: 100%; cursor: pointer;">
              <div id="energyHint" style="font-size: 12px; color: #666; margin: 5px 0 0 0;">4/8 - Average energy</div>

              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">How's ${dog.dog_name}'s appetite this week?</label>
              <input type="range" id="appetite" name="appetite_score" min="1" max="8" value="${latestAppetiteScore}" style="width: 100%; cursor: pointer;">
              <div id="appetiteHint" style="font-size: 12px; color: #666; margin: 5px 0 0 0;">4/8 - Average appetite</div>

              ${showCognitiveThisWeek ? `
              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">How's ${dog.dog_name}'s alertness &amp; behavior this week?</label>
              <input type="range" id="cognitive" name="cognitive_score" min="1" max="8" value="4" style="width: 100%; cursor: pointer;">
              <div id="cognitiveHint" style="font-size: 12px; color: #666; margin: 5px 0 0 0;">4/8 - Average alertness</div>
              ` : ''}

              <label style="display: block; margin: 20px 0 5px 0; font-weight: 500; color: #333;">Any notes? (optional)</label>
              <textarea id="observation" name="observation" placeholder="E.g., 'Easier on stairs this week' or 'Stiff in morning'" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-family: inherit; font-size: 14px; box-sizing: border-box; height: 80px;"></textarea>

              <button type="submit" style="background: #A89968; color: white; border: none; padding: 15px; border-radius: 8px; font-size: 16px; cursor: pointer; width: 100%; margin-top: 20px; font-weight: 500;">Submit Check-In ✓</button>
            </form>
          </div>
        </div>

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

          openBtn.addEventListener('click', () => {
            modal.style.display = 'block';
          });

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

          // Journey summary button - TODO: Build summary page pulling health data/criteria
          document.getElementById('viewSummaryBtn').addEventListener('click', () => {
            alert('Journey Summary feature coming soon - will display health trends, patterns, and insights for vet conversation');
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
              datasets: [{
                label: '${dog.dog_name} Mobility Score',
                data: ${JSON.stringify(chartScores)},
                borderColor: '#667eea',
                backgroundColor: 'rgba(102, 126, 234, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 5,
                pointBackgroundColor: '#667eea',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                pointHoverRadius: 7
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              plugins: {
                legend: {
                  display: true,
                  labels: { font: { size: 12 } }
                }
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
        // Get unique users count
        const { count: foundingMembers, error: usersError } = await supabase
            .from('users')
            .select('id', { count: 'exact', head: true });

        if (usersError) throw usersError;
        const memberCount = foundingMembers || 0;

        // Get SMS opt-ins from sms_preferences table
        const { count: smsOptIns, error: smsError } = await supabase
            .from('sms_preferences')
            .select('id', { count: 'exact', head: true })
            .eq('opt_in', true);

        if (smsError) console.warn('SMS preferences query issue:', smsError);
        const smsOptInCount = smsOptIns || 0;
        const smsOptInRate = memberCount > 0 ? Math.round((smsOptInCount / memberCount) * 100) : 0;

        // Get unique pets count
        const { count: petCount, error: petsError } = await supabase
            .from('pets')
            .select('id', { count: 'exact', head: true });

        if (petsError) throw petsError;
        const petsRegistered = petCount || 0;

        // Get count of weekly check-ins (ongoing engagement data points)
        const { count: checkInCount, error: checkinsError } = await supabase
            .from('survey_weekly_checkins')
            .select('id', { count: 'exact', head: true });

        if (checkinsError) console.warn('Check-ins query issue:', checkinsError);
        const weeklyCheckIns = checkInCount || 0;

        // Total data points = baseline assessments (one per user) + weekly check-ins
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

    // For each dog, check if they're missing this week's check-in
    for (const dog of allDogs) {
      try {
        // Calculate current week number
        const created = new Date(dog.created_at);
        const currentWeek = Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1;

        // Check if dog has a check-in for this week
        const { data: thisWeekCheckin } = await supabase
          .from('mobility_checkins')
          .select('id')
          .eq('dog_id', dog.id)
          .eq('week_number', currentWeek)
          .limit(1);

        if (thisWeekCheckin && thisWeekCheckin.length > 0) {
          continue; // Has check-in this week, skip
        }

        // Check if already alerted recently
        const { data: recentAlert } = await supabase
          .from('churn_flags')
          .select('id, created_at')
          .eq('dog_id', dog.id)
          .eq('week_number', currentWeek)
          .order('created_at', { ascending: false })
          .limit(1);

        if (recentAlert && recentAlert.length > 0) {
          const alertedAt = new Date(recentAlert[0].created_at);
          const hoursSinceAlert = (now - alertedAt) / (1000 * 60 * 60);
          if (hoursSinceAlert < 24) {
            continue; // Already alerted recently
          }
        }

        // Get last check-in
        const { data: lastCheckin } = await supabase
          .from('mobility_checkins')
          .select('mobility_score, created_at')
          .eq('dog_id', dog.id)
          .order('created_at', { ascending: false })
          .limit(1);

        const lastScore = lastCheckin?.[0]?.mobility_score || dog.baseline_mobility_score;
        const lastCheckInDate = lastCheckin?.[0]?.created_at || dog.created_at;

        // Send alert
        const ownerEmail = SENDGRID_FROM_EMAIL; // Test email (sends to whatever's configured as the from-address, for easy manual testing)
        await sendChurnAlertEmail(ownerEmail, dog.dog_name, lastScore, lastCheckInDate, dog.id);

        // Log flag
        await supabase.from('churn_flags').insert({
          dog_id: dog.id,
          week_number: currentWeek
        });

        alertsSent++;
        console.log(`✅ Churn alert sent for ${dog.dog_name}`);

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
      sms_consent,
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

    // Sanitize inputs
    const cleanName = sanitizeName(dog_name);
    const cleanBreed = sanitizeName(breed);
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

    // Generate a secure random token (32 bytes = 64 hex characters)
    const token = crypto.randomBytes(32).toString('hex');

    // Token expiry: 15 minutes from now
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Store the magic link token in database
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
        sms_consent: sms_consent === 'on' || sms_consent === true,
        weight_lbs: cleanWeight,
        spayed_neutered: cleanSpayedNeutered,
        zip_code: cleanZip,
        diet_type: cleanDietType,
        pet_insurance: cleanPetInsurance,
        treatment_category: cleanTreatmentCategories,
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

    // Send SMS with magic link via Twilio
    try {
      const smsMessage = await twilioClient.messages.create({
        body: `Welcome to Companion Commons! Click here to complete ${cleanName}'s profile: ${verifyUrl}\n\nThis link expires in 15 minutes.`,
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
      phone: cleanPhone
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
              <h1>⏰ Link Expired</h1>
              <p>This verification link expired after 15 minutes. Complete the Baseline Health Journey again to get a new link.</p>
              <a href="/baseline-health-journey.html">Start Over</a>
            </div>
          </body>
        </html>
      `);
    }

    // Token is valid! Create the senior_dogs profile
    const now = new Date().toISOString();
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
        phone: tokenData.phone,
        email: tokenData.email,
        sms_consent: tokenData.sms_consent === true || tokenData.sms_consent === 'true',
        weight_lbs: tokenData.weight_lbs,
        spayed_neutered: tokenData.spayed_neutered,
        zip_code: tokenData.zip_code,
        diet_type: tokenData.diet_type,
        pet_insurance: tokenData.pet_insurance,
        treatment_category: tokenData.treatment_category,
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
      .from('dog-photos')
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
      .from('dog-photos')
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
    const daysAgo = Math.floor((Date.now() - new Date(lastCheckInDate).getTime()) / (1000 * 60 * 60 * 24));

    const msg = {
      to: ownerEmail,
      from: SENDGRID_FROM_EMAIL,
      subject: `How's ${dogName} this week? 👋`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="background: #f5f5f5; border-radius: 12px; padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px; text-align: center;">Hey there! 👋</h2>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              We noticed we haven't heard from you since <strong>${new Date(lastCheckInDate).toLocaleDateString()}</strong>. No pressure — we know life gets busy.
            </p>
            <p style="color: #666; font-size: 16px; margin: 15px 0; line-height: 1.6;">
              When you get a moment, we'd love to know how ${dogName}'s doing this week. One quick check-in takes 30 seconds and helps build a clear picture of ${dogName} and all pets families participating
            </p>
            <p style="color: #666; font-size: 14px; margin: 15px 0; line-height: 1.6;">
              <strong>Bonus:</strong> Every check-in helps us build information with the intentions to provide insights to the entire community. 🐾
            </p>
            <div style="text-align: center; margin-top: 25px;">
              <a href="${BASE_URL}/dashboard/${dogId}" style="display: inline-block; background: #d96f56; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                View [dog_name]'s Progress and Update
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

    // For each dog, check if they have a check-in this week
    for (const dog of allDogs) {
      try {
        // Calculate current week number
        const created = new Date(dog.created_at);
        const now = new Date();
        const currentWeek = Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1;

        // Check if dog has a check-in for this week
        const { data: thisWeekCheckin } = await supabase
          .from('mobility_checkins')
          .select('id')
          .eq('dog_id', dog.id)
          .eq('week_number', currentWeek)
          .limit(1);

        // If they DO have a check-in this week, skip them
        if (thisWeekCheckin && thisWeekCheckin.length > 0) {
          continue;
        }

        // ============================================
        // FLOW 2: AUTO SMS REMINDERS (Missing check-in notifications)
        // Sends SMS at 2pm (Day 7), 7pm (+4h), and 7:30am next day
        // ============================================

        // Calculate reminder times based on CURRENT WEEK (not creation date)
        // Week 1 starts on creation date
        // Week 2 starts 7 days after creation
        // Week X starts on (creation + (7 * (X-1)) days)
        const weekStartDate = new Date(created);
        weekStartDate.setDate(weekStartDate.getDate() + (7 * (currentWeek - 1)));

        // Reminder #1: Start of week at 2pm
        const reminderDay1 = new Date(weekStartDate);
        reminderDay1.setHours(14, 0, 0, 0); // 2pm

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
              message_body: `${dog.dog_name}'s #${currentWeek} week check-in reminder! We know life gets busy, so when you have a chance, click here to update: ${reminderCheckinLink}`,
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
              message_body: `${dog.dog_name}'s #${currentWeek} week check-in reminder! Our community really depends on building a large community of health journeys. If you can, click here to update: ${reminderCheckinLink}`,
              status: 'pending'
            });
          if (queueError3) {
            console.error(`❌ Error queueing reminder #3 for ${dog.dog_name}:`, queueError3.message);
          } else {
            console.log(`📱 Queued reminder #3 (${day3Time}) for ${dog.dog_name}`);
          }
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
            continue;
          }
        }

        // Get owner's email from their profile - skip if we don't have one on file
        // (dogs created before the email field was added won't have this)
        if (!dog.email) {
          console.warn(`⚠️ ${dog.dog_name} has no email on file — skipping churn alert email`);
          continue;
        }
        const ownerEmail = dog.email;

        // Get last check-in to show context
        const { data: lastCheckin } = await supabase
          .from('mobility_checkins')
          .select('mobility_score, created_at')
          .eq('dog_id', dog.id)
          .order('created_at', { ascending: false })
          .limit(1);

        const lastScore = lastCheckin?.[0]?.mobility_score || dog.baseline_mobility_score;
        const lastCheckInDate = lastCheckin?.[0]?.created_at || dog.created_at;

        // Send churn alert email
        await sendChurnAlertEmail(ownerEmail, dog.dog_name, lastScore, lastCheckInDate, dog.id);

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
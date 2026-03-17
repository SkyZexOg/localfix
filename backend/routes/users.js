const router = require(‘express’).Router();
const bcrypt = require(‘bcryptjs’);
const jwt = require(‘jsonwebtoken’);
const nodemailer = require(‘nodemailer’);
const { pool } = require(’../db’);

// ── OTP Store (in-memory) ─────────────────────────────────
// { email -> { code, expires, attempts, type, verified } }
const otpStore = new Map();
// Resend throttle: { email -> lastSentAt timestamp }
const resendThrottle = new Map();

// ── Nodemailer transporter ────────────────────────────────
const transporter = nodemailer.createTransport({
service: ‘gmail’,
auth: {
user: process.env.EMAIL_USER,
pass: process.env.EMAIL_PASS
}
});

// ── Generate 6-digit OTP ──────────────────────────────────
function generateOTP() {
return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── OTP Email HTML Template ───────────────────────────────
function otpEmailHTML(code, title, subtitle) {
return 

  <!DOCTYPE html>

  <html>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:sans-serif">
    <div style="max-width:480px;margin:40px auto;background:#080A0E;border-radius:16px;border:1px solid #1A2030;overflow:hidden">
      <div style="background:#FF5C00;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:1.6rem;font-weight:700">Local<span style="opacity:0.85">Fix</span></h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:0.85rem">${subtitle}</p>
      </div>
      <div style="padding:32px">
        <p style="color:#F0F2F5;font-size:1rem;font-weight:600;margin:0 0 20px">${title}</p>
        <div style="background:#141820;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;border:1px solid #1A2030">
          <span style="font-size:42px;font-weight:800;letter-spacing:16px;color:#FF5C00;font-family:monospace">${code}</span>
        </div>
        <p style="color:#8B95A8;font-size:0.85rem;margin:0 0 8px">&#128274; This code expires in <strong style="color:#F0F2F5">5 minutes</strong></p>
        <p style="color:#4A5568;font-size:0.8rem;margin:0">If you did not request this, please ignore this email.</p>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #1A2030">
        <p style="color:#4A5568;font-size:0.75rem;margin:0">&copy; 2026 LocalFix &bull; Gorakhpur, India</p>
      </div>
    </div>
  </body>
  </html>`;
}

// ── Send OTP Email ────────────────────────────────────────
async function sendOTPEmail(to, code, type) {
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
throw new Error(‘EMAIL_USER and EMAIL_PASS environment variables are not configured. Please add them in Railway.’);
}

const isSignup = type === ‘signup’;
const subject = isSignup
? ‘Your LocalFix verification code’
: ‘Reset your LocalFix password’;
const title = isSignup
? ‘Your email verification code’
: ‘Your password reset code’;
const subtitle = isSignup
? ‘Use this code to verify your email and complete signup.’
: ‘Use this code to reset your LocalFix password.’;

await transporter.sendMail({
from: `LocalFix <${process.env.EMAIL_USER}>`,
to: to,
subject: subject,
html: otpEmailHTML(code, title, subtitle)
});

console.log(`OTP email sent to: ${to} [type: ${type}]`);
}

// ── POST /api/users/send-otp ──────────────────────────────
router.post(’/send-otp’, async (req, res) => {
try {
const { email, type } = req.body;

```
if (!email || !['signup', 'reset'].includes(type))
  return res.status(400).json({ success: false, message: 'Email and valid type (signup/reset) required.' });

const normalEmail = email.toLowerCase().trim();

// For signup: email must NOT already exist
if (type === 'signup') {
  const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [normalEmail]);
  if (existing.length)
    return res.status(409).json({ success: false, message: 'This email is already registered. Please sign in.' });
}

// For reset: email MUST exist
if (type === 'reset') {
  const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [normalEmail]);
  if (!rows.length)
    return res.status(404).json({ success: false, message: 'No account found with this email address.' });
}

// Resend throttle: 60 seconds between requests
const lastSent = resendThrottle.get(normalEmail);
if (lastSent && Date.now() - lastSent < 60000) {
  const wait = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
  return res.status(429).json({ success: false, message: `Please wait ${wait} seconds before requesting another code.` });
}

// Generate OTP and store
const code = generateOTP();
otpStore.set(normalEmail, {
  code,
  expires: Date.now() + 5 * 60 * 1000, // 5 minutes
  attempts: 0,
  type,
  verified: false
});
resendThrottle.set(normalEmail, Date.now());

// Send email
await sendOTPEmail(normalEmail, code, type);

res.json({ success: true, message: `Verification code sent to ${normalEmail}. Please check your inbox.` });
```

} catch (err) {
console.error(‘send-otp error:’, err.message);
res.status(500).json({
success: false,
message: err.message.includes(‘environment variables’)
? err.message
: ‘Failed to send verification code. Please try again.’
});
}
});

// ── POST /api/users/verify-otp ────────────────────────────
router.post(’/verify-otp’, async (req, res) => {
try {
const { email, code, type } = req.body;
const normalEmail = email?.toLowerCase().trim();

```
if (!normalEmail || !code || !type)
  return res.status(400).json({ success: false, message: 'Email, code, and type are required.' });

const entry = otpStore.get(normalEmail);

if (!entry || entry.type !== type)
  return res.status(400).json({ success: false, message: 'No verification code found. Please request a new one.' });

// Check expiry
if (Date.now() > entry.expires) {
  otpStore.delete(normalEmail);
  return res.status(400).json({ success: false, message: 'Code has expired. Please request a new one.' });
}

// Max 3 attempts
entry.attempts += 1;
if (entry.attempts > 3) {
  otpStore.delete(normalEmail);
  return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
}

// Check code
if (entry.code !== code.toString().trim()) {
  const remaining = 3 - entry.attempts;
  return res.status(400).json({
    success: false,
    message: remaining > 0
      ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
      : 'Incorrect code. No attempts remaining.'
  });
}

// Mark verified
entry.verified = true;
otpStore.set(normalEmail, entry);

res.json({ success: true, message: 'Code verified successfully.' });
```

} catch (err) {
console.error(‘verify-otp error:’, err.message);
res.status(500).json({ success: false, message: ‘Server error.’ });
}
});

// ── POST /api/users/register ──────────────────────────────
router.post(’/register’, async (req, res) => {
try {
const { name, email, password } = req.body;

```
if (!name || !email || !password)
  return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });

if (password.length < 6)
  return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

const normalEmail = email.toLowerCase().trim();

// Verify OTP was completed
const entry = otpStore.get(normalEmail);
if (!entry || !entry.verified || entry.type !== 'signup')
  return res.status(403).json({ success: false, message: 'Email not verified. Please complete OTP verification first.' });

const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [normalEmail]);
if (existing.length)
  return res.status(409).json({ success: false, message: 'This email is already registered.' });

const hash = await bcrypt.hash(password, 10);
const [result] = await pool.execute(
  'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
  [name.trim(), normalEmail, hash]
);

// Cleanup
otpStore.delete(normalEmail);
resendThrottle.delete(normalEmail);

const token = jwt.sign(
  { id: result.insertId, role: 'user', name: name.trim() },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

console.log(`New user registered: ${normalEmail}`);
res.status(201).json({
  success: true,
  token,
  user: { id: result.insertId, name: name.trim(), email: normalEmail }
});
```

} catch (err) {
console.error(‘register error:’, err.message);
res.status(500).json({ success: false, message: ‘Server error.’ });
}
});

// ── POST /api/users/login ─────────────────────────────────
router.post(’/login’, async (req, res) => {
try {
const { email, password } = req.body;

```
if (!email || !password)
  return res.status(400).json({ success: false, message: 'Email and password are required.' });

const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);

if (!rows.length)
  return res.status(401).json({ success: false, message: 'Invalid email or password.' });

const valid = await bcrypt.compare(password, rows[0].password_hash);
if (!valid)
  return res.status(401).json({ success: false, message: 'Invalid email or password.' });

const token = jwt.sign(
  { id: rows[0].id, role: 'user', name: rows[0].name },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

res.json({
  success: true,
  token,
  user: { id: rows[0].id, name: rows[0].name, email: rows[0].email }
});
```

} catch (err) {
console.error(‘login error:’, err.message);
res.status(500).json({ success: false, message: ‘Server error.’ });
}
});

// ── POST /api/users/reset-password ───────────────────────
router.post(’/reset-password’, async (req, res) => {
try {
const { email, password } = req.body;

```
if (!email || !password)
  return res.status(400).json({ success: false, message: 'Email and new password are required.' });

if (password.length < 6)
  return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

const normalEmail = email.toLowerCase().trim();

// Verify OTP was completed for reset
const entry = otpStore.get(normalEmail);
if (!entry || !entry.verified || entry.type !== 'reset')
  return res.status(403).json({ success: false, message: 'Email not verified. Please complete OTP verification first.' });

const hash = await bcrypt.hash(password, 10);
const [result] = await pool.execute(
  'UPDATE users SET password_hash = ? WHERE email = ?',
  [hash, normalEmail]
);

if (!result.affectedRows)
  return res.status(404).json({ success: false, message: 'No account found with this email.' });

otpStore.delete(normalEmail);
resendThrottle.delete(normalEmail);

console.log(`Password reset for: ${normalEmail}`);
res.json({ success: true, message: 'Password updated successfully. Please sign in.' });
```

} catch (err) {
console.error(‘reset-password error:’, err.message);
res.status(500).json({ success: false, message: ‘Server error.’ });
}
});

// ── GET /api/users/me ─────────────────────────────────────
router.get(’/me’, require(’../middleware/auth’).verifyUser, async (req, res) => {
try {
const [rows] = await pool.execute(
‘SELECT id, name, email, created_at FROM users WHERE id = ?’,
[req.user.id]
);
if (!rows.length)
return res.status(404).json({ success: false, message: ‘User not found.’ });
res.json({ success: true, data: rows[0] });
} catch (err) {
res.status(500).json({ success: false, message: ‘Server error.’ });
}
});

module.exports = router;

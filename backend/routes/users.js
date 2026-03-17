const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { pool } = require('../db');

// OTP Store
const otpStore = new Map();
const resendThrottle = new Map();

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function otpEmailHTML(code, title, subtitle) {
  return `<!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:sans-serif">
  <div style="max-width:480px;margin:40px auto;background:#080A0E;border-radius:16px;border:1px solid #1A2030;overflow:hidden">
  <div style="background:#FF5C00;padding:24px 32px">
  <h1 style="margin:0;color:#fff;font-size:1.6rem;font-weight:700">LocalFix</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:0.85rem">${subtitle}</p>
  </div>
  <div style="padding:32px">
  <p style="color:#F0F2F5;font-size:1rem;font-weight:600;margin:0 0 20px">${title}</p>
  <div style="background:#141820;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;border:1px solid #1A2030">
  <span style="font-size:42px;font-weight:800;letter-spacing:16px;color:#FF5C00;font-family:monospace">${code}</span>
  </div>
  <p style="color:#8B95A8;font-size:0.85rem;margin:0 0 8px">This code expires in <strong style="color:#F0F2F5">5 minutes</strong></p>
  <p style="color:#4A5568;font-size:0.8rem;margin:0">If you did not request this, please ignore this email.</p>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #1A2030">
  <p style="color:#4A5568;font-size:0.75rem;margin:0">© 2026 LocalFix</p>
  </div>
  </div>
  </body>
  </html>`;
}

async function sendOTPEmail(to, code, type) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error('EMAIL_USER and EMAIL_PASS are not set in environment variables.');
  }

  const isSignup = type === 'signup';

  const subject = isSignup
    ? 'Your LocalFix verification code'
    : 'Reset your LocalFix password';

  const title = isSignup
    ? 'Your email verification code'
    : 'Your password reset code';

  const subtitle = isSignup
    ? 'Use this code to verify your email and complete signup.'
    : 'Use this code to reset your LocalFix password.';

  await transporter.sendMail({
    from: `LocalFix <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html: otpEmailHTML(code, title, subtitle)
  });

  console.log('OTP email sent to:', to);
}

// SEND OTP
router.post('/send-otp', async (req, res) => {
  try {
    const { email, type } = req.body;

    if (!email || (type !== 'signup' && type !== 'reset')) {
      return res.status(400).json({ success: false, message: 'Email and valid type required.' });
    }

    const normalEmail = email.toLowerCase().trim();

    if (type === 'signup') {
      const existing = await pool.execute('SELECT id FROM users WHERE email = ?', [normalEmail]);
      if (existing[0].length) {
        return res.status(409).json({ success: false, message: 'Email already registered.' });
      }
    }

    if (type === 'reset') {
      const rows = await pool.execute('SELECT id FROM users WHERE email = ?', [normalEmail]);
      if (!rows[0].length) {
        return res.status(404).json({ success: false, message: 'No account found.' });
      }
    }

    const lastSent = resendThrottle.get(normalEmail);
    if (lastSent && Date.now() - lastSent < 60000) {
      return res.status(429).json({ success: false, message: 'Wait before requesting again.' });
    }

    const code = generateOTP();

    otpStore.set(normalEmail, {
      code,
      expires: Date.now() + 5 * 60 * 1000,
      attempts: 0,
      type,
      verified: false
    });

    resendThrottle.set(normalEmail, Date.now());

    await sendOTPEmail(normalEmail, code, type);

    res.json({ success: true, message: 'OTP sent' });

  } catch (err) {
    console.error('send-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

// VERIFY OTP
router.post('/verify-otp', (req, res) => {
  try {
    const { email, code, type } = req.body;

    const entry = otpStore.get(email.toLowerCase().trim());

    if (!entry || entry.code !== code) {
      return res.status(400).json({ success: false, message: 'Invalid code' });
    }

    entry.verified = true;

    res.json({ success: true });

  } catch {
    res.status(500).json({ success: false });
  }
});

// REGISTER
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.execute(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, hash]
    );

    const token = jwt.sign(
      { id: result[0].insertId },
      process.env.JWT_SECRET
    );

    res.json({ success: true, token });

  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const rows = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);

    if (!rows[0].length) {
      return res.status(401).json({ success: false });
    }

    const user = rows[0][0];

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ success: false });
    }

    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET
    );

    res.json({ success: true, token });

  } catch {
    res.status(500).json({ success: false });
  }
});

module.exports = router;

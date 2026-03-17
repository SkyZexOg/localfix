const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const otpStore = new Map();
const resendThrottle = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function otpEmailHTML(code, type) {
  var title = type === 'signup' ? 'Verify your email' : 'Reset your password';
  var subtitle = type === 'signup' ? 'Complete your LocalFix registration' : 'Reset your LocalFix password';
  return '<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f4f4f4;font-family:Arial,sans-serif">'
    + '<div style="max-width:460px;margin:0 auto;background:#080A0E;border-radius:12px;overflow:hidden">'
    + '<div style="background:#FF5C00;padding:20px 28px"><h2 style="margin:0;color:#fff">LocalFix</h2>'
    + '<p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:14px">' + subtitle + '</p></div>'
    + '<div style="padding:28px">'
    + '<p style="color:#F0F2F5;font-weight:600;margin:0 0 16px">' + title + '</p>'
    + '<div style="background:#141820;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px">'
    + '<span style="font-size:38px;font-weight:900;letter-spacing:14px;color:#FF5C00;font-family:monospace">' + code + '</span></div>'
    + '<p style="color:#8B95A8;font-size:13px;margin:0">Expires in 5 minutes. Do not share this code.</p>'
    + '</div></div></body></html>';
}

async function sendOTPEmail(to, code, type) {
  var nodemailer = require('nodemailer');
  var transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });

  var subject = type === 'signup' ? 'Your LocalFix verification code' : 'Reset your LocalFix password';

  await transporter.sendMail({
    from: '"LocalFix" <' + process.env.EMAIL_USER + '>',
    to: to,
    subject: subject,
    html: otpEmailHTML(code, type)
  });
  console.log('OTP sent to:', to, '| type:', type, '| code:', code);
}

// POST /api/users/send-otp
router.post('/send-otp', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var type = req.body.type;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email required.' });
    }
    if (type !== 'signup' && type !== 'reset') {
      return res.status(400).json({ success: false, message: 'Type must be signup or reset.' });
    }
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error('EMAIL_USER or EMAIL_PASS not set in Railway variables');
      return res.status(500).json({ success: false, message: 'Email service not configured. Contact admin.' });
    }

    if (type === 'signup') {
      var rows1 = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
      if (rows1[0].length) {
        return res.status(409).json({ success: false, message: 'Email already registered. Please sign in.' });
      }
    }
    if (type === 'reset') {
      var rows2 = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
      if (!rows2[0].length) {
        return res.status(404).json({ success: false, message: 'No account found with this email.' });
      }
    }

    // Rate limit: 60 seconds between sends
    var last = resendThrottle.get(email);
    if (last && Date.now() - last < 60000) {
      var secs = Math.ceil((60000 - (Date.now() - last)) / 1000);
      return res.status(429).json({ success: false, message: 'Wait ' + secs + ' seconds before requesting another code.' });
    }

    var code = generateOTP();
    otpStore.set(email, { code: code, expires: Date.now() + 300000, attempts: 0, type: type, verified: false });
    resendThrottle.set(email, Date.now());

    await sendOTPEmail(email, code, type);
    return res.json({ success: true, message: 'Code sent to ' + email + '. Check your inbox.' });

  } catch (err) {
    console.error('send-otp error:', err.message);
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION' || (err.message && err.message.includes('timeout'))) {
      return res.status(500).json({ success: false, message: 'Email timeout. Check EMAIL_USER and EMAIL_PASS in Railway variables.' });
    }
    if (err.message && err.message.includes('Invalid login')) {
      return res.status(500).json({ success: false, message: 'Gmail authentication failed. Check your App Password.' });
    }
    return res.status(500).json({ success: false, message: 'Failed to send code. Please try again.' });
  }
});

// POST /api/users/verify-otp
router.post('/verify-otp', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var code = (req.body.code || '').toString().trim();
    var type = req.body.type;

    if (!email || !code || !type) {
      return res.status(400).json({ success: false, message: 'Email, code and type required.' });
    }

    var entry = otpStore.get(email);
    if (!entry || entry.type !== type) {
      return res.status(400).json({ success: false, message: 'No code found. Request a new one.' });
    }
    if (Date.now() > entry.expires) {
      otpStore.delete(email);
      return res.status(400).json({ success: false, message: 'Code expired. Request a new one.' });
    }
    entry.attempts += 1;
    if (entry.attempts > 3) {
      otpStore.delete(email);
      return res.status(429).json({ success: false, message: 'Too many attempts. Request a new code.' });
    }
    if (entry.code !== code) {
      var left = 3 - entry.attempts;
      return res.status(400).json({ success: false, message: 'Wrong code. ' + left + ' attempt(s) left.' });
    }

    entry.verified = true;
    otpStore.set(email, entry);
    return res.json({ success: true, message: 'Code verified.' });

  } catch (err) {
    console.error('verify-otp error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/users/register
router.post('/register', async function(req, res) {
  try {
    var name = (req.body.name || '').trim();
    var email = (req.body.email || '').toLowerCase().trim();
    var password = req.body.password || '';

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    var entry = otpStore.get(email);
    if (!entry || !entry.verified || entry.type !== 'signup') {
      return res.status(403).json({ success: false, message: 'Email not verified. Complete OTP first.' });
    }

    var existing = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing[0].length) {
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    var hash = await bcrypt.hash(password, 10);
    var result = await pool.execute('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name, email, hash]);

    otpStore.delete(email);
    resendThrottle.delete(email);

    var token = jwt.sign({ id: result[0].insertId, role: 'user', name: name }, process.env.JWT_SECRET, { expiresIn: '7d' });
    console.log('User registered:', email);
    return res.status(201).json({ success: true, token: token, user: { id: result[0].insertId, name: name, email: email } });

  } catch (err) {
    console.error('register error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/users/login
router.post('/login', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var password = req.body.password || '';

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }

    var rows = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows[0].length) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    var user = rows[0][0];
    var valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    var token = jwt.sign({ id: user.id, role: 'user', name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.json({ success: true, token: token, user: { id: user.id, name: user.name, email: user.email } });

  } catch (err) {
    console.error('login error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/users/reset-password
router.post('/reset-password', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var password = req.body.password || '';

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    var entry = otpStore.get(email);
    if (!entry || !entry.verified || entry.type !== 'reset') {
      return res.status(403).json({ success: false, message: 'Email not verified. Complete OTP first.' });
    }

    var hash = await bcrypt.hash(password, 10);
    var result = await pool.execute('UPDATE users SET password_hash = ? WHERE email = ?', [hash, email]);

    if (!result[0].affectedRows) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    otpStore.delete(email);
    resendThrottle.delete(email);
    console.log('Password reset:', email);
    return res.json({ success: true, message: 'Password updated. Please sign in.' });

  } catch (err) {
    console.error('reset-password error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/users/me
router.get('/me', require('../middleware/auth').verifyUser, async function(req, res) {
  try {
    var rows = await pool.execute('SELECT id, name, email, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!rows[0].length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    return res.json({ success: true, data: rows[0][0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;

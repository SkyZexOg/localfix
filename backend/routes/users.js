const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { pool } = require('../db');

const otpStore = new Map();
const resendThrottle = new Map();

function createTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    tls: {
      rejectUnauthorized: false
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function otpEmailHTML(code, title, subtitle) {
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:sans-serif">'
    + '<div style="max-width:480px;margin:40px auto;background:#080A0E;border-radius:16px;overflow:hidden">'
    + '<div style="background:#FF5C00;padding:24px 32px">'
    + '<h1 style="margin:0;color:#fff;font-size:1.6rem;font-weight:700">LocalFix</h1>'
    + '<p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:0.85rem">' + subtitle + '</p>'
    + '</div>'
    + '<div style="padding:32px">'
    + '<p style="color:#F0F2F5;font-size:1rem;font-weight:600;margin:0 0 20px">' + title + '</p>'
    + '<div style="background:#141820;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">'
    + '<span style="font-size:42px;font-weight:800;letter-spacing:16px;color:#FF5C00;font-family:monospace">' + code + '</span>'
    + '</div>'
    + '<p style="color:#8B95A8;font-size:0.85rem;margin:0 0 8px">This code expires in <strong style="color:#F0F2F5">5 minutes</strong>.</p>'
    + '<p style="color:#4A5568;font-size:0.8rem;margin:0">If you did not request this, please ignore this email.</p>'
    + '</div>'
    + '<div style="padding:16px 32px;border-top:1px solid #1A2030">'
    + '<p style="color:#4A5568;font-size:0.75rem;margin:0">(c) 2026 LocalFix</p>'
    + '</div></div></body></html>';
}

async function sendOTPEmail(to, code, type) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error('EMAIL_USER and EMAIL_PASS are not configured in Railway environment variables.');
  }

  var isSignup = type === 'signup';
  var subject = isSignup ? 'Your LocalFix verification code' : 'Reset your LocalFix password';
  var title = isSignup ? 'Your email verification code' : 'Your password reset code';
  var subtitle = isSignup
    ? 'Use this code to verify your email and complete signup.'
    : 'Use this code to reset your LocalFix password.';

  var transporter = createTransporter();

  await transporter.sendMail({
    from: '"LocalFix" <' + process.env.EMAIL_USER + '>',
    to: to,
    subject: subject,
    html: otpEmailHTML(code, title, subtitle)
  });

  console.log('OTP email sent to:', to);
}

router.post('/send-otp', async function(req, res) {
  try {
    var email = req.body.email;
    var type = req.body.type;

    if (!email || (type !== 'signup' && type !== 'reset')) {
      return res.status(400).json({ success: false, message: 'Email and valid type required.' });
    }

    var normalEmail = email.toLowerCase().trim();

    if (type === 'signup') {
      var check = await pool.execute('SELECT id FROM users WHERE email = ?', [normalEmail]);
      if (check[0].length) {
        return res.status(409).json({ success: false, message: 'This email is already registered. Please sign in.' });
      }
    }

    if (type === 'reset') {
      var found = await pool.execute('SELECT id FROM users WHERE email = ?', [normalEmail]);
      if (!found[0].length) {
        return res.status(404).json({ success: false, message: 'No account found with this email.' });
      }
    }

    var lastSent = resendThrottle.get(normalEmail);
    if (lastSent && Date.now() - lastSent < 60000) {
      var wait = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
      return res.status(429).json({ success: false, message: 'Please wait ' + wait + ' seconds before requesting another code.' });
    }

    var code = generateOTP();
    otpStore.set(normalEmail, {
      code: code,
      expires: Date.now() + 5 * 60 * 1000,
      attempts: 0,
      type: type,
      verified: false
    });
    resendThrottle.set(normalEmail, Date.now());

    await sendOTPEmail(normalEmail, code, type);

    res.json({ success: true, message: 'Verification code sent to ' + normalEmail + '. Please check your inbox.' });

  } catch (err) {
    console.error('send-otp error:', err.message);
    if (err.message.includes('EMAIL_USER') || err.message.includes('EMAIL_PASS')) {
      return res.status(500).json({ success: false, message: 'Email not configured on server. Contact admin.' });
    }
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.message.includes('timeout')) {
      return res.status(500).json({ success: false, message: 'Email service timeout. Please try again in a moment.' });
    }
    res.status(500).json({ success: false, message: 'Failed to send code. Please try again.' });
  }
});

router.post('/verify-otp', async function(req, res) {
  try {
    var email = req.body.email;
    var code = req.body.code;
    var type = req.body.type;

    if (!email || !code || !type) {
      return res.status(400).json({ success: false, message: 'Email, code and type are required.' });
    }

    var normalEmail = email.toLowerCase().trim();
    var entry = otpStore.get(normalEmail);

    if (!entry || entry.type !== type) {
      return res.status(400).json({ success: false, message: 'No code found. Please request a new one.' });
    }

    if (Date.now() > entry.expires) {
      otpStore.delete(normalEmail);
      return res.status(400).json({ success: false, message: 'Code expired. Please request a new one.' });
    }

    entry.attempts += 1;
    if (entry.attempts > 3) {
      otpStore.delete(normalEmail);
      return res.status(429).json({ success: false, message: 'Too many wrong attempts. Please request a new code.' });
    }

    if (entry.code !== code.toString().trim()) {
      var remaining = 3 - entry.attempts;
      return res.status(400).json({
        success: false,
        message: remaining > 0 ? 'Incorrect code. ' + remaining + ' attempt(s) remaining.' : 'Incorrect code.'
      });
    }

    entry.verified = true;
    otpStore.set(normalEmail, entry);
    res.json({ success: true, message: 'Code verified successfully.' });

  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/register', async function(req, res) {
  try {
    var name = req.body.name;
    var email = req.body.email;
    var password = req.body.password;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    var normalEmail = email.toLowerCase().trim();
    var entry = otpStore.get(normalEmail);

    if (!entry || !entry.verified || entry.type !== 'signup') {
      return res.status(403).json({ success: false, message: 'Email not verified. Please complete OTP verification first.' });
    }

    var existing = await pool.execute('SELECT id FROM users WHERE email = ?', [normalEmail]);
    if (existing[0].length) {
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    var hash = await bcrypt.hash(password, 10);
    var result = await pool.execute(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name.trim(), normalEmail, hash]
    );

    otpStore.delete(normalEmail);
    resendThrottle.delete(normalEmail);

    var token = jwt.sign(
      { id: result[0].insertId, role: 'user', name: name.trim() },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('New user registered:', normalEmail);
    res.status(201).json({
      success: true,
      token: token,
      user: { id: result[0].insertId, name: name.trim(), email: normalEmail }
    });

  } catch (err) {
    console.error('register error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/login', async function(req, res) {
  try {
    var email = req.body.email;
    var password = req.body.password;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }

    var rows = await pool.execute('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!rows[0].length) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    var user = rows[0][0];
    var valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    var token = jwt.sign(
      { id: user.id, role: 'user', name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, token: token, user: { id: user.id, name: user.name, email: user.email } });

  } catch (err) {
    console.error('login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/reset-password', async function(req, res) {
  try {
    var email = req.body.email;
    var password = req.body.password;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    var normalEmail = email.toLowerCase().trim();
    var entry = otpStore.get(normalEmail);

    if (!entry || !entry.verified || entry.type !== 'reset') {
      return res.status(403).json({ success: false, message: 'Email not verified. Please complete OTP first.' });
    }

    var hash = await bcrypt.hash(password, 10);
    var result = await pool.execute('UPDATE users SET password_hash = ? WHERE email = ?', [hash, normalEmail]);

    if (!result[0].affectedRows) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    otpStore.delete(normalEmail);
    resendThrottle.delete(normalEmail);

    console.log('Password reset for:', normalEmail);
    res.json({ success: true, message: 'Password updated. Please sign in.' });

  } catch (err) {
    console.error('reset-password error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/me', require('../middleware/auth').verifyUser, async function(req, res) {
  try {
    var rows = await pool.execute('SELECT id, name, email, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!rows[0].length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    res.json({ success: true, data: rows[0][0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;

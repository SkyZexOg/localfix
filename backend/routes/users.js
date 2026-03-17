const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const { pool } = require('../db');

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function otpEmailHTML(code, type) {
  var title = type === 'signup' ? 'Verify your email' : 'Reset your password';
  return '<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f4f4f4;font-family:Arial,sans-serif">'
    + '<div style="max-width:460px;margin:0 auto;background:#080A0E;border-radius:12px;overflow:hidden">'
    + '<div style="background:#FF5C00;padding:20px 28px"><h2 style="margin:0;color:#fff">LocalFix</h2></div>'
    + '<div style="padding:28px">'
    + '<p style="color:#F0F2F5;font-weight:600;margin:0 0 16px">' + title + '</p>'
    + '<div style="background:#141820;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px">'
    + '<span style="font-size:40px;font-weight:900;letter-spacing:14px;color:#FF5C00;font-family:monospace">' + code + '</span>'
    + '</div>'
    + '<p style="color:#8B95A8;font-size:13px;margin:0">Expires in 5 minutes. Do not share.</p>'
    + '</div></div></body></html>';
}

// ─────────────────────────────────────────────
// BREVO EMAIL SENDER (API - works on Railway)
// ─────────────────────────────────────────────

function sendBrevoEmail(to, code, type) {
  return new Promise(function (resolve, reject) {
    if (!process.env.BREVO_API_KEY) {
      return reject(new Error('BREVO_API_KEY not set in environment variables.'));
    }

    var subject = type === 'signup'
      ? 'Your LocalFix verification code'
      : 'Reset your LocalFix password';

    var body = JSON.stringify({
      sender: {
        name: 'LocalFix',
        email: process.env.BREVO_SENDER_EMAIL
      },
      to: [{ email: to }],
      subject: subject,
      htmlContent: otpEmailHTML(code, type)
    });

    var options = {
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    };

    var req = https.request(options, function (response) {
      var data = '';
      response.on('data', function (chunk) { data += chunk; });
      response.on('end', function () {
        if (response.statusCode === 201) {
          try {
            var parsed = JSON.parse(data);
            console.log('[Brevo] OTP sent to:', to, '| messageId:', parsed.messageId);
          } catch (e) {
            console.log('[Brevo] OTP sent to:', to);
          }
          resolve(true);
        } else {
          console.error('[Brevo] Error response:', response.statusCode, data);
          reject(new Error('Brevo API error: ' + response.statusCode + ' ' + data));
        }
      });
    });

    req.on('error', function (err) {
      reject(new Error('Brevo request failed: ' + err.message));
    });

    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────
// OTP DB HELPERS (stored in MySQL, not memory)
// ─────────────────────────────────────────────

async function saveOTP(email, code, type) {
  await pool.execute(
    'DELETE FROM otp_store WHERE email = ? AND type = ?',
    [email, type]
  );
  await pool.execute(
    'INSERT INTO otp_store (email, code, type, expires_at, attempts, verified) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0, FALSE)',
    [email, code, type]
  );
}

async function getOTP(email, type) {
  var rows = await pool.execute(
    'SELECT * FROM otp_store WHERE email = ? AND type = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
    [email, type]
  );
  return rows[0][0] || null;
}

async function incrementOTPAttempts(id) {
  await pool.execute('UPDATE otp_store SET attempts = attempts + 1 WHERE id = ?', [id]);
}

async function markOTPVerified(id) {
  await pool.execute('UPDATE otp_store SET verified = TRUE WHERE id = ?', [id]);
}

async function deleteOTP(email, type) {
  await pool.execute('DELETE FROM otp_store WHERE email = ? AND type = ?', [email, type]);
}

async function getLastSentTime(email) {
  var rows = await pool.execute(
    'SELECT created_at FROM otp_store WHERE email = ? ORDER BY created_at DESC LIMIT 1',
    [email]
  );
  if (!rows[0][0]) return null;
  return new Date(rows[0][0].created_at).getTime();
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// POST /api/users/send-otp
router.post('/send-otp', async function (req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var type = req.body.type;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email required.' });
    }
    if (type !== 'signup' && type !== 'reset') {
      return res.status(400).json({ success: false, message: 'Type must be signup or reset.' });
    }
    if (!process.env.BREVO_API_KEY) {
      return res.status(500).json({ success: false, message: 'Email service not configured. Add BREVO_API_KEY in environment.' });
    }

    if (type === 'signup') {
      var r1 = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
      if (r1[0].length) {
        return res.status(409).json({ success: false, message: 'Email already registered. Please sign in.' });
      }
    }
    if (type === 'reset') {
      var r2 = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
      if (!r2[0].length) {
        return res.status(404).json({ success: false, message: 'No account found with this email.' });
      }
    }

    var lastSent = await getLastSentTime(email);
    if (lastSent && Date.now() - lastSent < 60000) {
      var secs = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
      return res.status(429).json({ success: false, message: 'Wait ' + secs + ' seconds before requesting another code.' });
    }

    var code = generateOTP();
    await saveOTP(email, code, type);
    await sendBrevoEmail(email, code, type);

    return res.json({ success: true, message: 'Code sent to ' + email + '. Check your inbox.' });

  } catch (err) {
    console.error('[send-otp] error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send code. Please try again.' });
  }
});

// POST /api/users/verify-otp
router.post('/verify-otp', async function (req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var code = (req.body.code || '').toString().trim();
    var type = req.body.type;

    if (!email || !code || !type) {
      return res.status(400).json({ success: false, message: 'Email, code and type required.' });
    }

    var entry = await getOTP(email, type);
    if (!entry) {
      return res.status(400).json({ success: false, message: 'No valid code found. Request a new one.' });
    }

    if (entry.attempts >= 3) {
      await deleteOTP(email, type);
      return res.status(429).json({ success: false, message: 'Too many wrong attempts. Request a new code.' });
    }

    if (entry.code !== code) {
      await incrementOTPAttempts(entry.id);
      var left = 3 - (entry.attempts + 1);
      return res.status(400).json({ success: false, message: 'Wrong code. ' + left + ' attempt(s) left.' });
    }

    await markOTPVerified(entry.id);
    return res.json({ success: true, message: 'Code verified.' });

  } catch (err) {
    console.error('[verify-otp] error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/users/register
router.post('/register', async function (req, res) {
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

    var entry = await getOTP(email, 'signup');
    if (!entry || !entry.verified) {
      return res.status(403).json({ success: false, message: 'Email not verified. Complete OTP first.' });
    }

    var existing = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing[0].length) {
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    var hash = await bcrypt.hash(password, 10);
    var result = await pool.execute(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, hash]
    );

    await deleteOTP(email, 'signup');

    var token = jwt.sign(
      { id: result[0].insertId, role: 'user', name: name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('[register] User registered:', email);
    return res.status(201).json({
      success: true,
      token: token,
      user: { id: result[0].insertId, name: name, email: email }
    });

  } catch (err) {
    console.error('[register] error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/users/login
router.post('/login', async function (req, res) {
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

    var token = jwt.sign(
      { id: user.id, role: 'user', name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({ success: true, token: token, user: { id: user.id, name: user.name, email: user.email } });

  } catch (err) {
    console.error('[login] error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/users/reset-password
router.post('/reset-password', async function (req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var password = req.body.password || '';

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    var entry = await getOTP(email, 'reset');
    if (!entry || !entry.verified) {
      return res.status(403).json({ success: false, message: 'Email not verified. Complete OTP first.' });
    }

    var hash = await bcrypt.hash(password, 10);
    var result = await pool.execute('UPDATE users SET password_hash = ? WHERE email = ?', [hash, email]);
    if (!result[0].affectedRows) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    await deleteOTP(email, 'reset');

    console.log('[reset-password] Password reset for:', email);
    return res.json({ success: true, message: 'Password updated. Please sign in.' });

  } catch (err) {
    console.error('[reset-password] error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/users/me
router.get('/me', require('../middleware/auth').verifyUser, async function (req, res) {
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

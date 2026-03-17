const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// POST /api/users/register — Direct signup, no OTP
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

    var existing = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing[0].length) {
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    var hash = await bcrypt.hash(password, 10);
    var result = await pool.execute(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, hash]
    );

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

// POST /api/users/reset-password — Simple password reset with email check
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

    var rows = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (!rows[0].length) {
      return res.status(404).json({ success: false, message: 'No account found with this email.' });
    }

    var hash = await bcrypt.hash(password, 10);
    await pool.execute('UPDATE users SET password_hash = ? WHERE email = ?', [hash, email]);

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

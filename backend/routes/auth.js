const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { verifyWorker } = require('../middleware/auth');

// -- POST /api/auth/login -- Worker login
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password required' });
    }

    const [rows] = await pool.execute(
      `SELECT id, name, phone, password_hash, skill, city, area, about, status, rating, total_reviews
       FROM workers WHERE phone = ? AND is_active = TRUE`,
      [phone]
    );
    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
    }

    const worker = rows[0];
    const match = await bcrypt.compare(password, worker.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
    }

    const token = jwt.sign(
      { id: worker.id, role: 'worker', name: worker.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    delete worker.password_hash;
    res.json({ success: true, message: 'Login successful', token, worker });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- GET /api/auth/me -- Get own profile
router.get('/me', verifyWorker, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, phone, skill, experience, city, area, about, status,
              rating, total_reviews, profile_views, call_clicks, whatsapp_clicks, created_at
       FROM workers WHERE id = ?`,
      [req.worker.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Worker not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- POST /api/auth/change-password -- Change password
router.post('/change-password', verifyWorker, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Both passwords required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
    }

    const [rows] = await pool.execute('SELECT password_hash FROM workers WHERE id = ?', [req.worker.id]);
    const match = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!match) return res.status(401).json({ success: false, message: 'Old password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE workers SET password_hash = ? WHERE id = ?', [newHash, req.worker.id]);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

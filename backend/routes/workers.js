const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { verifyWorker } = require('../middleware/auth');

// ── GET /api/workers ── Search/list approved workers
router.get('/', async (req, res) => {
  try {
    const { skill, city, status } = req.query;
    let sql = `SELECT id, name, skill, experience, city, area, about, status,
                      rating, total_reviews, profile_views, call_clicks, whatsapp_clicks,
                      created_at
               FROM workers
               WHERE is_active = TRUE AND status != 'pending'`;
    const params = [];

    if (skill) { sql += ' AND skill = ?'; params.push(skill); }
    if (city)  { sql += ' AND (city LIKE ? OR area LIKE ?)'; params.push(`%${city}%`, `%${city}%`); }
    if (status && status !== 'all') { sql += ' AND status = ?'; params.push(status); }

    sql += ' ORDER BY FIELD(status,"available","busy","offline"), rating DESC';

    const [rows] = await pool.execute(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/workers/stats ── Homepage stats
router.get('/stats', async (req, res) => {
  try {
    const [[total]] = await pool.execute(
      `SELECT COUNT(*) as total FROM workers WHERE is_active=TRUE AND status != 'pending'`
    );
    const [[available]] = await pool.execute(
      `SELECT COUNT(*) as available FROM workers WHERE status='available' AND is_active=TRUE`
    );
    const [[cities]] = await pool.execute(
      `SELECT COUNT(DISTINCT LOWER(city)) as cities FROM workers WHERE is_active=TRUE AND status != 'pending'`
    );
    res.json({ success: true, data: { total: total.total, available: available.available, cities: cities.cities } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/workers/categories ── Category counts
router.get('/categories', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT skill, COUNT(*) as count FROM workers
       WHERE is_active=TRUE AND status != 'pending'
       GROUP BY skill ORDER BY count DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/workers/:id ── Single worker detail
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, skill, experience, city, area, about, status,
              rating, total_reviews, created_at
       FROM workers WHERE id = ? AND is_active = TRUE AND status != 'pending'`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Worker not found' });

    // Log view
    await pool.execute(
      `INSERT INTO analytics (worker_id, event_type, ip_address) VALUES (?, 'view', ?)`,
      [req.params.id, req.ip]
    );
    await pool.execute(
      `UPDATE workers SET profile_views = profile_views + 1 WHERE id = ?`,
      [req.params.id]
    );

    // Get reviews
    const [reviews] = await pool.execute(
      `SELECT reviewer_name, rating, comment, created_at FROM reviews WHERE worker_id = ? ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], reviews } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/workers/register ── New worker registration
router.post('/register', async (req, res) => {
  try {
    const { name, phone, password, skill, experience, city, area, about } = req.body;

    // Validation
    if (!name || !phone || !password || !skill || !experience || !city || !area) {
      return res.status(400).json({ success: false, message: 'All required fields must be filled' });
    }
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    // Check duplicate phone
    const [existing] = await pool.execute('SELECT id FROM workers WHERE phone = ?', [phone]);
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'This mobile number is already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      `INSERT INTO workers (name, phone, password_hash, skill, experience, city, area, about, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [name.trim(), phone, hash, skill, parseInt(experience), city.trim(), area.trim(), about?.trim() || '']
    );

    // Log registration event
    await pool.execute(
      `INSERT INTO analytics (worker_id, event_type, ip_address) VALUES (?, 'registration', ?)`,
      [result.insertId, req.ip]
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful! Your profile is pending admin approval.',
      workerId: result.insertId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/workers/profile ── Update own profile (auth required)
router.put('/profile', verifyWorker, async (req, res) => {
  try {
    const { city, area, about, status } = req.body;
    const validStatuses = ['available', 'busy', 'offline'];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const updates = {};
    if (city)   updates.city = city.trim();
    if (area)   updates.area = area.trim();
    if (about !== undefined) updates.about = about.trim();
    if (status) updates.status = status;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), req.worker.id];
    await pool.execute(`UPDATE workers SET ${fields} WHERE id = ?`, values);

    const [rows] = await pool.execute(
      `SELECT id, name, skill, city, area, about, status, rating, total_reviews FROM workers WHERE id = ?`,
      [req.worker.id]
    );
    res.json({ success: true, message: 'Profile updated', data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/workers/:id/track ── Track call/whatsapp click
router.post('/:id/track', async (req, res) => {
  try {
    const { type } = req.body; // 'call' or 'whatsapp'
    if (!['call', 'whatsapp'].includes(type)) return res.status(400).json({ success: false });

    const col = type === 'call' ? 'call_clicks' : 'whatsapp_clicks';
    const event = type === 'call' ? 'call_click' : 'whatsapp_click';

    await pool.execute(`UPDATE workers SET ${col} = ${col} + 1 WHERE id = ?`, [req.params.id]);
    await pool.execute(
      `INSERT INTO analytics (worker_id, event_type, ip_address) VALUES (?, ?, ?)`,
      [req.params.id, event, req.ip]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ── POST /api/workers/:id/review ── Submit a review
router.post('/:id/review', async (req, res) => {
  try {
    const { reviewer_name, rating, comment } = req.body;
    if (!reviewer_name || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Name and rating (1-5) required' });
    }
    const [check] = await pool.execute(
      `SELECT id FROM workers WHERE id = ? AND status != 'pending'`, [req.params.id]
    );
    if (!check.length) return res.status(404).json({ success: false, message: 'Worker not found' });

    await pool.execute(
      `INSERT INTO reviews (worker_id, reviewer_name, rating, comment) VALUES (?, ?, ?, ?)`,
      [req.params.id, reviewer_name.trim(), parseInt(rating), comment?.trim() || '']
    );
    // Recalculate average rating
    const [[avg]] = await pool.execute(
      `SELECT AVG(rating) as avg_rating, COUNT(*) as total FROM reviews WHERE worker_id = ?`,
      [req.params.id]
    );
    await pool.execute(
      `UPDATE workers SET rating = ?, total_reviews = ? WHERE id = ?`,
      [parseFloat(avg.avg_rating).toFixed(1), avg.total, req.params.id]
    );
    res.json({ success: true, message: 'Review submitted!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { verifyWorker } = require('../middleware/auth');

// -- GET /api/workers -- Only approved workers
router.get('/', async (req, res) => {
  try {
    const { skill, city, status } = req.query;
    let sql = `SELECT id, name, skill, experience, city, area, about, status,
                      rating, total_reviews, profile_views, call_clicks, whatsapp_clicks,
                      created_at
               FROM workers
               WHERE is_active = TRUE AND status IN ('available','busy','offline')`;
    const params = [];
    if (skill) { sql += ' AND skill = ?'; params.push(skill); }
    if (city)  { sql += ' AND (city LIKE ? OR area LIKE ?)'; params.push('%' + city + '%', '%' + city + '%'); }
    if (status && status !== 'all') { sql += ' AND status = ?'; params.push(status); }
    sql += " ORDER BY FIELD(status,'available','busy','offline'), rating DESC";
    const [rows] = await pool.execute(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- GET /api/workers/stats --
router.get('/stats', async (req, res) => {
  try {
    const [[total]] = await pool.execute(
      "SELECT COUNT(*) as total FROM workers WHERE is_active=TRUE AND status IN ('available','busy','offline')"
    );
    const [[available]] = await pool.execute(
      "SELECT COUNT(*) as available FROM workers WHERE status='available' AND is_active=TRUE"
    );
    const [[cities]] = await pool.execute(
      "SELECT COUNT(DISTINCT LOWER(city)) as cities FROM workers WHERE is_active=TRUE AND status IN ('available','busy','offline')"
    );
    res.json({ success: true, data: { total: total.total, available: available.available, cities: cities.cities } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- GET /api/workers/categories --
router.get('/categories', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT skill, COUNT(*) as count FROM workers WHERE is_active=TRUE AND status IN ('available','busy','offline') GROUP BY skill ORDER BY count DESC"
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- GET /api/workers/:id -- FIXED: comma added, phone included
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id, name, phone, skill, experience, city, area, about, status, rating, total_reviews, created_at FROM workers WHERE id = ? AND is_active = TRUE AND status IN ('available','busy','offline')",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Worker not found' });

    await pool.execute(
      "INSERT INTO analytics (worker_id, event_type, ip_address) VALUES (?, 'view', ?)",
      [req.params.id, req.ip]
    );
    await pool.execute(
      "UPDATE workers SET profile_views = profile_views + 1 WHERE id = ?",
      [req.params.id]
    );

    const [reviews] = await pool.execute(
      "SELECT reviewer_name, rating, comment, created_at FROM reviews WHERE worker_id = ? ORDER BY created_at DESC LIMIT 5",
      [req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], reviews } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- POST /api/workers/register --
router.post('/register', async (req, res) => {
  try {
    const { name, phone, password, skill, experience, city, area, about } = req.body;

    if (!name || !phone || !password || !skill || !experience || !city || !area) {
      return res.status(400).json({ success: false, message: 'All required fields must be filled' });
    }
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const [existing] = await pool.execute('SELECT id FROM workers WHERE phone = ?', [phone]);
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'This mobile number is already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      "INSERT INTO workers (name, phone, password_hash, skill, experience, city, area, about, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
      [name.trim(), phone, hash, skill, parseInt(experience), city.trim(), area.trim(), about?.trim() || '']
    );

    await pool.execute(
      "INSERT INTO analytics (worker_id, event_type, ip_address) VALUES (?, 'registration', ?)",
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

// -- PUT /api/workers/profile -- Update own profile (auth required)
router.put('/profile', verifyWorker, async (req, res) => {
  try {
    const { city, area, about, status } = req.body;
    const validStatuses = ['available', 'busy', 'offline'];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    // Pending worker cannot change status
    if (status) {
      const [workerCheck] = await pool.execute(
        'SELECT status FROM workers WHERE id = ?',
        [req.worker.id]
      );
      if (workerCheck.length && workerCheck[0].status === 'pending') {
        return res.status(403).json({
          success: false,
          message: 'Your profile is pending admin approval. You cannot change your status yet.'
        });
      }
    }

    const updates = {};
    if (city)  updates.city = city.trim();
    if (area)  updates.area = area.trim();
    if (about !== undefined) updates.about = about.trim();
    if (status) updates.status = status;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const fields = Object.keys(updates).map(k => k + ' = ?').join(', ');
    const values = [...Object.values(updates), req.worker.id];
    await pool.execute('UPDATE workers SET ' + fields + ' WHERE id = ?', values);

    const [rows] = await pool.execute(
      'SELECT id, name, skill, city, area, about, status, rating, total_reviews FROM workers WHERE id = ?',
      [req.worker.id]
    );
    res.json({ success: true, message: 'Profile updated', data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- POST /api/workers/:id/track --
router.post('/:id/track', async (req, res) => {
  try {
    const { type } = req.body;
    if (!['call', 'whatsapp'].includes(type)) return res.status(400).json({ success: false });
    const col = type === 'call' ? 'call_clicks' : 'whatsapp_clicks';
    const event = type === 'call' ? 'call_click' : 'whatsapp_click';
    await pool.execute('UPDATE workers SET ' + col + ' = ' + col + ' + 1 WHERE id = ?', [req.params.id]);
    await pool.execute(
      "INSERT INTO analytics (worker_id, event_type, ip_address) VALUES (?, ?, ?)",
      [req.params.id, event, req.ip]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// -- POST /api/workers/:id/review --
router.post('/:id/review', async (req, res) => {
  try {
    const { reviewer_name, rating, comment } = req.body;
    if (!reviewer_name || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Name and rating (1-5) required' });
    }
    const [check] = await pool.execute(
      "SELECT id FROM workers WHERE id = ? AND status IN ('available','busy','offline')",
      [req.params.id]
    );
    if (!check.length) return res.status(404).json({ success: false, message: 'Worker not found' });

    await pool.execute(
      "INSERT INTO reviews (worker_id, reviewer_name, rating, comment) VALUES (?, ?, ?, ?)",
      [req.params.id, reviewer_name.trim(), parseInt(rating), comment?.trim() || '']
    );
    const [[avg]] = await pool.execute(
      'SELECT AVG(rating) as avg_rating, COUNT(*) as total FROM reviews WHERE worker_id = ?',
      [req.params.id]
    );
    await pool.execute(
      'UPDATE workers SET rating = ?, total_reviews = ? WHERE id = ?',
      [parseFloat(avg.avg_rating).toFixed(1), avg.total, req.params.id]
    );
    res.json({ success: true, message: 'Review submitted!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { verifyAdmin } = require('../middleware/auth');

// ── POST /api/admin/login ──
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const token = jwt.sign({ role: 'admin', username }, process.env.JWT_SECRET, { expiresIn: '12h' });
    return res.json({ success: true, message: 'Admin login successful', token });
  }
  res.status(401).json({ success: false, message: 'Invalid admin credentials' });
});

// ── GET /api/admin/dashboard ── Summary stats
router.get('/dashboard', verifyAdmin, async (req, res) => {
  try {
    const [[totals]] = await pool.execute(`
      SELECT
        COUNT(*) as total,
        SUM(status = 'pending')   as pending,
        SUM(status = 'available') as available,
        SUM(status = 'busy')      as busy,
        SUM(status = 'offline')   as offline
      FROM workers WHERE is_active = TRUE
    `);

    // Registrations last 7 days
    const [recentRegs] = await pool.execute(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM workers
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at) ORDER BY date ASC
    `);

    // Top skills
    const [topSkills] = await pool.execute(`
      SELECT skill, COUNT(*) as count FROM workers
      WHERE is_active=TRUE AND status != 'pending'
      GROUP BY skill ORDER BY count DESC LIMIT 5
    `);

    // Top cities
    const [topCities] = await pool.execute(`
      SELECT city, COUNT(*) as count FROM workers
      WHERE is_active=TRUE AND status != 'pending'
      GROUP BY city ORDER BY count DESC LIMIT 5
    `);

    // Analytics last 7 days
    const [activityLog] = await pool.execute(`
      SELECT event_type, COUNT(*) as count, DATE(created_at) as date
      FROM analytics
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY event_type, DATE(created_at)
      ORDER BY date DESC
    `);

    // Total events summary
    const [[eventTotals]] = await pool.execute(`
      SELECT
        SUM(event_type='view')           as total_views,
        SUM(event_type='call_click')     as total_calls,
        SUM(event_type='whatsapp_click') as total_wa,
        SUM(event_type='search')         as total_searches,
        SUM(event_type='registration')   as total_registrations
      FROM analytics
    `);

    res.json({
      success: true,
      data: { totals, recentRegs, topSkills, topCities, activityLog, eventTotals }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/workers ── All workers with filters
router.get('/workers', verifyAdmin, async (req, res) => {
  try {
    const { status, skill, city, search, page = 1, limit = 20 } = req.query;
    let sql = `
      SELECT id, name, phone, skill, experience, city, area, status,
             rating, total_reviews, profile_views, call_clicks, whatsapp_clicks,
             is_active, created_at
      FROM workers WHERE 1=1
    `;
    const params = [];

    if (status)  { sql += ' AND status = ?'; params.push(status); }
    if (skill)   { sql += ' AND skill = ?'; params.push(skill); }
    if (city)    { sql += ' AND city LIKE ?'; params.push(`%${city}%`); }
    if (search)  {
      sql += ' AND (name LIKE ? OR phone LIKE ? OR city LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Count total
    const countSql = sql.replace(
      /SELECT .+ FROM workers/,
      'SELECT COUNT(*) as total FROM workers'
    );
    const [[{ total }]] = await pool.execute(countSql, params);

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [workers] = await pool.execute(sql, params);
    res.json({ success: true, data: workers, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/admin/workers/:id/approve ── Approve pending worker
router.put('/workers/:id/approve', verifyAdmin, async (req, res) => {
  try {
    const [result] = await pool.execute(
      `UPDATE workers SET status = 'available' WHERE id = ? AND status = 'pending'`,
      [req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: 'Worker not found or already approved' });
    }
    res.json({ success: true, message: 'Worker approved and now visible to customers' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/admin/workers/:id/reject ── Reject (soft delete) pending worker
router.put('/workers/:id/reject', verifyAdmin, async (req, res) => {
  try {
    await pool.execute(
      `UPDATE workers SET is_active = FALSE, status = 'offline' WHERE id = ?`,
      [req.params.id]
    );
    res.json({ success: true, message: 'Worker rejected and hidden from platform' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/admin/workers/:id ── Permanently delete worker
router.delete('/workers/:id', verifyAdmin, async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM workers WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }
    res.json({ success: true, message: 'Worker permanently deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/admin/workers/:id/status ── Force change any worker status
router.put('/workers/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['available', 'busy', 'offline', 'pending'];
    if (!valid.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    await pool.execute('UPDATE workers SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, message: `Worker status updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/analytics ── Detailed analytics
router.get('/analytics', verifyAdmin, async (req, res) => {
  try {
    const { days = 7 } = req.query;

    // Daily events
    const [dailyEvents] = await pool.execute(`
      SELECT DATE(created_at) as date,
             SUM(event_type='view') as views,
             SUM(event_type='call_click') as calls,
             SUM(event_type='whatsapp_click') as whatsapp,
             SUM(event_type='registration') as registrations
      FROM analytics
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY DATE(created_at) ORDER BY date ASC
    `, [parseInt(days)]);

    // Most viewed workers
    const [topWorkers] = await pool.execute(`
      SELECT w.id, w.name, w.skill, w.city,
             w.profile_views, w.call_clicks, w.whatsapp_clicks
      FROM workers w
      WHERE w.is_active=TRUE AND w.status != 'pending'
      ORDER BY w.profile_views DESC LIMIT 10
    `);

    res.json({ success: true, data: { dailyEvents, topWorkers } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

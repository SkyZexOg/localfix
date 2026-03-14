const router = require('express').Router();
const { pool } = require('../db');

// ── POST /api/analytics/search ── Log a search event
router.post('/search', async (req, res) => {
  try {
    const { query } = req.body;
    await pool.execute(
      `INSERT INTO analytics (event_type, extra_data, ip_address) VALUES ('search', ?, ?)`,
      [query || '', req.ip]
    );
    res.json({ success: true });
  } catch {
    res.json({ success: false });
  }
});

module.exports = router;

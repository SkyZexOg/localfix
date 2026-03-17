const router = require('express').Router();
const { pool } = require('../db');
const { verifyUser } = require('../middleware/auth');

// POST /api/ratings - logged-in user rates worker (upsert)
router.post('/', verifyUser, async (req, res) => {
  try {
    const { worker_id, rating, review, booking_id } = req.body;
    if (!worker_id || !rating || rating < 1 || rating > 5)
      return res.status(400).json({ success: false, message: 'worker_id and rating (1-5) required' });

    // Optional: only allow rating if booking is completed
    if (booking_id) {
      const [booking] = await pool.execute(
        "SELECT id FROM bookings WHERE id = ? AND user_id = ? AND worker_id = ? AND status = 'completed'",
        [booking_id, req.user.id, worker_id]
      );
      if (!booking.length)
        return res.status(403).json({ success: false, message: 'Can only rate after completed booking' });
    }

    // Upsert - update if already rated, insert if new
    await pool.execute(
      `INSERT INTO ratings (user_id, worker_id, booking_id, rating, review)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), review = VALUES(review)`,
      [req.user.id, worker_id, booking_id || null, parseInt(rating), review || '']
    );

    // Recalculate worker average from ratings table
    const [[avg]] = await pool.execute(
      'SELECT AVG(rating) as avg_rating, COUNT(*) as total FROM ratings WHERE worker_id = ?',
      [worker_id]
    );
    await pool.execute(
      'UPDATE workers SET rating = ?, total_reviews = ? WHERE id = ?',
      [parseFloat(avg.avg_rating).toFixed(1), avg.total, worker_id]
    );

    res.json({ success: true, message: 'Rating submitted!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/ratings/worker/:id - get all ratings for a worker
router.get('/worker/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT r.rating, r.review, r.created_at, u.name as reviewer_name
       FROM ratings r
       JOIN users u ON r.user_id = u.id
       WHERE r.worker_id = ?
       ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    const [[avg]] = await pool.execute(
      'SELECT AVG(rating) as avg_rating, COUNT(*) as total FROM ratings WHERE worker_id = ?',
      [req.params.id]
    );
    res.json({
      success: true,
      data: rows,
      avg_rating: parseFloat(avg.avg_rating || 0).toFixed(1),
      total: avg.total
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

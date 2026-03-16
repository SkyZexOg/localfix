const router = require('express').Router();
const { pool } = require('../db');
const { verifyUser, verifyWorker } = require('../middleware/auth');

// POST /api/bookings — user books a worker
router.post('/', verifyUser, async (req, res) => {
  try {
    const { worker_id, booking_date, booking_time, note } = req.body;
    if (!worker_id || !booking_date || !booking_time)
      return res.status(400).json({ success: false, message: 'worker_id, date and time required' });

    // Check worker exists and is available
    const [worker] = await pool.execute(
      "SELECT id, name FROM workers WHERE id = ? AND status = 'available' AND is_active = TRUE",
      [worker_id]
    );
    if (!worker.length)
      return res.status(404).json({ success: false, message: 'Worker not available' });

    const [result] = await pool.execute(
      'INSERT INTO bookings (user_id, worker_id, booking_date, booking_time, note) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, worker_id, booking_date, booking_time, note || '']
    );

    res.status(201).json({ success: true, message: 'Booking request sent!', bookingId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/bookings/my — user's bookings
router.get('/my', verifyUser, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT b.*, w.name as worker_name, w.skill, w.phone as worker_phone
       FROM bookings b
       JOIN workers w ON b.worker_id = w.id
       WHERE b.user_id = ?
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/bookings/worker — worker sees their bookings
router.get('/worker', verifyWorker, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT b.*, u.name as user_name, u.email as user_email
       FROM bookings b
       JOIN users u ON b.user_id = u.id
       WHERE b.worker_id = ?
       ORDER BY b.created_at DESC`,
      [req.worker.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/bookings/:id/status — worker accepts/rejects
router.put('/:id/status', verifyWorker, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['accepted', 'rejected', 'completed'].includes(status))
      return res.status(400).json({ success: false, message: 'Invalid status' });

    const [result] = await pool.execute(
      'UPDATE bookings SET status = ? WHERE id = ? AND worker_id = ?',
      [status, req.params.id, req.worker.id]
    );
    if (!result.affectedRows)
      return res.status(404).json({ success: false, message: 'Booking not found' });

    res.json({ success: true, message: `Booking ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

const router = require('express').Router();
const { pool } = require('../db');

// Haversine formula — returns distance in km
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// GET /api/nearby?lat=XX&lng=YY&skill=Plumber&radius=20
router.get('/', async (req, res) => {
  try {
    const { lat, lng, skill, radius = 20 } = req.query;
    if (!lat || !lng)
      return res.status(400).json({ success: false, message: 'lat and lng required' });

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const maxRadius = parseFloat(radius);

    let sql = `SELECT id, name, phone, skill, experience, city, area, about,
                      status, rating, total_reviews, lat, lng
               FROM workers
               WHERE is_active = TRUE
               AND status IN ('available','busy','offline')
               AND lat IS NOT NULL AND lng IS NOT NULL`;
    const params = [];
    if (skill) { sql += ' AND skill = ?'; params.push(skill); }

    const [rows] = await pool.execute(sql, params);

    // Calculate distance for each worker and filter by radius
    const nearby = rows
      .map(w => ({
        ...w,
        distance: haversine(userLat, userLng, parseFloat(w.lat), parseFloat(w.lng))
      }))
      .filter(w => w.distance <= maxRadius)
      .sort((a, b) => a.distance - b.distance);

    res.json({ success: true, data: nearby });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

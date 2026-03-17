require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { testConnection } = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

// -- Middleware ------------------------------------------
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.FRONTEND_URL, /\.railway\.app$/]
    : '*',
  credentials: true
}));

// Rate limiting - prevent spam
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { success: false, message: 'Too many requests, please try again later.' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts.' }
});

app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/admin/login', authLimiter);

// Serve static frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));

// -- Routes ----------------------------------------------
app.use('/api/workers', require('./routes/workers'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/users', require('./routes/users'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/ratings', require('./routes/ratings'));
app.use('/api/nearby', require('./routes/nearby'));
app.use('/api/ai', require('./routes/ai')); // AI Assistant route

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'LocalFix API running', time: new Date().toISOString() });
});

// Catch-all: serve frontend for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// -- Start -----------------------------------------------
async function start() {
  await testConnection();
  app.listen(PORT, () => {
    console.log(` LocalFix server running on port ${PORT}`);
    console.log(` http://localhost:${PORT}`);
  });
}

start();

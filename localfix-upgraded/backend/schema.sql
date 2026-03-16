-- =============================================
-- LocalFix Database Schema
-- Run this SQL in your MySQL database
-- =============================================

CREATE DATABASE IF NOT EXISTS localfix CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE localfix;

-- Workers table
CREATE TABLE IF NOT EXISTS workers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(15) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  skill VARCHAR(50) NOT NULL,
  experience INT DEFAULT 0,
  city VARCHAR(100) NOT NULL,
  area VARCHAR(100) NOT NULL,
  about TEXT,
  status ENUM('pending', 'available', 'busy', 'offline') DEFAULT 'pending',
  rating DECIMAL(3,1) DEFAULT 0.0,
  total_reviews INT DEFAULT 0,
  profile_views INT DEFAULT 0,
  call_clicks INT DEFAULT 0,
  whatsapp_clicks INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Reviews table
CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  worker_id INT NOT NULL,
  reviewer_name VARCHAR(100) NOT NULL,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

-- Analytics / Activity Log
CREATE TABLE IF NOT EXISTS analytics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  worker_id INT,
  event_type ENUM('view', 'call_click', 'whatsapp_click', 'search', 'registration') NOT NULL,
  extra_data VARCHAR(255),
  ip_address VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL
);

-- Admin sessions table
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

-- Index for faster searches
CREATE INDEX idx_workers_skill ON workers(skill);
CREATE INDEX idx_workers_city ON workers(city);
CREATE INDEX idx_workers_status ON workers(status);
CREATE INDEX idx_analytics_event ON analytics(event_type);
CREATE INDEX idx_analytics_created ON analytics(created_at);

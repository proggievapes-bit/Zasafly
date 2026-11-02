CREATE DATABASE IF NOT EXISTS zasafly
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE zasafly;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  student_number VARCHAR(80) NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  institution VARCHAR(190) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('student','admin') NOT NULL DEFAULT 'student',
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_users_created_at (created_at),
  INDEX idx_users_role_status (role, status)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(60) NOT NULL,
  description VARCHAR(255) NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL,
  INDEX idx_activity_created_at (created_at),
  INDEX idx_activity_event_type (event_type),
  INDEX idx_activity_user_id (user_id)
);

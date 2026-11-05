CREATE TABLE IF NOT EXISTS quota_checks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  key_hash CHAR(64) NOT NULL,
  checked_at VARCHAR(40) NOT NULL,
  used_micros BIGINT NOT NULL,
  remaining_micros BIGINT NULL,
  INDEX quota_checks_key_time_idx (key_hash, checked_at, id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS billing_connection (
  id INT PRIMARY KEY,
  encrypted_session TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  refresh_lock_until BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS billing_enrollment (
  key_hash CHAR(64) PRIMARY KEY,
  api_key_id VARCHAR(128) NOT NULL UNIQUE,
  key_mask VARCHAR(128) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS request_limits (
  bucket_hash CHAR(64) PRIMARY KEY,
  reset_at BIGINT NOT NULL,
  request_count INT NOT NULL DEFAULT 0,
  INDEX request_limits_reset_idx (reset_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS keymeter_locks (
  id VARCHAR(100) PRIMARY KEY
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  INDEX auth_sessions_expiry_idx (expires_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id CHAR(36) PRIMARY KEY,
  attempted_at BIGINT NOT NULL,
  INDEX auth_login_attempts_time_idx (attempted_at)
) ENGINE=InnoDB;

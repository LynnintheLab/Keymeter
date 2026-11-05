CREATE TABLE IF NOT EXISTS owner_email_challenges (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  owner_email VARCHAR(254) NOT NULL,
  owner_version VARCHAR(40) NOT NULL,
  purpose VARCHAR(20) NOT NULL,
  new_email VARCHAR(254) NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  delivered TINYINT NOT NULL DEFAULT 0,
  remember_browser TINYINT NOT NULL DEFAULT 0,
  sent_at BIGINT NOT NULL,
  INDEX owner_email_challenges_expiry_idx (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS owner_account (
  id INT PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  version CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;

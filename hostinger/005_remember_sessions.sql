SET @keymeter_remember_session_sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE auth_sessions ADD COLUMN remember_browser TINYINT(1) NOT NULL DEFAULT 0',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'auth_sessions' AND column_name = 'remember_browser'
);
PREPARE keymeter_remember_session_statement FROM @keymeter_remember_session_sql;
EXECUTE keymeter_remember_session_statement;
DEALLOCATE PREPARE keymeter_remember_session_statement;
SET @keymeter_remember_session_sql = NULL;

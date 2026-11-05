SET @keymeter_owner_key_sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE owner_account ADD COLUMN password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'owner_account' AND column_name = 'password_hash'
);
PREPARE keymeter_owner_key_statement FROM @keymeter_owner_key_sql;
EXECUTE keymeter_owner_key_statement;
DEALLOCATE PREPARE keymeter_owner_key_statement;
SET @keymeter_owner_key_sql = NULL;

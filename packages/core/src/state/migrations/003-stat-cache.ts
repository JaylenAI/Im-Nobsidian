export const STAT_CACHE_MIGRATION = `
ALTER TABLE sync_state ADD COLUMN local_mtime TEXT;
ALTER TABLE sync_state ADD COLUMN local_file_size INTEGER;

UPDATE sync_metadata SET value = '3' WHERE key = 'schema_version';
`;

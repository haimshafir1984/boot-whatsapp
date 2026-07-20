import { config } from './config';
import { createPostgresBackend } from './database';
import { emptyStorageData, Storage } from './storage';

export async function createStorage(): Promise<Storage> {
  if (!config.DATABASE_URL) {
    console.log('  Storage mode: JSON');
    return new Storage(config.STORAGE_PATH);
  }

  console.log('  Storage mode: PostgreSQL');
  const backend = await createPostgresBackend(config.DATABASE_URL);
  const snapshot = await backend.loadSnapshot();
  if (!snapshot) {
    console.warn('  PostgreSQL storage is empty. Run the JSON migration tool before enabling this for an existing client.');
  }
  return new Storage(config.STORAGE_PATH, {
    initialData: snapshot ?? emptyStorageData(),
    backend,
  });
}

#!/usr/bin/env node
const path = require('path');
const { config } = require('../dist/config');
const { loadStorageDataFromFile } = require('../dist/storage');
const { migrateDatabase, replaceStorageSnapshot } = require('../dist/database');

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const databaseUrl = process.env.DATABASE_URL || config.DATABASE_URL;
  const force = args.has('--force');
  const storagePath = process.env.STORAGE_PATH || config.STORAGE_PATH;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for PostgreSQL migration.');
  }

  const absoluteStoragePath = path.resolve(storagePath);
  const data = loadStorageDataFromFile(absoluteStoragePath);
  const counts = {
    campaigns: data.campaigns.length,
    contacts: data.contactsList.length,
    contactQueue: data.contactQueue.length,
    campaignResults: data.campaignResults.length,
    campaignEvents: data.campaignEvents.length,
    uploadedFiles: data.uploadedFiles.length,
    twilioTemplates: data.twilioTemplates.length,
  };

  console.log('JSON -> PostgreSQL migration');
  console.log(`Mode: ${apply ? 'apply' : 'dry-run'}`);
  console.log(`Storage file: ${absoluteStoragePath}`);
  console.log('Counts before import:', counts);

  if (!apply) {
    await migrateDatabase(databaseUrl);
    console.log('Dry-run completed. Database migrations were checked, but no JSON data was imported.');
    console.log('Run with --apply to import the JSON snapshot idempotently.');
    return;
  }

  const result = await replaceStorageSnapshot(databaseUrl, data, { force });
  if (result === 'unchanged') {
    console.log('Import skipped: PostgreSQL already contains the identical JSON snapshot.');
  } else {
    console.log('Import completed. PostgreSQL now contains the supplied JSON snapshot.');
  }
  console.log('JSON file was not modified or deleted.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

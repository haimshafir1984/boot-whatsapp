#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { config } = require('../dist/config');
const { loadStorageSnapshot } = require('../dist/database');

function argumentValue(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || config.DATABASE_URL;
  const output = argumentValue('output');
  const force = process.argv.includes('--force');

  if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL export.');
  if (!output) {
    throw new Error('An explicit output path is required. Example: npm run db:export -- --output ./data/contacts-from-postgres.json');
  }

  const outputPath = path.resolve(output);
  if (fs.existsSync(outputPath) && !force) {
    throw new Error(`Output already exists: ${outputPath}. Use a new path or pass --force.`);
  }

  const data = await loadStorageSnapshot(databaseUrl);
  if (!data) throw new Error('PostgreSQL does not contain a storage snapshot.');

  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data), 'utf8');
  fs.renameSync(temporaryPath, outputPath);

  console.log('PostgreSQL -> JSON export completed.');
  console.log(`Output: ${outputPath}`);
  console.log('The active storage file and PostgreSQL database were not modified.');
  console.log('Counts:', {
    campaigns: data.campaigns?.length ?? 0,
    contacts: data.contactsList?.length ?? 0,
    contactQueue: data.contactQueue?.length ?? 0,
    campaignResults: data.campaignResults?.length ?? 0,
    campaignEvents: data.campaignEvents?.length ?? 0,
    outboxMessages: data.outboxMessages?.length ?? 0,
    pendingConversations: Object.keys(data.conversationStateSnapshot?.conversations ?? {}).length,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});


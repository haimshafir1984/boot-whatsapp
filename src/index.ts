/**
 * index.ts
 * Entry point – starts the admin HTTP server then the WhatsApp client.
 */

import { createWhatsAppClient } from './whatsapp';
import { Storage } from './storage';
import { startAdminServer } from './adminServer';
import { config } from './config';

async function main(): Promise<void> {
  console.log('─'.repeat(50));
  console.log('  WhatsApp Status Bot – starting up…');
  console.log('─'.repeat(50));
  console.log(`  My card : ${config.MY_CONTACT.name} ${config.MY_CONTACT.phone}`);
  console.log('─'.repeat(50) + '\n');

  const storage = new Storage(config.STORAGE_PATH);

  startAdminServer(storage);

  const client = createWhatsAppClient(storage);
  await client.initialize();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

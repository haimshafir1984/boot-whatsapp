/**
 * index.ts
 * Entry point – starts the admin HTTP server then the WhatsApp client.
 */

import fs from 'fs';
import path from 'path';
import { Storage } from './storage';
import { startAdminServer } from './adminServer';
import { config } from './config';
import { startContactSaveQueue } from './contactQueue';
import { startWhatsAppScheduler } from './whatsappLifecycle';

function removeSingletonLocks(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removeSingletonLocks(full);
      } else if (entry.name.startsWith('Singleton')) {
        fs.unlinkSync(full);
        console.log(`  Removed stale lock: ${entry.name}`);
      }
    }
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  console.log('─'.repeat(50));
  console.log('  WhatsApp Status Bot – starting up…');
  console.log('─'.repeat(50));
  console.log(`  Contact card configured : ${config.MY_CONTACT.phone ? 'yes' : 'no'}`);
  console.log(`  Storage  : ${path.resolve(config.STORAGE_PATH)}`);
  console.log('─'.repeat(50) + '\n');

  removeSingletonLocks(config.SESSION_PATH);

  const storage = new Storage(config.STORAGE_PATH);

  startContactSaveQueue(storage);

  startAdminServer(storage);

  if (config.WHATSAPP_PROVIDER === 'TWILIO_API') {
    console.log('  WhatsApp provider: Twilio API (webhook mode, no Chromium scheduler)');
  } else {
    startWhatsAppScheduler(storage);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

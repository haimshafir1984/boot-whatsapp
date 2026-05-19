/**
 * vcard.ts
 * Builds a vCard 3.0 string from MY_CONTACT config values.
 * WhatsApp renders this as a tappable "contact card" in the chat.
 */

import { config } from './config';

export function generateVCard(): string {
  const { name, phone, email, organization } = config.MY_CONTACT;

  const lines: string[] = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `TEL;TYPE=CELL:${phone}`,
  ];

  if (email) {
    lines.push(`EMAIL:${email}`);
  }

  if (organization) {
    lines.push(`ORG:${organization}`);
  }

  lines.push('END:VCARD');

  return lines.join('\n');
}

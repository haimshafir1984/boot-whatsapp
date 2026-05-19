/**
 * icloudContacts.ts
 * Saves contacts to iCloud via CardDAV protocol.
 * Requires an App-Specific Password from appleid.apple.com
 */

import https from 'https';
import crypto from 'crypto';

interface HttpResponse {
  status: number;
  body: string;
}

function request(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: Number(parsed.port) || 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      // Follow redirect
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(request(res.headers.location, method, headers, body));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function extractHref(xml: string, afterTag: string): string | null {
  const re = new RegExp(
    afterTag + '[\\s\\S]*?<[Dd]:[Hh][Rr][Ee][Ff]>(.*?)<\\/[Dd]:[Hh][Rr][Ee][Ff]>',
  );
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

async function getPrincipalPath(auth: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;

  const res = await request('https://contacts.icloud.com/', 'PROPFIND', {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: '0',
  }, body);

  if (res.status === 401) throw new Error('Apple ID או סיסמת App-Specific שגויים');
  if (res.status >= 400) throw new Error(`שגיאת iCloud: ${res.status}`);

  const path = extractHref(res.body, 'current-user-principal');
  if (!path) throw new Error('לא נמצא principal URL — ודא שהסיסמה היא App-Specific Password');
  return path;
}

async function getAddressbookPath(auth: string, principalPath: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><C:addressbook-home-set xmlns:C="urn:ietf:params:xml:ns:carddav"/></D:prop>
</D:propfind>`;

  const res = await request(`https://contacts.icloud.com${principalPath}`, 'PROPFIND', {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: '0',
  }, body);

  const homePath = extractHref(res.body, 'addressbook-home-set');
  if (!homePath) throw new Error('לא נמצא addressbook-home-set');
  return homePath + 'card/';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function testICloudConnection(email: string, appPassword: string): Promise<void> {
  const auth = Buffer.from(`${email}:${appPassword}`).toString('base64');
  await getPrincipalPath(auth);
}

export async function saveContactToICloud(
  email: string,
  appPassword: string,
  displayName: string,
  phone: string,
): Promise<void> {
  const auth          = Buffer.from(`${email}:${appPassword}`).toString('base64');
  const principalPath = await getPrincipalPath(auth);
  const abPath        = await getAddressbookPath(auth, principalPath);
  const uid           = crypto.randomUUID();

  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${displayName}`,
    `N:${displayName};;;;`,
    `TEL;TYPE=CELL:${phone}`,
    `UID:${uid}`,
    'END:VCARD',
  ].join('\r\n');

  const res = await request(
    `https://contacts.icloud.com${abPath}${uid}.vcf`,
    'PUT',
    {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'text/vcard; charset=utf-8',
    },
    vcard,
  );

  if (res.status >= 400) throw new Error(`שגיאת iCloud בשמירה: ${res.status}`);
  console.log(`✅ iCloud Contacts: saved "${displayName}" (${phone})`);
}

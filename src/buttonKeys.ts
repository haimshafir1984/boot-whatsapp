/**
 * Key allocation for signed reply buttons (P-provisioning). The admin service holds two MASTER key rings and derives everything a client
 * needs from them, so nothing has to be stored per client and a redeploy always produces the same values (buttons already sent stay valid):
 *   META_BUTTON_ROUTE_MASTER_KEYS   kid:key,...   (the same ring the gateway verifies routing signatures with)
 *   META_BUTTON_FULL_MASTER_KEYS    kid:key,...   (admin only; never given to a client)
 * A client receives, for the kids present in BOTH rings: its id, its derived routing keys and its derived full keys.
 *   route key = HMAC(routeMaster, "route-key/v1\n"+clientId)   (src/buttonToken.ts deriveRouteKey)
 *   full key  = HMAC(fullMaster,  "full-key/v1\n"+clientId)
 * A client can therefore sign only for itself, and the gateway can check routing but cannot forge the client-side signature of an id it
 * did not see. (The admin service holds both masters, so this protects against a client, not against the admin host itself.)
 */
import { createHmac } from 'node:crypto';
import { deriveRouteKey } from './buttonToken';
import { parseKeyList } from './buttonVerify';

export function deriveFullKey(fullMaster: Buffer, clientId: string): Buffer {
  return createHmac('sha256', fullMaster).update(`full-key/v1\n${clientId}`).digest();
}

export interface ClientButtonEnv {
  META_BUTTON_CLIENT_ID: string;
  META_BUTTON_ROUTE_KEYS: string;
  META_BUTTON_FULL_KEYS: string;
}

/** The three variables for one client, or undefined when the rings are not both configured (the feature stays unprovisioned). */
export function clientButtonEnv(clientId: string, routeMasterText: string | undefined, fullMasterText: string | undefined): ClientButtonEnv | undefined {
  const id = String(clientId ?? '').trim();
  const routeMasters = parseKeyList(routeMasterText);
  const fullMasters = parseKeyList(fullMasterText);
  if (!id || !routeMasters.size || !fullMasters.size) return undefined;
  const route: string[] = []; const full: string[] = [];
  for (const [kid, routeMaster] of routeMasters) {
    const fullMaster = fullMasters.get(kid);
    if (!fullMaster) continue;
    route.push(`${kid}:${deriveRouteKey(routeMaster, id).toString('base64url')}`);
    full.push(`${kid}:${deriveFullKey(fullMaster, id).toString('base64url')}`);
  }
  if (!route.length) return undefined;
  return { META_BUTTON_CLIENT_ID: id, META_BUTTON_ROUTE_KEYS: route.join(','), META_BUTTON_FULL_KEYS: full.join(',') };
}

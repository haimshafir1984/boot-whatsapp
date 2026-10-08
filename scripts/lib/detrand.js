/**
 * Identity-keyed deterministic randomness for the peak harness.
 *
 * A PRNG shared by a whole process gives each draw to whoever asks next, and in an asynchronous system "who asks next" changes from run
 * to run - the same seed then injects DIFFERENT faults. Here every decision is a pure function of (seed, identity parts, salt), so the
 * same message gets the same fault in every run, whatever the timing:
 *
 *   unit(seed, 'lost', messageKey, attempt)   -> [0,1)
 *   gauss(seed, 'lat',  messageKey, attempt)  -> N(0,1)
 */
function hash32(str) {   // FNV-1a, then a murmur-style finalizer
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
function unit(...parts) {
  const a = hash32(parts.join('\u0001'));
  let t = (a + 0x6D2B79F5) | 0; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss(...parts) {
  const u1 = Math.max(unit(...parts, 'g1'), 1e-12); const u2 = unit(...parts, 'g2');
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
module.exports = { hash32, unit, gauss };

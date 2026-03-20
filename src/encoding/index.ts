/**
 * Canonical encoding for prolly tree keys and values.
 * 
 * DESIGN DECISIONS:
 * 
 * 1. Composite keys use a tuple encoding where lexicographic byte order
 *    matches logical order. This is the FoundationDB-style approach:
 *    - Strings: UTF-8 bytes with 0x00 escaped as 0x00 0xFF, terminated by 0x00 0x00
 *    - Uint8 type tags: single byte
 *    - Numbers (for sorted set scores, list indices): big-endian IEEE 754
 *      with sign bit flipped so negative < 0 < positive in byte order
 * 
 * 2. Node content uses a minimal binary format:
 *    - Varint lengths + raw bytes
 *    - No schema, no field names — position-defined
 *    - Deterministic by construction (no maps, no optional reordering)
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ── Varint encoding (unsigned LEB128) ──────────────────────────

export function encodeVarint(value: number): Uint8Array {
  if (value < 0) throw new RangeError('Varint must be non-negative');
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return new Uint8Array(bytes);
}

export function decodeVarint(data: Uint8Array, offset: number): [value: number, newOffset: number] {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos];
    value |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new RangeError('Varint too large');
  }
  return [value, pos];
}

// ── Length-prefixed bytes ──────────────────────────────────────

export function encodeLengthPrefixed(data: Uint8Array): Uint8Array {
  const lenBytes = encodeVarint(data.length);
  const out = new Uint8Array(lenBytes.length + data.length);
  out.set(lenBytes, 0);
  out.set(data, lenBytes.length);
  return out;
}

export function decodeLengthPrefixed(data: Uint8Array, offset: number): [value: Uint8Array, newOffset: number] {
  const [len, dataStart] = decodeVarint(data, offset);
  const value = data.slice(dataStart, dataStart + len);
  return [value, dataStart + len];
}

// ── Ordered key encoding ──────────────────────────────────────
// Keys must sort lexicographically in byte order to match logical order.

/** Type tags for composite key segments. Ordered so byte sort matches type priority. */
export const enum KeySegmentType {
  /** Null / empty marker */
  NULL = 0x00,
  /** Unsigned 8-bit integer */
  UINT8 = 0x01,
  /** IEEE 754 float64, sign-flipped for byte order */
  FLOAT64 = 0x02,
  /** UTF-8 string, escaped and terminated */
  STRING = 0x03,
  /** Raw bytes, length-prefixed */
  BYTES = 0x04,
}

/**
 * Encode a string for ordered key comparison.
 * Uses null-byte escaping: 0x00 → 0x00 0xFF, terminated by 0x00 0x00.
 */
export function encodeOrderedString(s: string): Uint8Array {
  const utf8 = TEXT_ENCODER.encode(s);
  // Count null bytes for sizing
  let nullCount = 0;
  for (let i = 0; i < utf8.length; i++) {
    if (utf8[i] === 0x00) nullCount++;
  }
  const out = new Uint8Array(1 + utf8.length + nullCount + 2); // tag + data + escapes + terminator
  out[0] = KeySegmentType.STRING;
  let pos = 1;
  for (let i = 0; i < utf8.length; i++) {
    out[pos++] = utf8[i];
    if (utf8[i] === 0x00) {
      out[pos++] = 0xff;
    }
  }
  out[pos++] = 0x00;
  out[pos++] = 0x00;
  return out.slice(0, pos);
}

export function decodeOrderedString(data: Uint8Array, offset: number): [value: string, newOffset: number] {
  if (data[offset] !== KeySegmentType.STRING) {
    throw new Error(`Expected STRING tag at offset ${offset}, got ${data[offset]}`);
  }
  let pos = offset + 1;
  const bytes: number[] = [];
  while (pos < data.length) {
    if (data[pos] === 0x00) {
      if (pos + 1 < data.length && data[pos + 1] === 0xff) {
        bytes.push(0x00);
        pos += 2;
      } else {
        // 0x00 0x00 = terminator
        pos += 2;
        break;
      }
    } else {
      bytes.push(data[pos]);
      pos++;
    }
  }
  return [TEXT_DECODER.decode(new Uint8Array(bytes)), pos];
}

/**
 * Encode a float64 for ordered byte comparison.
 * IEEE 754 big-endian with sign bit flipped.
 * This makes negative < 0 < positive in unsigned byte order.
 */
export function encodeOrderedFloat64(n: number): Uint8Array {
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  out[0] = KeySegmentType.FLOAT64;
  view.setFloat64(1, n, false); // big-endian
  if (n >= 0 || Object.is(n, 0)) {
    // Positive or +0: flip sign bit (0→1)
    out[1] ^= 0x80;
  } else {
    // Negative: flip all bits
    for (let i = 1; i < 9; i++) out[i] ^= 0xff;
  }
  return out;
}

export function decodeOrderedFloat64(data: Uint8Array, offset: number): [value: number, newOffset: number] {
  if (data[offset] !== KeySegmentType.FLOAT64) {
    throw new Error(`Expected FLOAT64 tag at offset ${offset}`);
  }
  const buf = new ArrayBuffer(8);
  const copy = new Uint8Array(buf);
  copy.set(data.slice(offset + 1, offset + 9));
  if (copy[0] & 0x80) {
    // Was positive: flip sign bit back
    copy[0] ^= 0x80;
  } else {
    // Was negative: flip all bits back
    for (let i = 0; i < 8; i++) copy[i] ^= 0xff;
  }
  const view = new DataView(buf);
  return [view.getFloat64(0, false), offset + 9];
}

/** Encode a uint8 tag byte. */
export function encodeUint8(n: number): Uint8Array {
  return new Uint8Array([KeySegmentType.UINT8, n & 0xff]);
}

export function decodeUint8(data: Uint8Array, offset: number): [value: number, newOffset: number] {
  if (data[offset] !== KeySegmentType.UINT8) {
    throw new Error(`Expected UINT8 tag at offset ${offset}`);
  }
  return [data[offset + 1], offset + 2];
}

// ── Composite key builder ─────────────────────────────────────

/** Concatenate encoded segments into a single key. */
export function compositeKey(...segments: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const s of segments) totalLen += s.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const s of segments) {
    out.set(s, pos);
    pos += s.length;
  }
  return out;
}

// ── Byte comparison ───────────────────────────────────────────

/** Compare two byte arrays lexicographically. Returns <0, 0, or >0. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// ── Node serialization ────────────────────────────────────────
// A prolly node is: [entry_count: varint, ...entries]
// Leaf entry: [key_bytes: length-prefixed, value_bytes: length-prefixed]
// Internal entry: [key_bytes: length-prefixed, child_hash: 32 bytes raw]

export function encodeLeafNode(entries: Array<{ key: Uint8Array; value: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [encodeVarint(entries.length)];
  for (const { key, value } of entries) {
    parts.push(encodeLengthPrefixed(key));
    parts.push(encodeLengthPrefixed(value));
  }
  return concatBytes(parts);
}

export function decodeLeafNode(data: Uint8Array): Array<{ key: Uint8Array; value: Uint8Array }> {
  let offset = 0;
  const [count, o1] = decodeVarint(data, offset);
  offset = o1;
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    const [key, o2] = decodeLengthPrefixed(data, offset);
    const [value, o3] = decodeLengthPrefixed(data, o2);
    entries.push({ key, value });
    offset = o3;
  }
  return entries;
}

export function encodeInternalNode(entries: Array<{ key: Uint8Array; childHash: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [encodeVarint(entries.length)];
  for (const { key, childHash } of entries) {
    parts.push(encodeLengthPrefixed(key));
    parts.push(childHash); // fixed 32 bytes, no length prefix needed
  }
  return concatBytes(parts);
}

export function decodeInternalNode(data: Uint8Array, hashLen: number = 32): Array<{ key: Uint8Array; childHash: Uint8Array }> {
  let offset = 0;
  const [count, o1] = decodeVarint(data, offset);
  offset = o1;
  const entries: Array<{ key: Uint8Array; childHash: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    const [key, o2] = decodeLengthPrefixed(data, offset);
    const childHash = data.slice(o2, o2 + hashLen);
    entries.push({ key, childHash });
    offset = o2 + hashLen;
  }
  return entries;
}

// ── Helpers ───────────────────────────────────────────────────

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

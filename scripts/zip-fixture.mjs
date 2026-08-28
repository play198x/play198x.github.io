/**
 * Builds ZIP fixtures in memory, for anything in this repository that needs an
 * archive to open. No media lives here — not a picture, not a tune, not a
 * disk — so every fixture is written byte by byte at the point of use, the
 * rule tests/player.spec.ts states and play198x-web's own tests/container.rs
 * follows.
 *
 * Shared rather than copied because the ZIP layout is a format, and two
 * hand-written implementations of a format drift: the sweep and the container
 * test would eventually disagree about what a valid archive looks like, and
 * whichever one was wrong would still be green. It sits in scripts/ because
 * that is the direction imports already run in this repository — the tests
 * take serve-dist.mjs from here, not the other way round.
 */

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return ~crc >>> 0;
}

function u16(value) {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  return buf;
}

function u32(value) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, true);
  return buf;
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Builds a stored (method 0, no compression) ZIP from `entries`, each
 * `{ name, bytes }`. Short enough to write by hand, per the brief — no
 * fixture files, ever. */
export function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);

    const localHeader = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(bytes.length), // compressed size
      u32(bytes.length), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra field length
    ]);
    const localEntry = concat([localHeader, nameBytes, bytes]);
    localParts.push(localEntry);

    const centralHeader = concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(bytes.length),
      u32(bytes.length),
      u16(nameBytes.length),
      u16(0), // extra field length
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal attributes
      u32(0), // external attributes
      u32(offset), // relative offset of local header
    ]);
    centralParts.push(concat([centralHeader, nameBytes]));

    offset += localEntry.length;
  }

  const centralDirectory = concat(centralParts);
  const localSection = concat(localParts);

  const endRecord = concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk with central directory
    u16(entries.length), // entries on this disk
    u16(entries.length), // total entries
    u32(centralDirectory.length),
    u32(localSection.length), // offset of central directory
    u16(0), // comment length
  ]);

  return concat([localSection, centralDirectory, endRecord]);
}

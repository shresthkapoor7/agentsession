export type SessionArchiveFile = {
  content: string;
  filename: string;
};

export type SessionArchivePage = {
  content: string;
  filename: string;
};

export type SessionArchive = {
  bytes: Uint8Array;
  downloadName: string;
  folderName: string;
  sessionFiles: string[];
};

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function write32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

type ZipEntry = { bytes: Uint8Array; name: string };

// A small, standards-compliant ZIP writer using the uncompressed "store" method.
// Keeping it local avoids adding a large client dependency just to create an archive.
function createZip(entries: ZipEntry[]) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length + entry.bytes.length);
    write32(local, 0, 0x04034b50);
    write16(local, 4, 20);
    write16(local, 6, 0x0800); // UTF-8 filenames
    write16(local, 8, 0); // stored, not compressed
    write16(local, 10, 0);
    write16(local, 12, 0);
    write32(local, 14, checksum);
    write32(local, 18, entry.bytes.length);
    write32(local, 22, entry.bytes.length);
    write16(local, 26, name.length);
    write16(local, 28, 0);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    write32(central, 0, 0x02014b50);
    write16(central, 4, 20);
    write16(central, 6, 20);
    write16(central, 8, 0x0800);
    write16(central, 10, 0);
    write16(central, 12, 0);
    write16(central, 14, 0);
    write32(central, 16, checksum);
    write32(central, 20, entry.bytes.length);
    write32(central, 24, entry.bytes.length);
    write16(central, 28, name.length);
    write16(central, 30, 0);
    write16(central, 32, 0);
    write16(central, 34, 0);
    write16(central, 36, 0);
    write32(central, 38, 0);
    write32(central, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(localOffset + centralSize + 22);
  let offset = 0;
  for (const part of localParts) { output.set(part, offset); offset += part.length; }
  const centralOffset = offset;
  for (const part of centralParts) { output.set(part, offset); offset += part.length; }
  write32(output, offset, 0x06054b50);
  write16(output, offset + 4, 0);
  write16(output, offset + 6, 0);
  write16(output, offset + 8, entries.length);
  write16(output, offset + 10, entries.length);
  write32(output, offset + 12, centralSize);
  write32(output, offset + 16, centralOffset);
  write16(output, offset + 20, 0);
  return output;
}

export function createSessionArchive({ assets, indexHtml, pages = [], provider, sessions }: {
  assets: { css: string; viewer: string };
  indexHtml: string;
  pages?: SessionArchivePage[];
  provider: "claude" | "codex";
  sessions: SessionArchiveFile[];
}): SessionArchive {
  const folderName = `agentsession-${provider}-sessions`;
  const sessionFiles = sessions.map((_, index) => sessions.length === 1 ? "session.jsonl" : `session-${index + 1}.jsonl`);
  const entries: ZipEntry[] = [
    { name: `${folderName}/`, bytes: new Uint8Array() },
    { name: `${folderName}/index.html`, bytes: encoder.encode(indexHtml) },
    { name: `${folderName}/codex-transcripts.css`, bytes: encoder.encode(assets.css) },
    { name: `${folderName}/codex-transcripts-viewer.js`, bytes: encoder.encode(assets.viewer) },
    ...pages.map((page) => ({ name: `${folderName}/${page.filename}`, bytes: encoder.encode(page.content) })),
    ...sessions.map((session, index) => ({ name: `${folderName}/${sessionFiles[index]}`, bytes: encoder.encode(session.content) })),
  ];
  return {
    bytes: createZip(entries),
    downloadName: `${folderName}.zip`,
    folderName,
    sessionFiles,
  };
}

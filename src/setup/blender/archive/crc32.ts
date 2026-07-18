const CRC32_TABLE = createCrc32Table();

export function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    const index = (crc ^ byte) & 0xff;
    crc = (crc >>> 8) ^ (CRC32_TABLE[index] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table(): readonly number[] {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
    table.push(value >>> 0);
  }
  return table;
}

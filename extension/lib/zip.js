// Minimal STORED ZIP writer (no compression; PDFs are already compressed).
// UTF-8 names (general purpose bit 11). Rejects archives that would need ZIP64.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time & 0xFFFF, day & 0xFFFF];
}

export class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.names = new Set(); }
  add(name, data, date = new Date()) {
    if (this.names.has(name)) throw new Error('ZIP_DUPLICATE');
    this.names.add(name);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    const nameBytes = new TextEncoder().encode(name);
    if (this.offset + bytes.length + 30 + nameBytes.length > 0xFFFFFFF0) throw new Error('ZIP_TOO_LARGE');
    const crc = crc32(bytes), [time, day] = dosTime(date);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, day, true);
    local.setUint32(14, crc, true); local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true); central.setUint16(10, 0, true); central.setUint16(12, time, true);
    central.setUint16(14, day, true); central.setUint32(16, crc, true); central.setUint32(20, bytes.length, true);
    central.setUint32(24, bytes.length, true); central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, this.offset, true);
    this.parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
    this.central.push(new Uint8Array(central.buffer), nameBytes);
    this.offset += 30 + nameBytes.length + bytes.length;
  }
  blob() {
    const size = this.central.reduce((n, p) => n + p.length, 0);
    if (this.names.size > 0xFFFF) throw new Error('ZIP_TOO_LARGE');
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, this.names.size, true); end.setUint16(10, this.names.size, true);
    end.setUint32(12, size, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, new Uint8Array(end.buffer)], {type: 'application/zip'});
  }
}

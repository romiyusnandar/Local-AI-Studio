// Parser GGUF minimal — hanya untuk membaca metadata, bukan tensor. Dipakai
// mengambil "<arch>.context_length" (n_ctx_train): panjang context maksimum
// yang dilatih model. Menyetel n_ctx di atas nilai ini bikin output melantur
// (tanpa rope scaling), jadi UI memakainya sebagai batas atas.
//
// Format GGUF: magic "GGUF" (u32) | version (u32) | tensor_count (u64) |
// kv_count (u64) | lalu kv_count entri metadata (key string + tipe + nilai).
// context_length ada di blok parameter arsitektur, jauh sebelum array
// tokenizer yang besar — jadi cukup membaca potongan awal file.

import fsp from "node:fs/promises";

const CHUNK = 4 * 1024 * 1024; // 4MB: cukup mencapai context_length sebelum array besar
const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

// Tipe nilai GGUF: 0 u8,1 i8,2 u16,3 i16,4 u32,5 i32,6 f32,7 bool,8 string,
// 9 array,10 u64,11 i64,12 f64.

export async function readContextLength(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, "r");
    const { size } = await fh.stat();
    const len = Math.min(CHUNK, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return parseContextLength(buf);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function parseContextLength(buf) {
  let off = 0;
  const need = (n) => {
    if (off + n > buf.length) throw new Error("eof");
  };
  const u32 = () => {
    need(4);
    const v = buf.readUInt32LE(off);
    off += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = buf.readBigUInt64LE(off);
    off += 8;
    return v;
  };
  const str = () => {
    const n = Number(u64());
    need(n);
    const s = buf.toString("utf8", off, off + n);
    off += n;
    return s;
  };

  const skipValue = (type) => {
    switch (type) {
      case 0:
      case 1:
      case 7:
        need(1);
        off += 1;
        break;
      case 2:
      case 3:
        need(2);
        off += 2;
        break;
      case 4:
      case 5:
      case 6:
        need(4);
        off += 4;
        break;
      case 10:
      case 11:
      case 12:
        need(8);
        off += 8;
        break;
      case 8:
        str();
        break;
      case 9: {
        const at = u32();
        const n = Number(u64());
        for (let k = 0; k < n; k++) skipValue(at);
        break;
      }
      default:
        throw new Error("tipe tak dikenal: " + type);
    }
  };

  const readNumber = (type) => {
    switch (type) {
      case 0:
        need(1);
        return buf.readUInt8(off++);
      case 1:
        need(1);
        return buf.readInt8(off++);
      case 2: {
        need(2);
        const v = buf.readUInt16LE(off);
        off += 2;
        return v;
      }
      case 3: {
        need(2);
        const v = buf.readInt16LE(off);
        off += 2;
        return v;
      }
      case 4:
        return u32();
      case 5: {
        need(4);
        const v = buf.readInt32LE(off);
        off += 4;
        return v;
      }
      case 10:
        return Number(u64());
      case 11: {
        need(8);
        const v = buf.readBigInt64LE(off);
        off += 8;
        return Number(v);
      }
      default:
        skipValue(type);
        return null;
    }
  };

  if (u32() !== GGUF_MAGIC) return null;
  u32(); // version
  u64(); // tensor_count
  const kvCount = Number(u64());

  for (let i = 0; i < kvCount; i++) {
    const key = str();
    const type = u32();
    if (key.endsWith(".context_length")) return readNumber(type);
    skipValue(type);
  }
  return null;
}

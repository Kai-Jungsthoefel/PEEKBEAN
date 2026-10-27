// SPDX-License-Identifier: GPL-3.0-or-later
// Legacy password-based encryption of PKCS#12 files (RFC 7292 appendix B and C): Triple DES and RC2 in CBC mode with
// keys from the PKCS#12 key derivation. Older OpenSSL, Java and Windows write these; WebCrypto has neither cipher.
// Decryption only, small and slow, which is fine for the few kilobytes in such a file.

/** PBE schemes from RFC 7292 appendix C: cipher, key length, effective RC2 key bits. */
export const LEGACY_PBE: Record<string, { name: string; cipher: '3des' | 'rc2' | 'rc4'; keyLength: number }> = {
  '1.2.840.113549.1.12.1.1': { name: 'RC4 128-bit (PKCS#12 PBE, SHA-1)', cipher: 'rc4', keyLength: 16 },
  '1.2.840.113549.1.12.1.2': { name: 'RC4 40-bit (PKCS#12 PBE, SHA-1)', cipher: 'rc4', keyLength: 5 },
  '1.2.840.113549.1.12.1.3': { name: '3DES (PKCS#12 PBE, SHA-1)', cipher: '3des', keyLength: 24 },
  '1.2.840.113549.1.12.1.4': { name: '2-key 3DES (PKCS#12 PBE, SHA-1)', cipher: '3des', keyLength: 16 },
  '1.2.840.113549.1.12.1.5': { name: 'RC2 128-bit (PKCS#12 PBE, SHA-1)', cipher: 'rc2', keyLength: 16 },
  '1.2.840.113549.1.12.1.6': { name: 'RC2 40-bit (PKCS#12 PBE, SHA-1)', cipher: 'rc2', keyLength: 5 },
};

/** PKCS#12 key derivation with SHA-1: id 1 gives key material, id 2 the IV. The password is UTF-16BE plus two zero bytes. */
async function deriveKey(password: string, salt: Uint8Array, iterations: number, id: number, length: number): Promise<Uint8Array> {
  const u = 20;
  const v = 64;
  const pass = new Uint8Array(password.length * 2 + 2);
  for (let i = 0; i < password.length; i++) {
    pass[i * 2] = password.charCodeAt(i) >> 8;
    pass[i * 2 + 1] = password.charCodeAt(i) & 0xff;
  }
  const fill = (source: Uint8Array) => {
    const out = new Uint8Array(v * Math.ceil(source.length / v));
    for (let i = 0; i < out.length; i++) out[i] = source[i % source.length];
    return source.length ? out : new Uint8Array(0);
  };
  const I = new Uint8Array([...fill(salt), ...fill(pass)]);
  const D = new Uint8Array(v).fill(id);
  const result = new Uint8Array(Math.ceil(length / u) * u);
  for (let block = 0; block * u < length; block++) {
    let A = new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array([...D, ...I])));
    for (let i = 1; i < iterations; i++) A = new Uint8Array(await crypto.subtle.digest('SHA-1', A));
    result.set(A, block * u);
    // I_j = (I_j + B + 1) mod 2^(8v), with B = A repeated to v bytes.
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + A[k % u] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return result.subarray(0, length);
}

// ---- DES ------------------------------------------------------------------------------------------------------------

const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

/** Bits as an array of 0/1, most significant first. */
const toBits = (bytes: Uint8Array) => Array.from({ length: bytes.length * 8 }, (_, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1);
const permute = (bits: number[], table: number[]) => table.map((t) => bits[t - 1]);

function desSubkeys(key: Uint8Array): number[][] {
  const k = permute(toBits(key), PC1);
  let c = k.slice(0, 28);
  let d = k.slice(28);
  return SHIFTS.map((s) => {
    c = [...c.slice(s), ...c.slice(0, s)];
    d = [...d.slice(s), ...d.slice(0, s)];
    return permute([...c, ...d], PC2);
  });
}

function desBlock(block: Uint8Array, keys: number[][], decrypt: boolean): Uint8Array {
  const b = permute(toBits(block), IP);
  let l = b.slice(0, 32);
  let r = b.slice(32);
  for (let round = 0; round < 16; round++) {
    const k = keys[decrypt ? 15 - round : round];
    const x = permute(r, E).map((bit, i) => bit ^ k[i]);
    const f: number[] = [];
    for (let j = 0; j < 8; j++) {
      const six = x.slice(j * 6, j * 6 + 6);
      const value = S[j][((six[0] << 1) | six[5]) * 16 + ((six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4])];
      f.push((value >> 3) & 1, (value >> 2) & 1, (value >> 1) & 1, value & 1);
    }
    const next = permute(f, P).map((bit, i) => bit ^ l[i]);
    l = r;
    r = next;
  }
  const out = permute([...r, ...l], FP);
  return Uint8Array.from({ length: 8 }, (_, i) => out.slice(i * 8, i * 8 + 8).reduce((v, bit) => (v << 1) | bit, 0));
}

/** Triple DES (EDE) decryption of one block: decrypt with K3, encrypt with K2, decrypt with K1. */
function tripleDesDecryptor(key: Uint8Array): (block: Uint8Array) => Uint8Array {
  const k1 = desSubkeys(key.subarray(0, 8));
  const k2 = desSubkeys(key.subarray(8, 16));
  const k3 = key.length >= 24 ? desSubkeys(key.subarray(16, 24)) : k1;
  return (block) => desBlock(desBlock(desBlock(block, k3, true), k2, false), k1, true);
}

// ---- RC2 (RFC 2268) -------------------------------------------------------------------------------------------------

const PITABLE = [
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79, 0x4a, 0xa0, 0xd8, 0x9d, 0xc6, 0x7e, 0x37, 0x83, 0x2b, 0x76, 0x53, 0x8e, 0x62, 0x4c, 0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2,
  0x17, 0x9a, 0x59, 0xf5, 0x87, 0xb3, 0x4f, 0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32, 0xbd, 0x8f, 0x40, 0xeb, 0x86, 0xb7, 0x7b, 0x0b, 0xf0, 0x95, 0x21, 0x22, 0x5c, 0x6b, 0x4e, 0x82,
  0x54, 0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c, 0x73, 0x56, 0xc0, 0x14, 0xa7, 0x8c, 0xf1, 0xdc, 0x12, 0x75, 0xca, 0x1f, 0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4, 0x30, 0xa3, 0x3c, 0xb6, 0x26,
  0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57, 0x27, 0xf2, 0x1d, 0x9b, 0xbc, 0x94, 0x43, 0x03, 0xf8, 0x11, 0xc7, 0xf6, 0x90, 0xef, 0x3e, 0xe7, 0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7,
  0x08, 0xe8, 0xea, 0xde, 0x80, 0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a, 0x2a, 0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74, 0x4b, 0x9f, 0xd0, 0x5e, 0x04, 0x18, 0xa4, 0xec,
  0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc, 0x24, 0x91, 0xaf, 0x50, 0xa1, 0xf4, 0x70, 0x39, 0x99, 0x7c, 0x3a, 0x85, 0x23, 0xb8, 0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55, 0x97, 0x31,
  0x2d, 0x5d, 0xfa, 0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10, 0x67, 0x6c, 0xba, 0xc9, 0xd3, 0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c, 0x63, 0x16, 0x01, 0x3f, 0x58, 0xe2, 0x89, 0xa9,
  0x0d, 0x38, 0x34, 0x1b, 0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48, 0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e, 0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c, 0x77, 0x0a, 0xa6, 0x20, 0x68, 0xfe, 0x7f, 0xc1, 0xad,
];

function rc2Decryptor(key: Uint8Array, effectiveBits: number): (block: Uint8Array) => Uint8Array {
  const L = new Uint8Array(128);
  L.set(key);
  for (let i = key.length; i < 128; i++) L[i] = PITABLE[(L[i - 1] + L[i - key.length]) & 0xff];
  const t8 = (effectiveBits + 7) >> 3;
  const tm = 0xff >> (8 * t8 - effectiveBits);
  L[128 - t8] = PITABLE[L[128 - t8] & tm];
  for (let i = 127 - t8; i >= 0; i--) L[i] = PITABLE[L[i + 1] ^ L[i + t8]];
  const K = Array.from({ length: 64 }, (_, i) => L[2 * i] | (L[2 * i + 1] << 8));
  const ROT = [1, 2, 3, 5];
  return (block) => {
    const R = [0, 1, 2, 3].map((i) => block[2 * i] | (block[2 * i + 1] << 8));
    let j = 63;
    const mix = () => {
      for (let i = 3; i >= 0; i--) {
        R[i] = ((R[i] >> ROT[i]) | (R[i] << (16 - ROT[i]))) & 0xffff;
        R[i] = (R[i] - K[j--] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & R[(i + 1) & 3])) & 0xffff;
      }
    };
    const mash = () => {
      for (let i = 3; i >= 0; i--) R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff;
    };
    for (let n = 0; n < 5; n++) mix();
    mash();
    for (let n = 0; n < 6; n++) mix();
    mash();
    for (let n = 0; n < 5; n++) mix();
    return Uint8Array.from(R.flatMap((w) => [w & 0xff, w >> 8]));
  };
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/** CBC decryption with PKCS#7 padding check; a wrong key almost always fails the check. */
function cbcDecrypt(decryptBlock: (block: Uint8Array) => Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (!data.length || data.length % 8) throw new Error('The encrypted data has an invalid length.');
  const out = new Uint8Array(data.length);
  let previous = iv;
  for (let p = 0; p < data.length; p += 8) {
    const block = data.subarray(p, p + 8);
    const plain = decryptBlock(block);
    for (let i = 0; i < 8; i++) out[p + i] = plain[i] ^ previous[i];
    previous = block;
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 8 || out.subarray(out.length - pad).some((b) => b !== pad)) throw new Error('Wrong password or damaged data.');
  return out.subarray(0, out.length - pad);
}

/** Decrypts data protected with one of the LEGACY_PBE schemes. */
export async function legacyDecrypt(oid: string, password: string, salt: Uint8Array, iterations: number, data: Uint8Array): Promise<Uint8Array> {
  const scheme = LEGACY_PBE[oid];
  if (!scheme) throw new Error(`Unsupported encryption ${oid}.`);
  const key = await deriveKey(password, salt, iterations, 1, scheme.keyLength);
  if (scheme.cipher === 'rc4') return rc4(key, data);
  const iv = await deriveKey(password, salt, iterations, 2, 8);
  const decryptor = scheme.cipher === '3des' ? tripleDesDecryptor(key) : rc2Decryptor(key, scheme.keyLength * 8);
  return cbcDecrypt(decryptor, iv, data);
}

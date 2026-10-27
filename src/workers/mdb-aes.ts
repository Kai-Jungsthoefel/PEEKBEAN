// SPDX-License-Identifier: GPL-3.0-or-later
// Stands in for "browserify-aes/browser.js" in mdb-reader's browser build (aliased in vite.config.ts): the original
// needs Node's stream module. AES from @noble/ciphers (MIT); mdb-reader only decrypts, without padding.
import { Buffer } from 'buffer';
import { cbc, ecb } from '@noble/ciphers/aes.js';

function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array) {
  const [name, , mode] = algorithm.toLowerCase().split('-');
  if (name !== 'aes' || (mode !== 'cbc' && mode !== 'ecb')) throw new Error(`Unsupported cipher ${algorithm}`);
  const cipher = mode === 'cbc' ? cbc(key, iv, { disablePadding: true }) : ecb(key, { disablePadding: true });
  return {
    setAutoPadding: () => {},
    update: (data: Uint8Array) => Buffer.from(cipher.decrypt(data)),
  };
}

export default { createDecipheriv };

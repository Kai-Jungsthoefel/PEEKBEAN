// SPDX-License-Identifier: GPL-3.0-or-later
// Stands in for "create-hash" in mdb-reader's browser build (aliased in vite.config.ts): the original needs Node's
// stream module. Hashes from @noble/hashes (MIT), synchronous like the original.
import { Buffer } from 'buffer';
import { md5, sha1 } from '@noble/hashes/legacy';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2';

const HASHES = { md5, sha1, sha256, sha384, sha512 };

export default function createHash(algorithm: string) {
  const hash = HASHES[algorithm.toLowerCase().replace('-', '') as keyof typeof HASHES];
  if (!hash) throw new Error(`Unsupported hash algorithm ${algorithm}`);
  const state = hash.create();
  return {
    update(data: Uint8Array) {
      state.update(data);
      return this;
    },
    digest: () => Buffer.from(state.digest()),
  };
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Certificates, certificate requests, PKCS#7 bundles, PKCS#12 key stores, CRLs and keys via PKI.js and asn1js
// (BSD-3-Clause), fingerprints and signature checks with the browser's WebCrypto. One card per object, certificates in
// chain order. Private keys are described by type and size only; their content is never shown. Addresses inside
// certificates (CRL, OCSP, CA issuers, policies) are plain text and are never fetched.
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import type { ViewerContext } from '../core/types';
import { LEGACY_PBE, legacyDecrypt } from './pkcs12-legacy';

type Row = [string, string | Node | null | undefined];

interface CertItem {
  kind: 'certificate';
  cert: pkijs.Certificate;
  der: Uint8Array;
  /** Friendly name from a PKCS#12 bag. */
  alias?: string;
  keyId?: string;
}
interface RequestItem {
  kind: 'request';
  csr: pkijs.CertificationRequest;
}
interface KeyItem {
  kind: 'key';
  /** "RSA 2048 bit", or null while encrypted. */
  type: string | null;
  encryption: string | null;
  format: string;
  alias?: string;
  keyId?: string;
  /** SubjectPublicKeyInfo DER, to find the matching certificate. */
  publicKey?: Uint8Array;
}
interface PublicKeyItem {
  kind: 'public-key';
  spki: pkijs.PublicKeyInfo;
  der: Uint8Array;
}
interface CrlItem {
  kind: 'crl';
  crl: pkijs.CertificateRevocationList;
}
interface OtherItem {
  kind: 'other';
  title: string;
  note: string;
}
type Item = CertItem | RequestItem | KeyItem | PublicKeyItem | CrlItem | OtherItem;

// ---- Names for object identifiers ---------------------------------------------------------------------------------

const ATTRIBUTES: Record<string, string> = {
  '2.5.4.3': 'Common name', '2.5.4.4': 'Surname', '2.5.4.5': 'Serial number', '2.5.4.6': 'Country', '2.5.4.7': 'Locality',
  '2.5.4.8': 'State or province', '2.5.4.9': 'Street', '2.5.4.10': 'Organization', '2.5.4.11': 'Organizational unit',
  '2.5.4.12': 'Title', '2.5.4.13': 'Description', '2.5.4.15': 'Business category', '2.5.4.17': 'Postal code',
  '2.5.4.42': 'Given name', '2.5.4.43': 'Initials', '2.5.4.44': 'Generation qualifier', '2.5.4.46': 'DN qualifier',
  '2.5.4.65': 'Pseudonym', '2.5.4.97': 'Organization identifier', '1.2.840.113549.1.9.1': 'E-mail',
  '0.9.2342.19200300.100.1.1': 'User ID', '0.9.2342.19200300.100.1.25': 'Domain component',
  '1.3.6.1.4.1.311.60.2.1.1': 'Jurisdiction locality', '1.3.6.1.4.1.311.60.2.1.2': 'Jurisdiction state',
  '1.3.6.1.4.1.311.60.2.1.3': 'Jurisdiction country',
};

const SIGNATURES: Record<string, string> = {
  '1.2.840.113549.1.1.2': 'MD2 with RSA', '1.2.840.113549.1.1.4': 'MD5 with RSA', '1.2.840.113549.1.1.5': 'SHA-1 with RSA',
  '1.2.840.113549.1.1.11': 'SHA-256 with RSA', '1.2.840.113549.1.1.12': 'SHA-384 with RSA', '1.2.840.113549.1.1.13': 'SHA-512 with RSA',
  '1.2.840.113549.1.1.14': 'SHA-224 with RSA', '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.10045.4.1': 'ECDSA with SHA-1', '1.2.840.10045.4.3.1': 'ECDSA with SHA-224', '1.2.840.10045.4.3.2': 'ECDSA with SHA-256',
  '1.2.840.10045.4.3.3': 'ECDSA with SHA-384', '1.2.840.10045.4.3.4': 'ECDSA with SHA-512',
  '1.3.101.112': 'Ed25519', '1.3.101.113': 'Ed448', '1.2.840.10040.4.3': 'DSA with SHA-1',
  '2.16.840.1.101.3.4.3.1': 'DSA with SHA-224', '2.16.840.1.101.3.4.3.2': 'DSA with SHA-256',
  '1.2.156.10197.1.501': 'SM2 with SM3',
};
const HASHES: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512',
  '2.16.840.1.101.3.4.2.4': 'SHA-224', '1.2.840.113549.2.5': 'MD5', '1.2.840.113549.2.7': 'HMAC-SHA1',
  '1.2.840.113549.2.9': 'HMAC-SHA256', '1.2.840.113549.2.10': 'HMAC-SHA384', '1.2.840.113549.2.11': 'HMAC-SHA512',
};
const KEY_TYPES: Record<string, string> = {
  '1.2.840.113549.1.1.1': 'RSA', '1.2.840.113549.1.1.10': 'RSA-PSS', '1.2.840.10045.2.1': 'EC', '1.2.840.10040.4.1': 'DSA',
  '1.3.101.110': 'X25519', '1.3.101.111': 'X448', '1.3.101.112': 'Ed25519', '1.3.101.113': 'Ed448', '1.2.840.10046.2.1': 'DH',
};
const CURVES: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384', '1.3.132.0.35': 'P-521', '1.3.132.0.10': 'secp256k1',
  '1.2.840.10045.3.1.1': 'P-192', '1.3.132.0.33': 'P-224', '1.3.36.3.3.2.8.1.1.7': 'brainpoolP256r1',
  '1.3.36.3.3.2.8.1.1.11': 'brainpoolP384r1', '1.3.36.3.3.2.8.1.1.13': 'brainpoolP512r1', '1.2.156.10197.1.301': 'SM2',
};
const SSH_CURVES: Record<string, string> = { nistp256: 'P-256', nistp384: 'P-384', nistp521: 'P-521' };
const EXTENDED_USAGES: Record<string, string> = {
  '1.3.6.1.5.5.7.3.1': 'TLS server authentication', '1.3.6.1.5.5.7.3.2': 'TLS client authentication', '1.3.6.1.5.5.7.3.3': 'Code signing',
  '1.3.6.1.5.5.7.3.4': 'E-mail protection', '1.3.6.1.5.5.7.3.5': 'IPsec end system', '1.3.6.1.5.5.7.3.6': 'IPsec tunnel',
  '1.3.6.1.5.5.7.3.7': 'IPsec user', '1.3.6.1.5.5.7.3.8': 'Time stamping', '1.3.6.1.5.5.7.3.9': 'OCSP signing',
  '1.3.6.1.5.5.7.3.17': 'IPsec IKE', '1.3.6.1.5.2.3.4': 'Kerberos client authentication', '1.3.6.1.5.2.3.5': 'Kerberos KDC',
  '1.3.6.1.4.1.311.20.2.2': 'Smart card logon', '1.3.6.1.4.1.311.10.3.4': 'Encrypting file system',
  '1.3.6.1.4.1.311.10.3.12': 'Document signing', '1.3.6.1.4.1.311.10.3.3': 'Server gated crypto (Microsoft)',
  '2.16.840.1.113730.4.1': 'Server gated crypto (Netscape)', '1.2.840.113583.1.1.5': 'PDF signing (Adobe)', '2.5.29.37.0': 'Any purpose',
};
const KEY_USAGES = ['Digital signature', 'Non-repudiation', 'Key encipherment', 'Data encipherment', 'Key agreement', 'Certificate signing', 'CRL signing', 'Encipher only', 'Decipher only'];
const EXTENSIONS: Record<string, string> = {
  '2.5.29.9': 'Subject directory attributes', '2.5.29.14': 'Subject key identifier', '2.5.29.15': 'Key usage',
  '2.5.29.16': 'Private key usage period', '2.5.29.17': 'Subject alternative names', '2.5.29.18': 'Issuer alternative names',
  '2.5.29.19': 'Basic constraints', '2.5.29.20': 'CRL number', '2.5.29.21': 'CRL reason', '2.5.29.28': 'Issuing distribution point',
  '2.5.29.30': 'Name constraints', '2.5.29.31': 'CRL distribution points', '2.5.29.32': 'Certificate policies',
  '2.5.29.33': 'Policy mappings', '2.5.29.35': 'Authority key identifier', '2.5.29.36': 'Policy constraints',
  '2.5.29.37': 'Extended key usage', '2.5.29.46': 'Freshest CRL', '2.5.29.54': 'Inhibit any policy',
  '1.3.6.1.5.5.7.1.1': 'Authority information access', '1.3.6.1.5.5.7.1.11': 'Subject information access',
  '1.3.6.1.5.5.7.1.3': 'Qualified certificate statements', '1.3.6.1.5.5.7.1.24': 'TLS feature (OCSP must-staple)',
  '1.3.6.1.4.1.11129.2.4.2': 'Signed certificate timestamps', '1.3.6.1.4.1.11129.2.4.3': 'Precertificate poison',
  '1.3.6.1.5.5.7.48.1.5': 'OCSP no check', '2.16.840.1.113730.1.1': 'Netscape certificate type', '2.16.840.1.113730.1.13': 'Netscape comment',
  '1.3.6.1.4.1.311.20.2': 'Certificate template name (Microsoft)', '1.3.6.1.4.1.311.21.7': 'Certificate template (Microsoft)',
  '1.3.6.1.4.1.311.21.10': 'Application policies (Microsoft)', '1.3.6.1.4.1.311.21.1': 'CA version (Microsoft)',
  '1.3.6.1.4.1.311.21.2': 'Previous CA certificate hash (Microsoft)',
};
const POLICIES: Record<string, string> = {
  '2.23.140.1.2.1': 'Domain validated', '2.23.140.1.2.2': 'Organization validated', '2.23.140.1.2.3': 'Individual validated',
  '2.23.140.1.1': 'Extended validation', '2.23.140.1.3': 'Extended validation code signing', '2.23.140.1.4.1': 'Code signing',
  '2.5.29.32.0': 'Any policy',
};
const CIPHERS: Record<string, string> = {
  '2.16.840.1.101.3.4.1.2': 'AES-128-CBC', '2.16.840.1.101.3.4.1.22': 'AES-192-CBC', '2.16.840.1.101.3.4.1.42': 'AES-256-CBC',
  '1.2.840.113549.3.7': '3DES-CBC', '1.3.14.3.2.7': 'DES-CBC', '1.2.840.113549.3.2': 'RC2-CBC',
};
const PBES2 = '1.2.840.113549.1.5.13';
const OLD_PBE: Record<string, string> = {
  '1.2.840.113549.1.5.3': 'DES (PBES1, MD5)', '1.2.840.113549.1.5.10': 'DES (PBES1, SHA-1)', '1.2.840.113549.1.5.6': 'RC2 (PBES1, MD5)',
  '1.2.840.113549.1.5.11': 'RC2 (PBES1, SHA-1)',
};

const named = (table: Record<string, string>, oid: string) => table[oid] ?? oid;

// ---- Small helpers --------------------------------------------------------------------------------------------------

const hex = (bytes: Uint8Array, separator = ':') => Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(separator);
const utf8 = (text: string) => new TextEncoder().encode(text);
const bytesOf = (b: ArrayBuffer | ArrayBufferView) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
/** A copy on its own ArrayBuffer, as PKI.js wants it. */
const copy = (b: Uint8Array) => b.slice().buffer;
const equalBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** Several values in one cell, one per line. */
function lines(values: (string | Node)[]): Node | null {
  if (!values.length) return null;
  const box = h('span', { class: 'record-lines' });
  for (const v of values) box.append(h('span', {}, v));
  return box;
}
const mono = (text: string) => h('span', { class: 'cert-mono' }, text);
const critical = (ext?: pkijs.Extension) => (ext?.critical ? h('span', { class: 'cert-critical' }, 'critical') : null);
function withCritical(value: Node | string | null, ext?: pkijs.Extension): Node | null {
  if (value === null) return null;
  const box = h('span', {}, value);
  const flag = critical(ext);
  if (flag) box.append(flag);
  return box;
}

function asn1Text(value: unknown): string {
  const block = (value as { valueBlock?: { value?: unknown; valueHexView?: Uint8Array } })?.valueBlock;
  if (typeof block?.value === 'string') return block.value;
  if (block?.valueHexView) return `#${hex(block.valueHexView, '')}`;
  return String(value);
}

function integerHex(value: asn1js.Integer): string {
  let bytes = value.valueBlock.valueHexView;
  if (bytes.length > 1 && bytes[0] === 0 && bytes[1] >= 0x80) bytes = bytes.subarray(1);
  return hex(bytes);
}

function bitLength(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return (bytes.length - i - 1) * 8 + (bytes[i] ? 32 - Math.clz32(bytes[i]) : 0);
}

function nameLines(name: pkijs.RelativeDistinguishedNames): string[] {
  return name.typesAndValues.map((tv) => `${named(ATTRIBUTES, tv.type)}: ${asn1Text(tv.value)}`);
}
/** Normalized name for matching subjects to issuers. */
const nameKey = (name: pkijs.RelativeDistinguishedNames) =>
  name.typesAndValues.map((tv) => `${tv.type}=${asn1Text(tv.value).trim().toLowerCase().replace(/\s+/g, ' ')}`).join(',');
function commonName(name: pkijs.RelativeDistinguishedNames): string | null {
  const pick = (oid: string) => name.typesAndValues.find((tv) => tv.type === oid);
  const tv = pick('2.5.4.3') ?? pick('2.5.4.11') ?? pick('2.5.4.10') ?? name.typesAndValues[name.typesAndValues.length - 1];
  return tv ? asn1Text(tv.value) : null;
}

function utcText(date: Date): string {
  return `${date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}
function relative(date: Date): string {
  const days = (date.getTime() - Date.now()) / 86400000;
  const format = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  if (Math.abs(days) >= 365) return format.format(Math.round(days / 365.25), 'year');
  if (Math.abs(days) >= 45) return format.format(Math.round(days / 30.44), 'month');
  if (Math.abs(days) >= 1) return format.format(Math.round(days), 'day');
  return format.format(Math.round(days * 24), 'hour');
}

function ipText(bytes: Uint8Array): string {
  if (bytes.length === 4) return bytes.join('.');
  if (bytes.length === 16) return Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16)).join(':').replace(/\b(?:0:){2,}/, ':');
  return hex(bytes);
}

function generalName(name: pkijs.GeneralName): string {
  switch (name.type) {
    case 0: return `Other name: ${name.value?.type ? named(ATTRIBUTES, name.value.type) : ''}`.trim();
    case 1: return `E-mail: ${name.value}`;
    case 2: return `DNS: ${name.value}`;
    case 4: return `Directory name: ${nameLines(name.value as pkijs.RelativeDistinguishedNames).join(', ')}`;
    case 6: return `URI: ${name.value}`;
    case 7: return `IP: ${ipText((name.value as asn1js.OctetString).valueBlock.valueHexView)}`;
    case 8: return `Registered ID: ${name.value}`;
    default: return `Name of type ${name.type}`;
  }
}

/** "SHA-256 with RSA", including the hash of RSASSA-PSS. */
function signatureName(algorithm: pkijs.AlgorithmIdentifier): string {
  if (algorithm.algorithmId === '1.2.840.113549.1.1.10' && algorithm.algorithmParams) {
    try {
      const params = new pkijs.RSASSAPSSParams({ schema: algorithm.algorithmParams });
      return `RSASSA-PSS with ${named(HASHES, params.hashAlgorithm.algorithmId)}`;
    } catch {
      // default parameters
    }
  }
  return named(SIGNATURES, algorithm.algorithmId);
}

function curveOf(params: unknown): string | null {
  return params instanceof asn1js.ObjectIdentifier ? named(CURVES, params.valueBlock.toString()) : null;
}

function publicKeyText(spki: pkijs.PublicKeyInfo): string {
  const oid = spki.algorithm.algorithmId;
  const type = named(KEY_TYPES, oid);
  if (type === 'RSA' || type === 'RSA-PSS') {
    try {
      const key = spki.parsedKey as pkijs.RSAPublicKey | undefined ?? pkijs.RSAPublicKey.fromBER(copy(spki.subjectPublicKey.valueBlock.valueHexView));
      const exponent = key.publicExponent.valueBlock.valueDec;
      return `${type} ${bitLength(key.modulus.valueBlock.valueHexView)} bit${exponent > 0 ? ` (exponent ${exponent.toLocaleString('en-US')})` : ''}`;
    } catch {
      return type;
    }
  }
  if (type === 'EC') return `EC ${curveOf(spki.algorithm.algorithmParams) ?? '(explicit curve parameters)'}`;
  return type;
}

// ---- Private keys ---------------------------------------------------------------------------------------------------

function privateKeyType(info: pkijs.PrivateKeyInfo): string {
  const type = named(KEY_TYPES, info.privateKeyAlgorithm.algorithmId);
  if (info.parsedKey instanceof pkijs.RSAPrivateKey) return `${type} ${bitLength(info.parsedKey.modulus.valueBlock.valueHexView)} bit`;
  if (type === 'EC') return `EC ${curveOf(info.privateKeyAlgorithm.algorithmParams) ?? (info.parsedKey as pkijs.ECPrivateKey | undefined)?.namedCurve ?? ''}`.trim();
  return type;
}

/** The modulus of an RSA private key, which pairs it with its certificate. */
function publicKeyOf(info: pkijs.PrivateKeyInfo): Uint8Array | undefined {
  if (!(info.parsedKey instanceof pkijs.RSAPrivateKey)) return undefined;
  const m = info.parsedKey.modulus.valueBlock.valueHexView;
  return m[0] === 0 ? m.subarray(1) : m;
}
/** RSA modulus as the key's identity, for pairing keys with certificates. */
function rsaModulus(spki: pkijs.PublicKeyInfo): Uint8Array | undefined {
  try {
    const key = spki.parsedKey instanceof pkijs.RSAPublicKey ? spki.parsedKey : pkijs.RSAPublicKey.fromBER(copy(spki.subjectPublicKey.valueBlock.valueHexView));
    const m = key.modulus.valueBlock.valueHexView;
    return m[0] === 0 ? m.subarray(1) : m;
  } catch {
    return undefined;
  }
}

function encryptionName(algorithm: pkijs.AlgorithmIdentifier): string {
  const oid = algorithm.algorithmId;
  if (oid === PBES2) {
    try {
      const params = new pkijs.PBES2Params({ schema: algorithm.algorithmParams });
      const cipher = named(CIPHERS, params.encryptionScheme.algorithmId);
      if (params.keyDerivationFunc.algorithmId === '1.3.6.1.4.1.11591.4.11') return `PBES2/${cipher}, scrypt`;
      const kdf = new pkijs.PBKDF2Params({ schema: params.keyDerivationFunc.algorithmParams });
      const prf = kdf.prf ? named(HASHES, kdf.prf.algorithmId) : 'HMAC-SHA1';
      return `PBES2/${cipher}, PBKDF2-${prf}, ${kdf.iterationCount.toLocaleString('en-US')} iterations`;
    } catch {
      return 'PBES2';
    }
  }
  return LEGACY_PBE[oid]?.name ?? OLD_PBE[oid] ?? oid;
}

/** Decrypts PBES2 (WebCrypto through PKI.js) or the legacy PKCS#12 schemes. */
async function decryptWithPassword(algorithm: pkijs.AlgorithmIdentifier, data: Uint8Array, password: string): Promise<Uint8Array> {
  const oid = algorithm.algorithmId;
  if (oid === PBES2) {
    const info = new pkijs.EncryptedContentInfo({
      contentType: '1.2.840.113549.1.7.1',
      contentEncryptionAlgorithm: algorithm,
      encryptedContent: new asn1js.OctetString({ valueHex: data.slice().buffer }),
    });
    return new Uint8Array(await pkijs.getCrypto(true).decryptEncryptedContentInfo({ password: utf8(password).buffer, encryptedContentInfo: info }));
  }
  if (LEGACY_PBE[oid]) {
    const params = algorithm.algorithmParams as asn1js.Sequence;
    const [salt, iterations] = params.valueBlock.value as [asn1js.OctetString, asn1js.Integer];
    return legacyDecrypt(oid, password, salt.valueBlock.valueHexView, iterations.valueBlock.valueDec, data);
  }
  throw new Error(`The encryption ${encryptionName(algorithm)} is not supported.`);
}

function opensshKey(bytes: Uint8Array): KeyItem {
  const magic = 'openssh-key-v1\0';
  if (new TextDecoder('latin1').decode(bytes.subarray(0, magic.length)) !== magic) return { kind: 'key', type: null, encryption: null, format: 'OpenSSH' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = magic.length;
  const field = () => {
    const length = view.getUint32(p);
    const value = bytes.subarray(p + 4, p + 4 + length);
    p += 4 + length;
    return value;
  };
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const cipher = text(field());
  const kdf = text(field());
  field();
  p += 4; // number of keys
  // The public key blob: its type, then for RSA the exponent and modulus, for ECDSA the curve.
  const pub = field();
  const pubView = new DataView(pub.buffer, pub.byteOffset, pub.byteLength);
  let q = 0;
  const pubField = () => {
    const length = pubView.getUint32(q);
    const value = pub.subarray(q + 4, q + 4 + length);
    q += 4 + length;
    return value;
  };
  const keyType = text(pubField());
  let type = keyType;
  if (keyType === 'ssh-rsa') {
    pubField();
    type = `RSA ${bitLength(pubField())} bit`;
  } else if (keyType.startsWith('ecdsa-sha2-')) type = `EC ${SSH_CURVES[text(pubField())] ?? keyType}`;
  else if (keyType === 'ssh-ed25519') type = 'Ed25519';
  return { kind: 'key', type, encryption: cipher === 'none' ? null : `${cipher}, ${kdf}`, format: 'OpenSSH' };
}

// ---- Reading the file -----------------------------------------------------------------------------------------------

interface Parsed {
  items: Item[];
  format: string;
  notes: string[];
}

function fromBer(bytes: Uint8Array): asn1js.AsnType | null {
  const asn1 = asn1js.fromBER(bytes);
  return asn1.offset === -1 ? null : asn1.result;
}

function tryParse<T>(make: () => T): T | null {
  try {
    return make();
  } catch {
    return null;
  }
}

function signedDataCerts(schema: asn1js.AsnType, notes: string[]): Item[] {
  const signed = new pkijs.SignedData({ schema });
  const items: Item[] = [];
  for (const c of signed.certificates ?? []) {
    if (c instanceof pkijs.Certificate) items.push({ kind: 'certificate', cert: c, der: bytesOf(c.toSchema().toBER(false)) });
  }
  for (const crl of signed.crls ?? []) if (crl instanceof pkijs.CertificateRevocationList) items.push({ kind: 'crl', crl });
  if (signed.signerInfos.length) notes.push(`The PKCS#7 data is signed by ${signed.signerInfos.length} ${signed.signerInfos.length === 1 ? 'signer' : 'signers'}; the signature is not checked here.`);
  return items;
}

/** One DER object of any supported kind. */
function derItems(bytes: Uint8Array, notes: string[]): { items: Item[]; format: string } | null {
  const schema = fromBer(bytes);
  if (!schema) return null;
  const cert = tryParse(() => new pkijs.Certificate({ schema }));
  if (cert) return { items: [{ kind: 'certificate', cert, der: bytes }], format: 'DER certificate' };
  const content = tryParse(() => new pkijs.ContentInfo({ schema }));
  if (content?.contentType === '1.2.840.113549.1.7.2') return { items: signedDataCerts(content.content, notes), format: 'PKCS#7 bundle' };
  const csr = tryParse(() => new pkijs.CertificationRequest({ schema }));
  if (csr) return { items: [{ kind: 'request', csr }], format: 'Certificate request (DER)' };
  const crl = tryParse(() => new pkijs.CertificateRevocationList({ schema }));
  if (crl) return { items: [{ kind: 'crl', crl }], format: 'Certificate revocation list (DER)' };
  const encrypted = tryParse(() => new pkijs.PKCS8ShroudedKeyBag({ schema }));
  if (encrypted) return { items: [{ kind: 'key', type: null, encryption: encryptionName(encrypted.encryptionAlgorithm), format: 'PKCS#8' }], format: 'Encrypted private key (DER)' };
  const key = tryParse(() => new pkijs.PrivateKeyInfo({ schema }));
  if (key) return { items: [{ kind: 'key', type: privateKeyType(key), encryption: null, format: 'PKCS#8', publicKey: publicKeyOf(key) }], format: 'Private key (DER)' };
  const spki = tryParse(() => new pkijs.PublicKeyInfo({ schema }));
  if (spki) return { items: [{ kind: 'public-key', spki, der: bytes }], format: 'Public key (DER)' };
  return null;
}

const isPfx = (schema: asn1js.AsnType | null) => {
  const seq = schema instanceof asn1js.Sequence ? schema.valueBlock.value : [];
  return seq.length >= 2 && seq[0] instanceof asn1js.Integer && seq[0].valueBlock.valueDec === 3 && seq[1] instanceof asn1js.Sequence;
};

function attribute(bag: pkijs.SafeBag, oid: string): unknown {
  return bag.bagAttributes?.find((a) => a.type === oid)?.values[0];
}

async function readPfx(bytes: Uint8Array, fileName: string, notes: string[]): Promise<Item[]> {
  const pfx = pkijs.PFX.fromBER(copy(bytes));
  // Many files use an empty password; ask only when that fails.
  let password = '';
  let asked = false;
  for (;;) {
    try {
      await pfx.parseInternalValues({ password: utf8(password).buffer, checkIntegrity: Boolean(pfx.macData) });
      break;
    } catch (error) {
      if (!/integrity/i.test(String(error))) throw new Error(`The PKCS#12 file could not be read: ${error instanceof Error ? error.message : error}`);
      const input = window.prompt(asked ? 'Wrong password. Please try again:' : `“${fileName}” is protected by a password. Password:`);
      if (input === null) throw new Error('The file cannot be opened without its password.');
      password = input;
      asked = true;
    }
  }
  const safe = pfx.parsedValue?.authenticatedSafe;
  if (!safe) return [];
  const items: Item[] = [];
  for (const info of safe.safeContents) {
    let contents: pkijs.SafeContents;
    try {
      if (info.contentType === '1.2.840.113549.1.7.1') {
        contents = pkijs.SafeContents.fromBER((info.content as asn1js.OctetString).getValue());
      } else if (info.contentType === '1.2.840.113549.1.7.6') {
        const encrypted = new pkijs.EncryptedData({ schema: info.content });
        const eci = encrypted.encryptedContentInfo;
        contents = pkijs.SafeContents.fromBER(copy(await decryptWithPassword(eci.contentEncryptionAlgorithm, bytesOf(eci.getEncryptedContent()), password)));
      } else {
        notes.push('Part of the file is encrypted for a recipient’s key and cannot be shown.');
        continue;
      }
    } catch (error) {
      notes.push(`Part of the file could not be decrypted: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    for (const bag of contents.safeBags) {
      const nameAttr = attribute(bag, '1.2.840.113549.1.9.20');
      const idAttr = attribute(bag, '1.2.840.113549.1.9.21');
      const alias = nameAttr ? asn1Text(nameAttr) : undefined;
      const keyId = idAttr instanceof asn1js.OctetString ? hex(idAttr.valueBlock.valueHexView, '') : undefined;
      const value = bag.bagValue as unknown;
      if (value instanceof pkijs.CertBag) {
        if (value.parsedValue instanceof pkijs.Certificate) {
          items.push({ kind: 'certificate', cert: value.parsedValue, der: bytesOf((value.certValue as asn1js.OctetString).getValue()), alias, keyId });
        } else items.push({ kind: 'other', title: 'Certificate of another kind', note: `Type ${value.certId}` });
      } else if (value instanceof pkijs.PKCS8ShroudedKeyBag) {
        const encryption = encryptionName(value.encryptionAlgorithm);
        let type: string | null = null;
        let publicKey: Uint8Array | undefined;
        try {
          const plain = await decryptWithPassword(value.encryptionAlgorithm, bytesOf(value.encryptedData.getValue()), password);
          const info = pkijs.PrivateKeyInfo.fromBER(copy(plain));
          type = privateKeyType(info);
          publicKey = publicKeyOf(info);
        } catch {
          // the type stays unknown
        }
        items.push({ kind: 'key', type, encryption, format: 'PKCS#12 shrouded key bag', alias, keyId, publicKey });
      } else if (value instanceof pkijs.PrivateKeyInfo) {
        items.push({ kind: 'key', type: privateKeyType(value), encryption: null, format: 'PKCS#12 key bag', alias, keyId, publicKey: publicKeyOf(value) });
      } else if (value instanceof pkijs.CRLBag) {
        items.push({ kind: 'other', title: 'Certificate revocation list', note: 'Stored in the PKCS#12 file.' });
      } else if (value instanceof pkijs.SecretBag) {
        items.push({ kind: 'other', title: 'Secret', note: 'A secret value; its content is not shown.' });
      }
    }
  }
  if (pfx.macData) notes.push(`Integrity checked: the password matches the file’s ${named(HASHES, pfx.macData.mac.digestAlgorithm.algorithmId)} checksum.`);
  return items;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 #-]+)-----([\s\S]*?)-----END \1-----/g;

function pemItems(text: string, notes: string[]): Item[] {
  const items: Item[] = [];
  for (const [, label, body] of text.matchAll(PEM_BLOCK)) {
    // RFC 1421 headers (Proc-Type, DEK-Info) come before a blank line.
    const headerEnd = body.search(/\r?\n\s*\r?\n/);
    const headers = headerEnd >= 0 && /^\s*[\w-]+:/.test(body) ? body.slice(0, headerEnd) : '';
    const data = (headers ? body.slice(headerEnd) : body).replace(/[^A-Za-z0-9+/=]/g, '');
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    } catch {
      items.push({ kind: 'other', title: label, note: 'The block is not valid Base64.' });
      continue;
    }
    const dekInfo = /DEK-Info:\s*([\w-]+)/i.exec(headers)?.[1];
    const schema = () => fromBer(bytes);
    switch (label) {
      case 'CERTIFICATE':
      case 'X509 CERTIFICATE':
      case 'TRUSTED CERTIFICATE': {
        const cert = tryParse(() => new pkijs.Certificate({ schema: schema()! }));
        items.push(cert ? { kind: 'certificate', cert, der: label === 'TRUSTED CERTIFICATE' ? bytesOf(cert.toSchema().toBER(false)) : bytes } : { kind: 'other', title: label, note: 'The certificate could not be read.' });
        break;
      }
      case 'CERTIFICATE REQUEST':
      case 'NEW CERTIFICATE REQUEST': {
        const csr = tryParse(() => new pkijs.CertificationRequest({ schema: schema()! }));
        items.push(csr ? { kind: 'request', csr } : { kind: 'other', title: label, note: 'The request could not be read.' });
        break;
      }
      case 'PKCS7':
      case 'CMS': {
        const content = tryParse(() => new pkijs.ContentInfo({ schema: schema()! }));
        if (content?.contentType === '1.2.840.113549.1.7.2') items.push(...signedDataCerts(content.content, notes));
        else items.push({ kind: 'other', title: label, note: 'Only PKCS#7 bundles of certificates are shown.' });
        break;
      }
      case 'X509 CRL': {
        const crl = tryParse(() => new pkijs.CertificateRevocationList({ schema: schema()! }));
        items.push(crl ? { kind: 'crl', crl } : { kind: 'other', title: label, note: 'The list could not be read.' });
        break;
      }
      case 'PRIVATE KEY': {
        const info = tryParse(() => new pkijs.PrivateKeyInfo({ schema: schema()! }));
        items.push({ kind: 'key', type: info ? privateKeyType(info) : null, encryption: null, format: 'PKCS#8', publicKey: info ? publicKeyOf(info) : undefined });
        break;
      }
      case 'ENCRYPTED PRIVATE KEY': {
        const bag = tryParse(() => new pkijs.PKCS8ShroudedKeyBag({ schema: schema()! }));
        items.push({ kind: 'key', type: null, encryption: bag ? encryptionName(bag.encryptionAlgorithm) : 'unknown method', format: 'PKCS#8' });
        break;
      }
      case 'RSA PRIVATE KEY':
      case 'EC PRIVATE KEY':
      case 'DSA PRIVATE KEY': {
        const type = label.split(' ')[0];
        let detail = type;
        if (!dekInfo) {
          if (type === 'RSA') detail = tryParse(() => `RSA ${bitLength(new pkijs.RSAPrivateKey({ schema: schema()! }).modulus.valueBlock.valueHexView)} bit`) ?? 'RSA';
          if (type === 'EC') detail = tryParse(() => `EC ${named(CURVES, new pkijs.ECPrivateKey({ schema: schema()! }).namedCurve ?? '')}`.trim()) ?? 'EC';
        }
        items.push({ kind: 'key', type: detail, encryption: dekInfo ? `${dekInfo} (OpenSSL traditional)` : null, format: type === 'RSA' ? 'PKCS#1' : type === 'EC' ? 'SEC 1' : 'OpenSSL traditional' });
        break;
      }
      case 'OPENSSH PRIVATE KEY':
        items.push(opensshKey(bytes));
        break;
      case 'PUBLIC KEY': {
        const spki = tryParse(() => new pkijs.PublicKeyInfo({ schema: schema()! }));
        items.push(spki ? { kind: 'public-key', spki, der: bytes } : { kind: 'other', title: label, note: 'The key could not be read.' });
        break;
      }
      case 'RSA PUBLIC KEY': {
        const key = tryParse(() => new pkijs.RSAPublicKey({ schema: schema()! }));
        items.push({ kind: 'other', title: 'RSA public key', note: key ? `RSA ${bitLength(key.modulus.valueBlock.valueHexView)} bit (PKCS#1)` : 'The key could not be read.' });
        break;
      }
      default:
        items.push({ kind: 'other', title: label.charAt(0) + label.slice(1).toLowerCase(), note: label.startsWith('PGP') ? 'OpenPGP data is not shown in detail.' : 'This kind of block is not shown in detail.' });
    }
  }
  return items;
}

async function parseFile(file: File): Promise<Parsed> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const notes: string[] = [];
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, 1 << 20));
  if (/-----BEGIN [A-Z0-9 #-]+-----/.test(text)) {
    const items = pemItems(new TextDecoder().decode(bytes), notes);
    return { items, format: items.length === 1 ? 'PEM' : `PEM bundle`, notes };
  }
  // Base64 without the PEM armor, as some tools save .cer files.
  if (/^[\sA-Za-z0-9+/=]+$/.test(text) && text.trim().length > 64) {
    const decoded = tryParse(() => Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
    const found = decoded && derItems(decoded, notes);
    if (found) return { ...found, format: `${found.format.replace(/ \(DER\)|DER /, '')} (Base64)`, notes };
  }
  const schema = fromBer(bytes);
  if (isPfx(schema)) return { items: await readPfx(bytes, file.name, notes), format: 'PKCS#12', notes };
  const found = derItems(bytes, notes);
  if (found) return { ...found, notes };
  throw new Error('The file contains no certificate, request or key in PEM, DER, PKCS#7 or PKCS#12 format.');
}

// ---- Chains ---------------------------------------------------------------------------------------------------------

function extension(cert: pkijs.Certificate, oid: string): pkijs.Extension | undefined {
  return cert.extensions?.find((e) => e.extnID === oid);
}
function subjectKeyId(cert: pkijs.Certificate): Uint8Array | undefined {
  const value = extension(cert, '2.5.29.14')?.parsedValue;
  return value instanceof asn1js.OctetString ? value.valueBlock.valueHexView : undefined;
}
function authorityKeyId(cert: pkijs.Certificate): Uint8Array | undefined {
  const value = extension(cert, '2.5.29.35')?.parsedValue;
  return value instanceof pkijs.AuthorityKeyIdentifier ? value.keyIdentifier?.valueBlock.valueHexView : undefined;
}
const selfIssued = (cert: pkijs.Certificate) => nameKey(cert.subject) === nameKey(cert.issuer);

function issuerIn(cert: pkijs.Certificate, all: CertItem[]): CertItem | undefined {
  if (selfIssued(cert)) return undefined;
  const aki = authorityKeyId(cert);
  return all.find((p) => p.cert !== cert && nameKey(p.cert.subject) === nameKey(cert.issuer) && (!aki || !subjectKeyId(p.cert) || equalBytes(aki, subjectKeyId(p.cert))));
}

/** Chains from each leaf up to the last issuer found in the file. */
function chains(certs: CertItem[]): CertItem[][] {
  const issuers = new Set(certs.map((c) => issuerIn(c.cert, certs)).filter(Boolean));
  return certs.filter((c) => !issuers.has(c)).map((leaf) => {
    const chain = [leaf];
    for (let next = issuerIn(leaf.cert, certs); next && !chain.includes(next); next = issuerIn(next.cert, certs)) chain.push(next);
    return chain;
  });
}

// ---- Cards ----------------------------------------------------------------------------------------------------------

function card(title: string, kind: string, badge: HTMLElement | null, rows: Row[]): HTMLElement {
  const list = h('dl');
  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === '') continue;
    list.append(h('dt', {}, label), h('dd', {}, value));
  }
  return h('div', { class: 'record' }, h('div', { class: 'record-hd' }, h('b', {}, title), h('span', { class: 'cert-kind' }, kind), badge), list);
}
const badge = (text: string, tone: 'ok' | 'warn' | 'err' | 'info', title?: string) => h('span', { class: `cert-badge ${tone}`, title }, text);

function extensionRows(extensions: pkijs.Extension[], certificate: boolean): Row[] {
  const find = (oid: string) => extensions.find((e) => e.extnID === oid);
  const rows: Row[] = [];
  const san = find('2.5.29.17');
  if (san?.parsedValue instanceof pkijs.AltName) rows.push(['Alternative names', withCritical(lines(san.parsedValue.altNames.map(generalName)), san)]);
  const ku = find('2.5.29.15');
  if (ku?.parsedValue instanceof asn1js.BitString) {
    const bits = ku.parsedValue.valueBlock.valueHexView;
    const set = KEY_USAGES.filter((_, i) => (bits[i >> 3] >> (7 - (i & 7))) & 1);
    rows.push(['Key usage', withCritical(set.join(', ') || 'none', ku)]);
  }
  const eku = find('2.5.29.37');
  if (eku?.parsedValue instanceof pkijs.ExtKeyUsage) rows.push(['Extended key usage', withCritical(lines(eku.parsedValue.keyPurposes.map((p) => named(EXTENDED_USAGES, p))), eku)]);
  const bc = find('2.5.29.19');
  if (bc?.parsedValue instanceof pkijs.BasicConstraints) {
    const length = bc.parsedValue.pathLenConstraint;
    const max = length === undefined ? null : typeof length === 'number' ? length : length.valueBlock.valueDec;
    const path = max === null ? '' : max === 0 ? ' that signs only end-entity certificates (path length 0)' : `, path length ${max}`;
    rows.push(['Basic constraints', withCritical(bc.parsedValue.cA ? `Certificate authority${path}` : 'Not a certificate authority', bc)]);
  }
  const ski = find('2.5.29.14');
  if (ski?.parsedValue instanceof asn1js.OctetString) rows.push(['Subject key ID', mono(hex(ski.parsedValue.valueBlock.valueHexView))]);
  const aki = find('2.5.29.35');
  if (aki?.parsedValue instanceof pkijs.AuthorityKeyIdentifier) {
    const v = aki.parsedValue;
    rows.push(['Authority key ID', lines([
      ...(v.keyIdentifier ? [mono(hex(v.keyIdentifier.valueBlock.valueHexView))] : []),
      ...(v.authorityCertIssuer ?? []).map(generalName),
      ...(v.authorityCertSerialNumber ? [`Serial ${integerHex(v.authorityCertSerialNumber)}`] : []),
    ])]);
  }
  const policies = find('2.5.29.32');
  if (policies?.parsedValue instanceof pkijs.CertificatePolicies) {
    rows.push(['Policies', withCritical(lines(policies.parsedValue.certificatePolicies.flatMap((p) => [
      POLICIES[p.policyIdentifier] ? `${POLICIES[p.policyIdentifier]} (${p.policyIdentifier})` : p.policyIdentifier,
      ...(p.policyQualifiers ?? []).map((q) => (q.policyQualifierId === '1.3.6.1.5.5.7.2.1' ? `  CPS: ${asn1Text(q.qualifier)}` : '  User notice')),
    ])), policies)]);
  }
  const crl = find('2.5.29.31');
  if (crl?.parsedValue instanceof pkijs.CRLDistributionPoints) {
    rows.push(['CRL distribution', lines(crl.parsedValue.distributionPoints.flatMap((d) => (Array.isArray(d.distributionPoint) ? d.distributionPoint.map(generalName) : d.distributionPoint ? ['Relative name'] : [])))]);
  }
  const aia = find('1.3.6.1.5.5.7.1.1');
  if (aia?.parsedValue instanceof pkijs.InfoAccess) {
    const method = (oid: string) => ({ '1.3.6.1.5.5.7.48.1': 'OCSP', '1.3.6.1.5.5.7.48.2': 'CA issuers' })[oid] ?? oid;
    rows.push(['Authority info access', lines(aia.parsedValue.accessDescriptions.map((a) => `${method(a.accessMethod)}: ${generalName(a.accessLocation).replace(/^URI: /, '')}`))]);
  }
  const shown = new Set(['2.5.29.17', '2.5.29.15', '2.5.29.37', '2.5.29.19', '2.5.29.14', '2.5.29.35', '2.5.29.32', '2.5.29.31', '1.3.6.1.5.5.7.1.1']);
  const others = extensions.filter((e) => !shown.has(e.extnID)).map((e) => {
    const name = EXTENSIONS[e.extnID];
    let text = name ? `${name} (${e.extnID})` : `Unknown extension ${e.extnID}`;
    if (e.extnID === '1.3.6.1.4.1.11129.2.4.2' && e.parsedValue instanceof pkijs.SignedCertificateTimestampList) text = `${e.parsedValue.timestamps.length} signed certificate timestamps (${e.extnID})`;
    return withCritical(text, e) as Node;
  });
  if (others.length) rows.push([certificate ? 'Other extensions' : 'Other requested extensions', lines(others)]);
  return rows;
}

async function fingerprint(bytes: Uint8Array, algorithm: 'SHA-256' | 'SHA-1'): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest(algorithm, bytes.slice())));
}

async function verifies(cert: pkijs.Certificate, issuer: pkijs.Certificate): Promise<boolean | null> {
  try {
    return await cert.verify(issuer);
  } catch {
    return null; // algorithm not available in this browser
  }
}

function validity(cert: pkijs.Certificate): HTMLElement {
  const now = Date.now();
  const from = cert.notBefore.value.getTime();
  const until = cert.notAfter.value.getTime();
  const note = 'Only the dates are checked here, not trust or revocation.';
  if (now < from) return badge('Not yet valid', 'warn', note);
  if (now > until) return badge('Expired', 'err', note);
  return badge('Valid', 'ok', note);
}

async function certificateCard(item: CertItem, all: CertItem[], position: string | null, keys: KeyItem[]): Promise<HTMLElement> {
  const { cert } = item;
  const issuer = issuerIn(cert, all);
  const self = selfIssued(cert);
  const signedBy = self
    ? `Itself (self-signed${(await verifies(cert, cert)) === true ? ', signature valid' : ''})`
    : issuer
      ? `${commonName(issuer.cert.subject)} in this file${{ true: ', signature valid', false: ', signature INVALID', null: '' }[String(await verifies(cert, issuer.cert))]}`
      : 'An issuer that is not in this file';
  const modulus = rsaModulus(cert.subjectPublicKeyInfo);
  const key = keys.find((k) => (item.keyId && k.keyId === item.keyId) || (modulus && equalBytes(k.publicKey, modulus)));
  const ca = extension(cert, '2.5.29.19')?.parsedValue;
  const isCa = ca instanceof pkijs.BasicConstraints && ca.cA;
  const kind = [position, self ? 'Self-signed' : null, isCa ? 'CA certificate' : 'Certificate'].filter(Boolean).join(' · ');
  const element = card(commonName(cert.subject) ?? 'Certificate', kind, validity(cert), [
    ['Name in file', item.alias],
    ['Subject', lines(nameLines(cert.subject))],
    ['Issuer', lines(nameLines(cert.issuer))],
    ['Signed by', signedBy],
    ['Valid from', utcText(cert.notBefore.value)],
    ['Valid until', `${utcText(cert.notAfter.value)} (${relative(cert.notAfter.value)})`],
    ['Serial number', mono(integerHex(cert.serialNumber))],
    ['Version', String(cert.version + 1)],
    ['Signature', signatureName(cert.signatureAlgorithm)],
    ['Public key', publicKeyText(cert.subjectPublicKeyInfo)],
    ...extensionRows(cert.extensions ?? [], true),
    ['Private key', key ? 'In this file (see below)' : null],
    ['SHA-256 fingerprint', mono(await fingerprint(item.der, 'SHA-256'))],
    ['SHA-1 fingerprint', mono(await fingerprint(item.der, 'SHA-1'))],
  ]);
  return element;
}

async function requestCard(csr: pkijs.CertificationRequest): Promise<HTMLElement> {
  const rows: Row[] = [
    ['Subject', lines(nameLines(csr.subject))],
    ['Public key', publicKeyText(csr.subjectPublicKeyInfo)],
    ['Signature', signatureName(csr.signatureAlgorithm)],
  ];
  let valid: boolean | null = null;
  try {
    valid = await csr.verify();
  } catch {
    // algorithm not available
  }
  if (valid !== null) rows.push(['Signature check', valid ? 'Valid: signed with the requested key' : 'INVALID']);
  for (const attr of csr.attributes ?? []) {
    if (attr.type === '1.2.840.113549.1.9.14') {
      const extensions = tryParse(() => new pkijs.Extensions({ schema: attr.values[0] }).extensions) ?? [];
      rows.push(...extensionRows(extensions, false).map(([label, value]): Row => [`Requested: ${label.toLowerCase()}`, value]));
    } else if (attr.type === '1.2.840.113549.1.9.7') rows.push(['Challenge password', 'Set (not shown)']);
    else if (attr.type === '1.2.840.113549.1.9.2') rows.push(['Unstructured name', asn1Text(attr.values[0])]);
    else rows.push(['Attribute', attr.type]);
  }
  rows.push(['SHA-256 fingerprint', mono(await fingerprint(bytesOf(csr.toSchema().toBER(false)), 'SHA-256'))]);
  return card(commonName(csr.subject) ?? 'Certificate request', 'Certificate request', badge('Request', 'info'), rows);
}

function keyCard(key: KeyItem, certs: CertItem[]): HTMLElement {
  const owner = certs.find((c) => (key.keyId && c.keyId === key.keyId) || (key.publicKey && equalBytes(rsaModulus(c.cert.subjectPublicKeyInfo), key.publicKey)));
  return card('Private key', key.type ?? (key.encryption ? 'Type hidden by the encryption' : 'Unknown type'), key.encryption ? badge('Encrypted', 'ok') : badge('Unencrypted', 'err'), [
    ['Name in file', key.alias],
    ['Key', key.type ? `${key.type}${key.encryption ? ', encrypted' : ', unencrypted'}` : null],
    ['Encryption', key.encryption ?? 'None: anyone with this file can use the key'],
    ['Format', key.format],
    ['Belongs to', owner ? commonName(owner.cert.subject) : null],
    ['Content', 'Not shown'],
  ]);
}

async function publicKeyCard(item: PublicKeyItem): Promise<HTMLElement> {
  return card('Public key', publicKeyText(item.spki), null, [
    ['Algorithm', publicKeyText(item.spki)],
    ['SHA-256 of the key', mono(await fingerprint(item.der, 'SHA-256'))],
  ]);
}

function crlCard(crl: pkijs.CertificateRevocationList): HTMLElement {
  const next = crl.nextUpdate?.value;
  const stale = next && next.getTime() < Date.now();
  return card(commonName(crl.issuer) ?? 'Revocation list', 'Certificate revocation list', stale ? badge('Outdated', 'warn') : badge('Current', 'ok'), [
    ['Issuer', lines(nameLines(crl.issuer))],
    ['Issued', utcText(crl.thisUpdate.value)],
    ['Next update', next ? `${utcText(next)} (${relative(next)})` : null],
    ['Revoked certificates', (crl.revokedCertificates?.length ?? 0).toLocaleString('en-US')],
    ['Signature', signatureName(crl.signatureAlgorithm)],
  ]);
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Reading certificates …');
  const parsed = await parseFile(file);
  const { items } = parsed;
  if (!items.length) throw new Error('The file contains no certificates or keys.');

  const certs = items.filter((i): i is CertItem => i.kind === 'certificate');
  const keys = items.filter((i): i is KeyItem => i.kind === 'key');
  const linked = chains(certs).filter((c) => c.length > 1);
  // Certificates in chain order (leaf first), then those that belong to no chain, then everything else.
  const ordered = [...new Set([...linked.flat(), ...certs])];
  const position = new Map<CertItem, string>();
  for (const chain of linked) {
    chain.forEach((c, i) => position.set(c, i === 0 ? 'Leaf' : i === chain.length - 1 && selfIssued(c.cert) ? 'Root' : 'Intermediate'));
  }

  const list = h('div', { class: 'records-list' });
  if (keys.length) {
    list.append(h('div', { class: 'cert-alert', role: 'note' }, icon('alert', 16, 1.8),
      h('span', {}, keys.length === 1 ? 'This file contains a private key. Its content is not shown here; keep the file secret.' : `This file contains ${keys.length} private keys. Their content is not shown here; keep the file secret.`)));
  }
  const cards = new Map<CertItem, HTMLElement>();
  for (const [i, item] of ordered.entries()) {
    progress(`Checking certificate ${i + 1} of ${ordered.length} …`, i / ordered.length);
    cards.set(item, await certificateCard(item, certs, position.get(item) ?? null, keys));
  }
  if (linked.length) {
    const chainCard = h('div', { class: 'record' }, h('div', { class: 'record-hd' }, h('b', {}, linked.length === 1 ? 'Certificate chain' : `${linked.length} certificate chains`)));
    for (const chain of linked) {
      chainCard.append(h('ol', { class: 'cert-chain' }, ...chain.map((c, depth) =>
        h('li', { style: `--depth:${depth}` }, h('a', { onclick: () => cards.get(c)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, commonName(c.cert.subject) ?? 'Certificate'),
          h('span', { class: 'c3' }, position.get(c) ?? '')))));
    }
    list.append(chainCard);
  }
  list.append(...ordered.map((c) => cards.get(c)!));
  for (const item of items) {
    if (item.kind === 'request') list.append(await requestCard(item.csr));
    else if (item.kind === 'key') list.append(keyCard(item, certs));
    else if (item.kind === 'public-key') list.append(await publicKeyCard(item));
    else if (item.kind === 'crl') list.append(crlCard(item.crl));
    else if (item.kind === 'other') list.append(card(item.title, 'Not shown in detail', null, [['Note', item.note]]));
  }
  for (const note of parsed.notes) list.append(h('p', { class: 'records-note' }, note));
  container.append(h('div', { class: 'records cert-view' }, list));

  const counts = [
    certs.length && `${certs.length} ${certs.length === 1 ? 'certificate' : 'certificates'}`,
    keys.length && `${keys.length} private ${keys.length === 1 ? 'key' : 'keys'}`,
  ].filter(Boolean);
  toolbar.append(h('span', { class: 'meta' }, [parsed.format, ...counts].join(' · ')));
  return { destroy: () => {} };
}

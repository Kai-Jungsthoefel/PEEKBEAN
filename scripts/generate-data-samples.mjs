// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the samples of the data formats: a Parquet and an Arrow table, an Access database and a fictional
// certificate chain (PEM, DER, PKCS#7, CSR, PKCS#12). Everything is made up here, so the output can be published as
// CC0-1.0 like the other samples.
// - Parquet (hyparquet-writer) and Arrow (apache-arrow) come out identical on every run.
// - The certificates use fresh random keys and signatures each time, so they differ on every run. The only private
//   key is the one inside identity.p12, encrypted with the password "sample".
// - database/parts.mdb is written by Microsoft's Jet 4.0 database engine through ADOX/ADO (COM), which only exists as
//   a 32-bit component of Windows: the script runs the 32-bit Windows PowerShell for it and skips the file elsewhere.
//   Jet stores creation times in the file, so it differs on every run too. Jet cannot write .accdb (that needs the
//   Access Database Engine), so there is no .accdb sample.
// Usage: node scripts/generate-data-samples.mjs [file ...] (after npm install). With file names (relative to
// samples/), only those are written.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import * as arrow from 'apache-arrow';
import * as asn1js from 'asn1js';
import { ByteWriter, parquetWrite } from 'hyparquet-writer';
import * as pkijs from 'pkijs';

const ROOT = path.resolve(import.meta.dirname, '..', 'samples');
const written = [];
const only = process.argv.slice(2).map((rel) => rel.replace(/\\/g, '/').replace(/^samples\//, ''));
const wanted = (rel) => !only.length || only.includes(rel);

function write(rel, data) {
  if (!wanted(rel)) return;
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push([rel, Buffer.byteLength(data)]);
}

// Deterministic pseudo-random numbers, so the tables come out identical on every run.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

// ---- Parts table (shared by Parquet and Arrow) ---------------------------------------------------------------

const PARTS = [
  ['Gear z18', 'C45', 64.0, 1.25, ['gear', 'hardened']],
  ['Flange plate', 'S235JR', 38.5, 2.1, ['flange']],
  ['Hex bolt M8x30', '8.8 zinc plated', 0.18, 0.016, ['bolt', 'DIN 933']],
  ['Hex nut M8', '8 zinc plated', 0.06, 0.005, ['nut', 'DIN 934']],
  ['Shaft seal 30x47x7', 'NBR', 3.9, 0.012, ['seal']],
  ['Bearing 6205', '100Cr6', 7.45, 0.13, ['bearing', 'C3']],
  ['Shaft Ø30', '42CrMo4', 96.0, 3.4, ['shaft', 'ground']],
  ['Cover', 'EN AW-6082', 22.9, 0.4, []],
];
const ROWS = 2500;

function partsRows() {
  const random = prng(20261027);
  const base = Date.UTC(2026, 0, 5);
  return Array.from({ length: ROWS }, (_, i) => {
    const [name, material, price, weight, tags] = PARTS[i % PARTS.length];
    const batch = Math.floor(i / PARTS.length) + 1;
    const day = Math.floor(i / 7);
    return {
      item: 1000 + i,
      description: batch > 1 ? `${name}, batch ${batch}` : name,
      material: i % 11 === 5 ? null : material,
      quantity: 1 + Math.floor(random() * 120),
      price: Math.round(price * (1 + (batch % 5) * 0.01) * 100) / 100,
      weight_kg: weight,
      in_stock: random() > 0.2,
      added: new Date(base + day * 86400000),
      updated: new Date(base + day * 86400000 + Math.floor(random() * 86400) * 1000),
      tags: i % 13 === 7 ? null : tags,
      size: { length_mm: 20 + (i % PARTS.length) * 15, width_mm: 10 + (i % 4) * 5 },
    };
  });
}

// ---- Parquet --------------------------------------------------------------------------------------------------

function parquet(rows) {
  const column = (name) => rows.map((r) => r[name]);
  const writer = new ByteWriter();
  parquetWrite({
    writer,
    columnData: [
      { name: 'item', data: column('item') },
      { name: 'description', data: column('description') },
      { name: 'material', data: column('material') },
      { name: 'quantity', data: column('quantity') },
      // Decimal with two places, stored as integer cents.
      { name: 'price', data: rows.map((r) => BigInt(Math.round(r.price * 100))) },
      { name: 'weight_kg', data: column('weight_kg') },
      { name: 'in_stock', data: column('in_stock') },
      { name: 'added', data: column('added') },
      { name: 'updated', data: rows.map((r) => BigInt(r.updated.getTime()) * 1000n) },
      { name: 'tags', data: column('tags') },
      { name: 'size', data: column('size') },
    ],
    schema: [
      { name: 'schema', num_children: 11 },
      { name: 'item', type: 'INT32', repetition_type: 'REQUIRED' },
      { name: 'description', type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' }, repetition_type: 'REQUIRED' },
      { name: 'material', type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' }, repetition_type: 'OPTIONAL' },
      { name: 'quantity', type: 'INT32', repetition_type: 'REQUIRED' },
      { name: 'price', type: 'INT64', converted_type: 'DECIMAL', logical_type: { type: 'DECIMAL', precision: 10, scale: 2 }, precision: 10, scale: 2, repetition_type: 'REQUIRED' },
      { name: 'weight_kg', type: 'DOUBLE', repetition_type: 'REQUIRED' },
      { name: 'in_stock', type: 'BOOLEAN', repetition_type: 'REQUIRED' },
      { name: 'added', type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' }, repetition_type: 'REQUIRED' },
      { name: 'updated', type: 'INT64', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' }, repetition_type: 'OPTIONAL' },
      { name: 'tags', converted_type: 'LIST', logical_type: { type: 'LIST' }, repetition_type: 'OPTIONAL', num_children: 1 },
      { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
      { name: 'element', type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' }, repetition_type: 'OPTIONAL' },
      { name: 'size', repetition_type: 'OPTIONAL', num_children: 2 },
      { name: 'length_mm', type: 'INT32', repetition_type: 'OPTIONAL' },
      { name: 'width_mm', type: 'INT32', repetition_type: 'OPTIONAL' },
    ],
    codec: 'SNAPPY',
    rowGroupSize: 1000,
    kvMetadata: [
      { key: 'description', value: 'Sample parts list, made up for testing.' },
      { key: 'columns', value: JSON.stringify({ price: { unit: 'EUR' }, weight_kg: { unit: 'kg' }, size: { unit: 'mm' } }) },
    ],
  });
  return Buffer.from(writer.getBuffer());
}

// ---- Arrow ----------------------------------------------------------------------------------------------------

function arrowFile(rows) {
  const column = (name) => rows.map((r) => r[name]);
  const { Field, Float64, Int32, Int64, Utf8, Bool, DateDay, TimestampMillisecond, List, Struct, Dictionary, Decimal } = arrow;
  // Decimal128 with scale 2: the unscaled value as four little-endian 32-bit words.
  const cents = new Uint32Array(rows.length * 4);
  rows.forEach((r, i) => (cents[i * 4] = Math.round(r.price * 100)));
  const table = new arrow.Table({
    item: arrow.vectorFromArray(column('item'), new Int32()),
    description: arrow.vectorFromArray(column('description'), new Utf8()),
    material: arrow.vectorFromArray(column('material'), new Dictionary(new Utf8(), new Int32())),
    quantity: arrow.vectorFromArray(rows.map((r) => BigInt(r.quantity)), new Int64()),
    price: arrow.makeVector({ type: new Decimal(2, 10, 128), data: cents, length: rows.length }),
    weight_kg: arrow.vectorFromArray(column('weight_kg'), new Float64()),
    in_stock: arrow.vectorFromArray(column('in_stock'), new Bool()),
    added: arrow.vectorFromArray(column('added'), new DateDay()),
    updated: arrow.vectorFromArray(column('updated'), new TimestampMillisecond('UTC')),
    tags: arrow.vectorFromArray(column('tags'), new List(new Field('item', new Utf8(), true))),
    size: arrow.vectorFromArray(column('size'), new Struct([new Field('length_mm', new Int32()), new Field('width_mm', new Int32())])),
  });
  table.schema.metadata.set('description', 'Sample parts list, made up for testing.');
  return Buffer.from(arrow.tableToIPC(table, 'file'));
}

// ---- Certificates ---------------------------------------------------------------------------------------------

const subtle = webcrypto.subtle;
pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto }));

const OID = {
  commonName: '2.5.4.3', country: '2.5.4.6', locality: '2.5.4.7', state: '2.5.4.8', organization: '2.5.4.10', unit: '2.5.4.11',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14', authorityKeyId: '2.5.29.35', crlDistribution: '2.5.29.31', policies: '2.5.29.32',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
};

/** One attribute per RDN, as CAs write names (PKI.js alone would put them all into one multi-valued RDN). */
function distinguishedName(pairs) {
  const rdns = pairs.map(([type, value]) => {
    const asn1 = type === 'country' ? new asn1js.PrintableString({ value }) : new asn1js.Utf8String({ value });
    return new asn1js.Set({ value: [new pkijs.AttributeTypeAndValue({ type: OID[type], value: asn1 }).toSchema()] });
  });
  return pkijs.RelativeDistinguishedNames.fromBER(new asn1js.Sequence({ value: rdns }).toBER(false));
}

const extension = (extnID, critical, value) => new pkijs.Extension({ extnID, critical, extnValue: value.toBER(false) });
/** Key usage bits in RFC 5280 order: digitalSignature, nonRepudiation, keyEncipherment, …, keyCertSign, cRLSign. */
function keyUsage(...bits) {
  const value = bits.reduce((v, bit) => v | (0x8000 >> bit), 0);
  const last = Math.max(...bits);
  const bytes = last < 8 ? [value >> 8] : [value >> 8, value & 0xff];
  return new asn1js.BitString({ valueHex: new Uint8Array(bytes).buffer, unusedBits: (bytes.length * 8 - 1 - last) % 8 });
}
const uri = (value) => new pkijs.GeneralName({ type: 6, value });
const dns = (value) => new pkijs.GeneralName({ type: 2, value });

async function keyIdentifier(publicKey) {
  const spki = new Uint8Array(await subtle.exportKey('spki', publicKey));
  const info = pkijs.PublicKeyInfo.fromBER(spki);
  return new Uint8Array(await subtle.digest('SHA-1', info.subjectPublicKey.valueBlock.valueHexView));
}

async function certificate({ serial, subject, issuer, notBefore, notAfter, keys, issuerKeys, hash, extensions }) {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ valueHex: new Uint8Array(serial).buffer });
  cert.subject = distinguishedName(subject);
  cert.issuer = distinguishedName(issuer);
  cert.notBefore.value = new Date(notBefore);
  cert.notAfter.value = new Date(notAfter);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  const ski = await keyIdentifier(keys.publicKey);
  const aki = await keyIdentifier(issuerKeys.publicKey);
  cert.extensions = [
    ...extensions,
    extension(OID.subjectKeyId, false, new asn1js.OctetString({ valueHex: ski.buffer })),
    ...(subject === issuer ? [] : [extension(OID.authorityKeyId, false, new pkijs.AuthorityKeyIdentifier({ keyIdentifier: new asn1js.OctetString({ valueHex: aki.buffer }) }).toSchema())]),
  ];
  await cert.sign(issuerKeys.privateKey, hash);
  return cert;
}

const rsaKeys = (bits) =>
  subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const ecKeys = (curve) => subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify']);

const der = (object) => Buffer.from(object.toSchema(true).toBER(false));
function pem(label, bytes) {
  const lines = Buffer.from(bytes).toString('base64').match(/.{1,64}/g);
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
const dnText = (pairs) => pairs.map(([type, value]) => `${{ commonName: 'CN', country: 'C', organization: 'O', unit: 'OU', locality: 'L', state: 'ST' }[type]}=${value}`).join(', ');

async function certificates() {
  const ROOT_DN = [['country', 'US'], ['organization', 'Example Org'], ['commonName', 'Example Root CA']];
  const INTERMEDIATE_DN = [['country', 'US'], ['organization', 'Example Org'], ['unit', 'Example Trust Services'], ['commonName', 'Example Intermediate CA']];
  const LEAF_DN = [['country', 'US'], ['state', 'Example State'], ['locality', 'Example City'], ['organization', 'Example Org'], ['commonName', 'www.example.com']];
  const OLD_DN = [['country', 'US'], ['organization', 'Example Org'], ['commonName', 'old.example.com']];

  const rootKeys = await rsaKeys(3072);
  const intermediateKeys = await ecKeys('P-384');
  const leafKeys = await rsaKeys(2048);
  const oldKeys = await ecKeys('P-256');

  const root = await certificate({
    serial: [0x01, 0x00, 0x01], subject: ROOT_DN, issuer: ROOT_DN, keys: rootKeys, issuerKeys: rootKeys, hash: 'SHA-384',
    notBefore: '2025-01-01T00:00:00Z', notAfter: '2049-12-31T23:59:59Z',
    extensions: [
      extension(OID.basicConstraints, true, new pkijs.BasicConstraints({ cA: true }).toSchema()),
      extension(OID.keyUsage, true, keyUsage(5, 6)),
    ],
  });
  const intermediate = await certificate({
    serial: [0x02, 0x00, 0x01], subject: INTERMEDIATE_DN, issuer: ROOT_DN, keys: intermediateKeys, issuerKeys: rootKeys, hash: 'SHA-384',
    notBefore: '2025-01-01T00:00:00Z', notAfter: '2039-12-31T23:59:59Z',
    extensions: [
      extension(OID.basicConstraints, true, new pkijs.BasicConstraints({ cA: true, pathLenConstraint: 0 }).toSchema()),
      extension(OID.keyUsage, true, keyUsage(0, 5, 6)),
      extension(OID.crlDistribution, false, new pkijs.CRLDistributionPoints({
        distributionPoints: [new pkijs.DistributionPoint({ distributionPoint: [uri('http://crl.example.com/root.crl')] })],
      }).toSchema()),
    ],
  });
  const leafExtensions = (sans) => [
    extension(OID.basicConstraints, true, new pkijs.BasicConstraints({ cA: false }).toSchema()),
    extension(OID.keyUsage, true, keyUsage(0, 2)),
    extension(OID.extKeyUsage, false, new pkijs.ExtKeyUsage({ keyPurposes: ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'] }).toSchema()),
    extension(OID.subjectAltName, false, new pkijs.AltName({ altNames: sans.map(dns) }).toSchema()),
    extension(OID.policies, false, new pkijs.CertificatePolicies({
      certificatePolicies: [new pkijs.PolicyInformation({
        policyIdentifier: '2.23.140.1.2.2',
        policyQualifiers: [new pkijs.PolicyQualifierInfo({ policyQualifierId: '1.3.6.1.5.5.7.2.1', qualifier: new asn1js.IA5String({ value: 'https://pki.example.com/cps' }) })],
      })],
    }).toSchema()),
    extension(OID.crlDistribution, false, new pkijs.CRLDistributionPoints({
      distributionPoints: [new pkijs.DistributionPoint({ distributionPoint: [uri('http://crl.example.com/intermediate.crl')] })],
    }).toSchema()),
    extension(OID.authorityInfoAccess, false, new pkijs.InfoAccess({
      accessDescriptions: [
        new pkijs.AccessDescription({ accessMethod: '1.3.6.1.5.5.7.48.1', accessLocation: uri('http://ocsp.example.com') }),
        new pkijs.AccessDescription({ accessMethod: '1.3.6.1.5.5.7.48.2', accessLocation: uri('http://pki.example.com/intermediate.crt') }),
      ],
    }).toSchema()),
  ];
  const leaf = await certificate({
    serial: [0x03, 0x2a, 0x5e, 0x11, 0x07], subject: LEAF_DN, issuer: INTERMEDIATE_DN, keys: leafKeys, issuerKeys: intermediateKeys, hash: 'SHA-384',
    notBefore: '2026-01-01T00:00:00Z', notAfter: '2035-12-31T23:59:59Z',
    extensions: [
      ...leafExtensions(['www.example.com', 'example.com']),
      // An extension the viewer does not know, from the UUID arc anyone may use (ITU-T X.667).
      extension('2.25.329800735698586629295641978511506172918', false, new asn1js.Utf8String({ value: 'Sample extension' })),
    ],
  });
  const expired = await certificate({
    serial: [0x03, 0x00, 0x99], subject: OLD_DN, issuer: INTERMEDIATE_DN, keys: oldKeys, issuerKeys: intermediateKeys, hash: 'SHA-384',
    notBefore: '2020-01-01T00:00:00Z', notAfter: '2021-01-01T00:00:00Z',
    extensions: leafExtensions(['old.example.com']),
  });

  const chain = [[LEAF_DN, INTERMEDIATE_DN, leaf], [INTERMEDIATE_DN, ROOT_DN, intermediate], [ROOT_DN, ROOT_DN, root]];
  write('certs/chain.pem', chain.map(([s, i, c]) => `subject=${dnText(s)}\nissuer=${dnText(i)}\n${pem('CERTIFICATE', der(c))}`).join('\n'));
  write('certs/www.example.com.crt', der(leaf));
  write('certs/expired.cer', pem('CERTIFICATE', der(expired)));

  // PKCS#7 bundle: signed data without content or signers, only the certificates.
  const bundle = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1' }),
    certificates: [leaf, intermediate, root],
  });
  write('certs/chain.p7b', der(new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: bundle.toSchema(true) })));

  const csr = new pkijs.CertificationRequest();
  csr.subject = distinguishedName(LEAF_DN);
  await csr.subjectPublicKeyInfo.importKey(leafKeys.publicKey);
  csr.attributes = [new pkijs.Attribute({
    type: '1.2.840.113549.1.9.14',
    values: [new pkijs.Extensions({ extensions: [extension(OID.subjectAltName, false, new pkijs.AltName({ altNames: [dns('www.example.com'), dns('example.com')] }).toSchema())] }).toSchema()],
  })];
  await csr.sign(leafKeys.privateKey, 'SHA-256');
  write('certs/www.example.com.csr', pem('CERTIFICATE REQUEST', der(csr)));

  write('certs/identity.p12', await pkcs12(leafKeys.privateKey, [leaf, intermediate, root], 'sample'));
}

/** PKCS#12 as current OpenSSL writes it: key and certificates encrypted with PBES2 (PBKDF2-SHA256, AES-256-CBC), SHA-256 MAC. */
async function pkcs12(privateKey, certs, password) {
  const passwordBytes = new TextEncoder().encode(password).buffer;
  const keyInfo = pkijs.PrivateKeyInfo.fromBER(new Uint8Array(await subtle.exportKey('pkcs8', privateKey)));
  const localKeyId = new Uint8Array(await subtle.digest('SHA-1', certs[0].toSchema(true).toBER(false))).buffer;
  const attributes = (name, keyId) => [
    new pkijs.Attribute({ type: '1.2.840.113549.1.9.20', values: [new asn1js.BmpString({ value: name })] }),
    ...(keyId ? [new pkijs.Attribute({ type: '1.2.840.113549.1.9.21', values: [new asn1js.OctetString({ valueHex: keyId })] })] : []),
  ];
  const encryption = { password: passwordBytes, contentEncryptionAlgorithm: { name: 'AES-CBC', length: 256 }, hmacHashAlgorithm: 'SHA-256', iterationCount: 2048 };
  const keyBag = new pkijs.PKCS8ShroudedKeyBag({ parsedValue: keyInfo });
  await keyBag.makeInternalValues(encryption);
  const pfx = new pkijs.PFX({
    parsedValue: {
      integrityMode: 0,
      authenticatedSafe: new pkijs.AuthenticatedSafe({
        parsedValue: {
          safeContents: [
            {
              privacyMode: 1,
              value: new pkijs.SafeContents({
                safeBags: certs.map((cert, i) => new pkijs.SafeBag({
                  bagId: '1.2.840.113549.1.12.10.1.3',
                  bagValue: new pkijs.CertBag({ parsedValue: cert }),
                  bagAttributes: i === 0 ? attributes('www.example.com', localKeyId) : undefined,
                })),
              }),
            },
            {
              privacyMode: 0,
              value: new pkijs.SafeContents({
                safeBags: [new pkijs.SafeBag({ bagId: '1.2.840.113549.1.12.10.1.2', bagValue: keyBag, bagAttributes: attributes('www.example.com', localKeyId) })],
              }),
            },
          ],
        },
      }),
    },
  });
  await pfx.parsedValue.authenticatedSafe.makeInternalValues({ safeContents: [encryption, {}] });
  await pfx.makeInternalValues({ password: passwordBytes, iterations: 2048, pbkdf2HashAlgorithm: 'SHA-256', hmacHashAlgorithm: 'SHA-256' });
  return Buffer.from(pfx.toSchema().toBER(false));
}

// ---- Access (Jet 4.0 via ADOX) ---------------------------------------------------------------------------------

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = (x - 16) ** 2 + (y - 16) ** 2 < 144;
    raw.set(inside ? [255, 255, 255, 255] : [242, 90 + x * 3, 40 + y * 5, 255], y * (w * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Typed PowerShell literals; casts from strings are culture-invariant in PowerShell.
const ps = {
  date: (s) => ({ ps: `[datetime]'${s.replace(' ', 'T')}'` }),
  decimal: (s) => ({ ps: `[decimal]'${s}'` }),
  single: (s) => ({ ps: `[single]'${s}'` }),
  bytes: (b) => ({ ps: `[byte[]][Convert]::FromBase64String('${b.toString('base64')}')` }),
};
function psValue(v) {
  if (v === null) return '[DBNull]::Value';
  if (typeof v === 'boolean') return v ? '$true' : '$false';
  if (typeof v === 'number') return String(v);
  return typeof v === 'object' ? v.ps : psString(v);
}

/**
 * PowerShell for the 32-bit Windows PowerShell: creates the database with ADOX and fills it through ADO recordsets.
 * Each row goes in with one AddNew(fields, values) call; setting Field.Value column by column trips over PowerShell's
 * COM binder, which keeps the value type of the first assignment.
 */
function accessScript(file) {
  const parts = [
    ['Gear z18', 'C45', 1, ps.decimal('64.00'), 1.25, true, ps.date('2026-09-01 14:30:00'), 'Case hardened, teeth ground.\r\nCheck the backlash after assembly.', ps.bytes(png(32, 32))],
    ['Flange plate', 'S235JR', 2, ps.decimal('38.50'), 2.1, true, ps.date('2026-09-02 08:15:00'), null, null],
    ['Hex bolt M8x30', '8.8 zinc plated', 24, ps.decimal('0.18'), 0.016, true, ps.date('2026-09-02 08:16:00'), 'DIN 933', null],
    ['Hex nut M8', '8 zinc plated', 24, ps.decimal('0.06'), 0.005, false, ps.date('2026-09-02 08:16:30'), null, null],
    ['Shaft seal 30x47x7', 'NBR', 2, ps.decimal('3.90'), 0.012, true, ps.date('2026-09-03 11:00:00'), 'Größe 30 × 47 × 7 mm', null],
    ['Shaft Ø30', '42CrMo4', 1, ps.decimal('96.00'), 3.4, false, ps.date('2026-09-04 16:45:00'), null, null],
  ];
  const projects = [
    ['Gearbox A', 'Example Shipyard Ltd.', ps.date('2026-09-01'), ps.decimal('12500.00')],
    ['Bracket B', 'Sample Inc.', ps.date('2026-10-15'), ps.decimal('980.50')],
    ['Test rig C', 'Example Lab', ps.date('2026-11-30'), null],
  ];
  const measurements = Array.from({ length: 12 }, (_, i) => [
    `{${(0x3f2504e0 + i).toString(16).toUpperCase()}-4F89-41D3-9A0C-0305E82C${(0x3300 + i).toString(16).toUpperCase()}}`,
    1 + (i % 3),
    ps.date(`2026-09-${String(5 + Math.floor(i / 4)).padStart(2, '0')} ${String(8 + (i % 4) * 2).padStart(2, '0')}:00:00`),
    ps.single((30 + ((i * 7) % 5) * 0.001).toFixed(3)),
    i % 4,
    19 + (i % 5),
    i % 5 !== 3,
  ]);
  const rows = (table, fields, list) =>
    list.map((r) => `Add '${table}' @(${fields.map(psString).join(', ')}) @(${r.map(psValue).join(', ')})`).join('\n');
  return `
$ErrorActionPreference = 'Stop'
$path = ${psString(file)}
$cat = New-Object -ComObject ADOX.Catalog
$cat.Create("Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$path;Jet OLEDB:Engine Type=5") | Out-Null
$cn = $cat.ActiveConnection
$cn.Execute('CREATE TABLE parts (item COUNTER CONSTRAINT pk_parts PRIMARY KEY, description TEXT(80) NOT NULL, material TEXT(40), quantity LONG, price CURRENCY, weight_kg DOUBLE, in_stock YESNO, added DATETIME, notes MEMO, picture LONGBINARY)') | Out-Null
$cn.Execute('CREATE TABLE projects (id COUNTER CONSTRAINT pk_projects PRIMARY KEY, name TEXT(60) NOT NULL, customer TEXT(60), start DATETIME, budget DECIMAL(12, 2))') | Out-Null
$cn.Execute('CREATE TABLE measurements (id GUID CONSTRAINT pk_measurements PRIMARY KEY, part LONG, taken DATETIME, diameter_mm SINGLE, tolerance_class BYTE, temperature_c SHORT, passed YESNO)') | Out-Null
function Add($table, [object[]]$fields, [object[]]$values) {
  $rs = New-Object -ComObject ADODB.Recordset
  $rs.Open($table, $cn, 1, 3, 2)
  $rs.AddNew($fields, $values)
  $rs.Update()
  $rs.Close()
}
${rows('parts', ['description', 'material', 'quantity', 'price', 'weight_kg', 'in_stock', 'added', 'notes', 'picture'], parts)}
${rows('projects', ['name', 'customer', 'start', 'budget'], projects)}
${rows('measurements', ['id', 'part', 'taken', 'diameter_mm', 'tolerance_class', 'temperature_c', 'passed'], measurements)}
$cn.Close()
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($cat)
`;
}

function accessDatabase() {
  const powershell = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
  if (process.platform !== 'win32' || !existsSync(powershell)) {
    console.warn('Skipping database/parts.mdb: it needs the 32-bit Jet 4.0 engine of Windows.');
    return null;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'jet-'));
  const file = path.join(dir, 'parts.mdb');
  try {
    // -Command instead of a script file, so no execution policy gets in the way.
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', accessScript(file)], { stdio: ['ignore', 'inherit', 'inherit'] });
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Output -----------------------------------------------------------------------------------------------------

const rows = partsRows();
write('database/parts.parquet', parquet(rows));
// Arrow stores the values uncompressed, so a shorter table keeps the file small.
write('database/parts.arrow', arrowFile(rows.slice(0, 500)));
if (['certs/chain.pem', 'certs/www.example.com.crt', 'certs/expired.cer', 'certs/chain.p7b', 'certs/www.example.com.csr', 'certs/identity.p12'].some(wanted)) {
  await certificates();
}
if (wanted('database/parts.mdb')) {
  const mdb = accessDatabase();
  if (mdb) write('database/parts.mdb', mdb);
}

for (const [rel, size] of written) console.log(`${String(size).padStart(8)}  samples/${rel}`);

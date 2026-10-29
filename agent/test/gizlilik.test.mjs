/**
 * Depo herkese açık: ajan dosyalarında kurulumdan kalma iz olmamalı. Bu test ÖRNEK adresler dışındaki özel
 * ağ / VPN adreslerini, belge aralığı dışındaki MAC adreslerini, tarihli kişisel notları ve gerçek oda adlarını arar.
 * Örneklerde RFC 5737 (192.0.2.x, 198.51.100.x, 203.0.113.x) ve RFC 7042 (00:00:5e:00:53:xx) kullanılır.
 *   node --test agent/test/gizlilik.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BU = fileURLToPath(import.meta.url);
const KOK = resolve(dirname(BU), '..');

function dosyalar(dizin) {
  const out = [];
  for (const ad of readdirSync(dizin)) {
    const yol = join(dizin, ad);
    if (statSync(yol).isDirectory()) { if (ad !== 'node_modules' && ad !== 'fixtures') out.push(...dosyalar(yol)); continue; }
    if (yol !== BU && /\.(mjs|cjs|js|json|py|sh|service|md)$/.test(ad)) out.push(yol);
  }
  return out;
}

const KURALLAR = [
  ['özel ağ adresi (10/8)', /(?<![\d.])10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['özel ağ adresi (172.16/12)', /(?<![\d.])172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['özel ağ adresi (192.168/16)', /(?<![\d.])192\.168\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['VPN / CGNAT adresi (100.64/10)', /(?<![\d.])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['tarihli kişisel not', /kullanıcı[^\n]{0,25}\b\d{1,2}\.\d{1,2}\.20\d\d\b/i],
  ['tarihli ölçüm notu', /\((?:ölçüldü|ölçüm)[^)\n]{0,6}\d{1,2}\.\d{1,2}\.20\d\d/i],
  ['oda adı', /\b(salon|oturma odas[ıi])\b/i],
];
const MAC = /\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi;
const MAC_IZINLI = /^(00[:-]00[:-]5e[:-]00[:-]53|aa[:-]bb[:-]cc[:-]dd[:-]ee|02[:-])/i;

test('ajan dosyalarında kurulum izi yok (özel adres, gerçek MAC, tarihli not, oda adı)', () => {
  const bulgular = [];
  for (const f of dosyalar(KOK)) {
    const metin = readFileSync(f, 'utf8');
    metin.split('\n').forEach((satir, i) => {
      for (const [ad, re] of KURALLAR) if (re.test(satir)) bulgular.push(`${relative(KOK, f)}:${i + 1} ${ad}: ${satir.trim().slice(0, 100)}`);
      for (const m of satir.match(MAC) || []) if (!MAC_IZINLI.test(m)) bulgular.push(`${relative(KOK, f)}:${i + 1} MAC: ${m}`);
    });
  }
  assert.deepEqual(bulgular, []);
});

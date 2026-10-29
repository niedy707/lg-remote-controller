/**
 * Saat dilimi: TV_AJAN_TZ (varsayılan Europe/Istanbul), yaz saati geçişleri, yarım saatlik ofset.
 * Varsayılan dışı bölge alt süreçte sınanır (bölge süreç başında bir kez okunur).
 *   node --test agent/test/saat.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SAAT_DILIMI, yerelAn, ofset, parcalar, saatDk, saatSonu, gunAnahtari, tarihGecerli, saatDilimiCoz } from '../net/saat.mjs';

const NET = resolve(dirname(fileURLToPath(import.meta.url)), '../net');

/** TV_AJAN_TZ ile alt süreçte kod çalıştırır; son satırdaki JSON'u döndürür. */
function bolgede(tz, kod) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', kod], {
    env: { ...process.env, TV_AJAN_TZ: tz, NET_URL: pathToFileURL(NET).href }, encoding: 'utf8', timeout: 20000,
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return { cikti: JSON.parse(r.stdout.trim().split('\n').at(-1)), stderr: r.stderr };
}

test('varsayılan İstanbul: +3 saat, yaz saati yok', () => {
  assert.equal(SAAT_DILIMI, 'Europe/Istanbul');
  assert.equal(ofset(Date.UTC(2026, 0, 15)), 3 * 3600e3);
  assert.equal(ofset(Date.UTC(2026, 6, 15)), 3 * 3600e3);
  assert.equal(yerelAn(2026, 10, 18, 20, 0), Date.UTC(2026, 9, 18, 17, 0));
  assert.equal(gunAnahtari(Date.UTC(2026, 9, 17, 21, 30)), '2026-10-18', 'UTC gece yarısından önce de yerel gün');
  assert.equal(saatDk(Date.UTC(2026, 9, 17, 21, 30)), '00:30');
  assert.equal(parcalar(Date.UTC(2026, 9, 18, 9)).haftaGunu, 7, 'Pazar = 7');
});

test('yaz saati: yaşanmayan saat ileri, iki kez yaşanan saat ilk yaşanışı; ofset Intl\'den', () => {
  const tz = 'Europe/Berlin';
  assert.equal(ofset(Date.UTC(2026, 0, 15), tz), 3600e3);
  assert.equal(ofset(Date.UTC(2026, 6, 15), tz), 2 * 3600e3);
  // 29.03.2026 02:30 yok (02:00 → 03:00): 03:30 CEST = 01:30 UTC
  assert.equal(yerelAn(2026, 3, 29, 2, 30, tz), Date.UTC(2026, 2, 29, 1, 30));
  // 25.10.2026 02:30 iki kez: ilki CEST = 00:30 UTC
  assert.equal(yerelAn(2026, 10, 25, 2, 30, tz), Date.UTC(2026, 9, 25, 0, 30));
  assert.equal(yerelAn(2026, 10, 25, 20, 0, tz), Date.UTC(2026, 9, 25, 19, 0), 'geçişten sonra CET');
});

test('yarım saatlik ofset: saat sınırları yerel saatte', () => {
  const tz = 'Asia/Kolkata';
  const an = Date.UTC(2026, 9, 18, 10, 10);   // 15:40 IST
  assert.equal(saatDk(an, tz), '15:40');
  assert.equal(saatSonu(an, tz), Date.UTC(2026, 9, 18, 10, 30), '16:00 IST');
});

test('takvim denetimi ve bölge adı', () => {
  assert.equal(tarihGecerli(2026, 2, 29), false);
  assert.equal(tarihGecerli(2028, 2, 29), true);
  assert.equal(saatDilimiCoz('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(saatDilimiCoz('Mars/Olympus'), null);
});

test('TV_AJAN_TZ=Europe/Berlin: haftalık görev geçişten sonra da 20:00; izleme günü 25 saat, kesitler tekrarlanmaz', () => {
  const { cikti } = bolgede('Europe/Berlin', `
    const { sonrakiHaftalik } = await import(process.env.NET_URL + '/zamanlayici.mjs');
    const { gunAraligi, IzlemeKaydi, trGun } = await import(process.env.NET_URL + '/izleme.mjs');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // Cumartesi 24.10.2026 21:00 CEST → Pazar 25.10 20:00 (artık CET)
    const haftalik = sonrakiHaftalik('20:00', [7], Date.UTC(2026, 9, 24, 19, 0));
    const a = gunAraligi('2026-10-25', 1);
    const dizin = mkdtempSync(join(tmpdir(), 'iz-'));
    const k = { tv: 'tv1', bas: Date.UTC(2026, 9, 25, 8), bit: Date.UTC(2026, 9, 25, 9), kaynak: 'canli', kanal: null, program: 'X', uygulama: null };
    writeFileSync(join(dizin, trGun(k.bas) + '.jsonl'), JSON.stringify(k) + '\\n');
    const iz = new IzlemeKaydi({ dizin, tvler: [] });
    const ks = await iz.kesitler({ bas: Date.UTC(2026, 9, 20), bit: Date.UTC(2026, 9, 30) });
    rmSync(dizin, { recursive: true, force: true });
    console.log(JSON.stringify({ haftalik, bas: a.bas, bit: a.bit, kesit: ks.length }));
  `);
  assert.equal(cikti.haftalik, Date.UTC(2026, 9, 25, 19, 0), '20:00 CET');
  assert.equal(cikti.bas, Date.UTC(2026, 9, 24, 22, 0), '25.10 00:00 CEST');
  assert.equal(cikti.bit - cikti.bas, 25 * 3600e3, 'kışa dönüş günü 25 saat');
  assert.equal(cikti.kesit, 1, 'aynı gün dosyası iki kez okunmadı');
});

test('geçersiz TV_AJAN_TZ: uyarı yazılır, İstanbul\'a düşülür', () => {
  const { cikti, stderr } = bolgede('Mars/Olympus', `
    const { SAAT_DILIMI } = await import(process.env.NET_URL + '/saat.mjs');
    console.log(JSON.stringify({ tz: SAAT_DILIMI }));
  `);
  assert.equal(cikti.tz, 'Europe/Istanbul');
  assert.match(stderr, /TV_AJAN_TZ geçersiz/);
});

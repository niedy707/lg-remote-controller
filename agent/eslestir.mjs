#!/usr/bin/env node
/**
 * LG TV ile ilk eşleştirme — anahtarı alır ve ajanın anahtar dosyasına yazar.
 *
 *   node agent/eslestir.mjs <tv-ip>            # TV ekranında "izin ver" sorusu çıkar, kumandayla onaylayın
 *   node agent/eslestir.mjs <tv-ip> --dosya /opt/tv-ajan/.lgtv-clients.json
 *   node agent/eslestir.mjs <tv-ip> --duz-ws   # yalnız wss:3001'i olmayan eski modeller: düz ws:3000'e izin ver
 *
 * TV'de "LG Connect Apps" / "Mobil TV Açık" (menüdeki adı modele göre değişir) açık olmalı.
 * Anahtar dosyası { "<ip>": "<anahtar>" } biçimindedir; yalnız sahibi okuyabilir (600). Anahtar ekrana yazılmaz.
 * Argümanlar TV'ye bağlanmadan ÖNCE denetlenir: onaydan sonra yazılamayan anahtar kaybolur (TV istemciyi
 * kaydetmiş olur ama anahtar elde kalmaz). Dosya geçici dosya + rename ile, her durumda 600 olarak yazılır.
 * Bağlantı varsayılan olarak yalnız wss (TLS) üzerinden: düz ws'de anahtar ağda açık metin gider.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LgSsap } from './net/lg-ssap.mjs';

const KOK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KULLANIM = 'Kullanım: node agent/eslestir.mjs <tv-ip> [--dosya <anahtar dosyası>] [--duz-ws]';
const arg = process.argv.slice(2);
const dur = (mesaj) => { console.error(mesaj); process.exit(1); };

const bilinen = new Set(['--dosya', '--duz-ws']);
for (const a of arg) if (a.startsWith('--') && !bilinen.has(a)) dur(`bilinmeyen seçenek: ${a}\n${KULLANIM}`);
const i = arg.indexOf('--dosya');
if (i !== -1 && (!arg[i + 1] || arg[i + 1].startsWith('--'))) dur(`--dosya bir yol ister\n${KULLANIM}`);
const ip = arg.find((a, j) => !a.startsWith('--') && !(i !== -1 && j === i + 1));
const dosya = i !== -1 ? resolve(arg[i + 1]) : (process.env.TV_AJAN_ANAHTARLAR || resolve(KOK, '.lgtv-clients.json'));
const duzIzin = arg.includes('--duz-ws');

if (!ip || !/^[\d.]{7,15}$/.test(ip)) dur(KULLANIM);

let anahtarlar = {};
if (existsSync(dosya)) {
  try { anahtarlar = JSON.parse(readFileSync(dosya, 'utf8')) || {}; } catch (e) { dur(`anahtar dosyası okunamadı (${dosya}): ${e.message}`); }
  if (typeof anahtarlar !== 'object' || Array.isArray(anahtarlar)) dur(`anahtar dosyası { "<ip>": "<anahtar>" } biçiminde değil: ${dosya}`);
}
try { mkdirSync(dirname(dosya), { recursive: true }); } catch (e) { dur(`anahtar dosyasının dizini oluşturulamadı: ${e.message}`); }

/** Atomik yazım, her durumda 600 (var olan 644'lük dosya da). */
function yaz(veri) {
  const tmp = `${dosya}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(veri, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, dosya);
}

const tv = new LgSsap(ip);
try {
  await tv.connect({ timeoutMs: 5000, retries: 1, duzIzin });
  if (tv.url?.startsWith('ws://')) console.log('  ⚠️ düz ws:3000 bağlantısı — anahtar ağda şifresiz gidecek');
  console.log(`${ip}: bağlandı. TV ekranındaki soruyu kumandayla onaylayın (90 sn)…`);
  const anahtar = await tv.register(anahtarlar[ip] || null, { onFallback: () => console.log('  imzasız istemci bildirimiyle yeniden deneniyor…') });
  if (!anahtar) throw new Error('TV anahtar vermedi');
  anahtarlar[ip] = anahtar;
  yaz(anahtarlar);
  console.log(`✓ Eşleşti (${tv.manifest === 'imzasiz' ? 'imzasız bildirim' : 'imzalı bildirim'}). Anahtar yazıldı: ${dosya}`);
} catch (e) {
  console.error(`✗ Eşleşme olmadı: ${e.message}${duzIzin ? '' : '\n  (TV wss:3001 sunmuyorsa — çok eski modeller — --duz-ws ile deneyin; anahtar o zaman şifresiz gider)'}`);
  process.exitCode = 1;
} finally {
  tv.close();
}

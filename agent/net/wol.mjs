/**
 * Wake-on-LAN — kapalı TV'yi ağdan uyandırmak.
 *
 * SSAP'ın "aç" ucu yok: TV kapalıyken ya ağı tamamen kapalıdır (SM8000, ping de yok) ya da
 * bekleme modunda bağlantıyı kabul edip ilk mesajda kapatır (OLED G5). İkisini de uyandıran
 * tek yol sihirli paket. Şart: TV ayarlarında "Mobil TV Açık → Wi-Fi ile aç" (modele göre ad
 * değişir) açık olmalı. İki modelde de (SM8000, OLED G5) çalıştığı görüldü; uyandırma ~2 sn.
 *
 * Gönderim hatası yutulmaz: hiçbir paket çıkamadıysa (ağ yok, yayın izni yok) hata atılır — yoksa uyandırma
 * 40 sn bekleyip suçu yanlışlıkla TV ayarına atardı.
 */

import dgram from 'node:dgram';
import os from 'node:os';

/** 6 × 0xFF + 16 × MAC. */
export function sihirliPaket(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`geçersiz MAC adresi: ${mac}`);
  const m = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => m)]);
}

const sayi = (ip) => ip.split('.').reduce((s, p) => (s * 256) + Number(p), 0) >>> 0;
const metin = (n) => [24, 16, 8, 0].map((k) => (n >>> k) & 255).join('.');

/** Makinenin arayüzleri. systemd'de AF_NETLINK kısıtlıysa okunamaz (atar) — o zaman boş. */
function arayuzleriOku() {
  try { return os.networkInterfaces(); } catch { return {}; }
}

/** TV'nin bulunduğu alt ağın yayın adresi (makinenin arayüzlerinden); bulunamazsa /24 varsayımı. */
export function yayinAdresi(tvIp, arayuzler = arayuzleriOku()) {
  const hedef = sayi(tvIp);
  for (const liste of Object.values(arayuzler || {})) {
    for (const a of liste || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const maske = sayi(a.netmask);
      if (((sayi(a.address) & maske) >>> 0) === ((hedef & maske) >>> 0)) return metin(((sayi(a.address) & maske) | (~maske >>> 0)) >>> 0);
    }
  }
  return tvIp.replace(/\.\d+$/, '.255');
}

/**
 * Paketi alt ağ yayınına ve genel yayına, 9 ve 7 numaralı portlara üçer kez gönderir.
 * Hiçbiri gönderilemezse hata atar (nedenleriyle). `soketFn`/`arayuzler`/`araMs` testler içindir.
 */
export async function wolGonder(mac, tvIp, { soketFn = () => dgram.createSocket('udp4'), arayuzler, araMs = 250 } = {}) {
  const paket = sihirliPaket(mac);
  const hedefler = [...new Set([yayinAdresi(tvIp, arayuzler), '255.255.255.255'])];
  const s = soketFn();
  await new Promise((ok, red) => { s.once('error', red); s.bind(0, ok); });
  s.on('error', () => {});   // gönderim hataları geri çağrıyla sayılır; soket olayı süreci düşürmesin
  s.setBroadcast(true);
  let basarili = 0;
  const hatalar = new Set();
  const gonder = (adres, port) => new Promise((ok) => {
    try {
      s.send(paket, port, adres, (e) => { if (e) hatalar.add(e.code || e.message); else basarili++; ok(); });
    } catch (e) { hatalar.add(e.code || e.message); ok(); }
  });
  try {
    for (let i = 0; i < 3; i++) {
      for (const adres of hedefler) for (const port of [9, 7]) await gonder(adres, port);
      if (araMs) await new Promise((r) => setTimeout(r, araMs));
    }
  } finally {
    try { s.close(); } catch { /* yok say */ }
  }
  if (!basarili) throw new Error(`uyandırma paketi gönderilemedi (${[...hatalar].join(', ') || 'bilinmeyen hata'})`);
  return hedefler;
}

/* Saat dilimi yardımcıları — kumanda, Detail ve Engeller sayfaları ortak kullanır.
   • Bölge geçitten gelir: GET /api/ayar → { saatDilimi } (geçitte KUMANDA_TZ; varsayılan Europe/Istanbul).
     Ajandaki TV_AJAN_TZ ile aynı olmalı: görevler evdeki ajanda o bölgenin duvar saatiyle çalışır.
   • Telefonun kendi saat dilimi kullanılmaz — başka ülkedeyken de "20:00" evdeki 20:00'dir.
   • Gün dizgesi 'YYYY-AA-GG' biçimindedir; takvim aritmetiği (gün ekleme, haftanın günü) bölgeden bağımsızdır,
     "o günün başlangıcı hangi an" sorusu bölgeye göre (yaz saati dahil) çözülür. */
'use strict';
(function () {
  const VARSAYILAN = 'Europe/Istanbul';
  const HAFTA = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let bolge = VARSAYILAN;
  let bicim = null;
  const iki = (n) => String(n).padStart(2, '0');

  /** Bölgeyi değiştirir; geçersiz IANA adıysa eski bölge kalır ve false döner. */
  function kur(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try {
      bicim = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      bolge = tz;
      return true;
    } catch (e) {
      return false;
    }
  }
  kur(VARSAYILAN);

  /** An → bölgedeki duvar saati: { y, ay, g, sa, dk, sn, hg } (hg: haftanın günü, 0 = Pazar). */
  function parca(ms) {
    const p = {};
    for (const x of bicim.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { y: +p.year, ay: +p.month, g: +p.day, sa: +p.hour % 24, dk: +p.minute, sn: +p.second, hg: HAFTA.indexOf(p.weekday) };
  }
  /** Bölgenin o andaki UTC farkı (ms). */
  function ofset(ms) {
    const t = Math.floor(ms / 1000) * 1000;
    const p = parca(t);
    return Date.UTC(p.y, p.ay - 1, p.g, p.sa, p.dk, p.sn) - t;
  }
  /** Bölgedeki duvar saati → an. Yaz saati geçişinde iki tahminle doğru farkı bulur. */
  function yerelAn(y, ay, g, sa = 0, dk = 0) {
    const tahmin = Date.UTC(y, ay - 1, g, sa, dk);
    const o1 = ofset(tahmin);
    let an = tahmin - o1;
    const o2 = ofset(an);
    if (o2 !== o1) an = tahmin - o2;
    return an;
  }
  const ayir = (gun) => String(gun).split('-').map(Number);
  /** An → 'YYYY-AA-GG' (bölgedeki gün). */
  const gun = (ms) => { const p = parca(ms); return `${p.y}-${iki(p.ay)}-${iki(p.g)}`; };
  /** An → 'SS:DD'. */
  const saat = (ms) => { const p = parca(ms); return `${iki(p.sa)}:${iki(p.dk)}`; };
  const saatNo = (ms) => parca(ms).sa;
  /** 'YYYY-AA-GG' + n gün (takvim aritmetiği). */
  const gunEkle = (g, n) => { const [y, m, d] = ayir(g); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  /** Günün haftadaki yeri (0 = Pazar). */
  const haftaGunu = (g) => { const [y, m, d] = ayir(g); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  /** Günün bölgedeki başlangıç anı (00:00). */
  const gunBasi = (g) => { const [y, m, d] = ayir(g); return yerelAn(y, m, d, 0, 0); };
  /** Günü yerel dilde yazar (ay/gün adları Intl'den): tarihYaz('2026-10-18', { day: 'numeric', month: 'long' }). */
  function tarihYaz(g, secenek, yerel) {
    const [y, m, d] = ayir(g);
    return new Intl.DateTimeFormat(yerel || 'tr-TR', { timeZone: 'UTC', ...secenek }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  }

  /** Bölgeyi geçitten okur (girişli sayfalarda). Ulaşılamazsa varsayılan kalır — sayfa yine çalışır. */
  async function yukle() {
    try {
      const r = await fetch('/api/ayar', { cache: 'no-store' });
      if (!r.ok) return bolge;
      const j = await r.json();
      kur(j && j.saatDilimi);
    } catch (e) { /* çevrimdışı ya da eski geçit: varsayılan bölge */ }
    return bolge;
  }

  const Saat = { kur, yukle, bolge: () => bolge, parca, ofset, yerelAn, gun, saat, saatNo, gunEkle, haftaGunu, gunBasi, tarihYaz };
  window.Saat = Saat;
})();

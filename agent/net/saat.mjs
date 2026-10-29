/**
 * Saat dilimi — duvar saati ↔ an (ms) dönüşümleri tek yerde.
 *
 * Ajanın "yerel saati" (zamanlayıcı görevleri, izleme kaydının günleri ve saat dağılımı, ekranda gösterilen
 * saatler) `TV_AJAN_TZ` ortam değişkenindeki IANA bölgesidir (ör. "Europe/Berlin"); verilmezse Europe/Istanbul.
 * Ofset her an için Intl'den okunur, bu yüzden yaz saati uygulanan bölgelerde de doğrudur.
 *
 * Yayın rehberinin kaynakları (digiturk, tvplus) Türkiye'de yayın yapar ve saatlerini İstanbul saatiyle verir:
 * rehber sayfaları ayrıştırılırken KAYNAK_TZ kullanılır, kullanıcıya gösterilen saat ise yerel saattir.
 */

export const VARSAYILAN_TZ = 'Europe/Istanbul';
export const KAYNAK_TZ = 'Europe/Istanbul';

/** Geçerli bir IANA bölge adıysa adın kendisi, değilse null. */
export function saatDilimiCoz(ad) {
  if (!ad || typeof ad !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: ad }); return ad; } catch { return null; }
}

function ortamdan() {
  const env = process.env.TV_AJAN_TZ;
  if (!env) return VARSAYILAN_TZ;
  const c = saatDilimiCoz(env.trim());
  if (c) return c;
  console.error(`[saat] TV_AJAN_TZ geçersiz ("${env}") — ${VARSAYILAN_TZ} kullanılıyor`);
  return VARSAYILAN_TZ;
}

/** Etkin saat dilimi (süreç başında bir kez okunur). */
export const SAAT_DILIMI = ortamdan();

const HAFTA = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const bicimciler = new Map();
function bicimci(tz) {
  let f = bicimciler.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    bicimciler.set(tz, f);
  }
  return f;
}

const iki = (n) => String(n).padStart(2, '0');

/** An → o bölgedeki duvar saati: { y, m (1-12), d, saat, dk, sn, haftaGunu (1 = Pazartesi … 7 = Pazar) }. */
export function parcalar(ms, tz = SAAT_DILIMI) {
  const p = {};
  for (const { type, value } of bicimci(tz).formatToParts(ms)) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, saat: +p.hour % 24, dk: +p.minute, sn: +p.second, haftaGunu: HAFTA[p.weekday] };
}

/** O anda bölgenin UTC'ye göre ofseti (ms; İstanbul için +3 saat). */
export function ofset(ms, tz = SAAT_DILIMI) {
  const p = parcalar(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.saat, p.dk, p.sn) - Math.floor(ms / 1000) * 1000;
}

/**
 * Duvar saati → an. Yaz saatine geçişte yaşanmayan saat (ileri alınan) geçişten sonraki karşılığına,
 * kışa dönüşte iki kez yaşanan saat ilk yaşanışına düşer. Ay/gün taşması Date.UTC gibi kaydırılır —
 * geçersiz tarihi reddetmek çağıranın işi (bkz. `tarihGecerli`).
 */
export function yerelAn(y, m, d, saat = 0, dk = 0, tz = SAAT_DILIMI) {
  const duz = Date.UTC(y, m - 1, d, saat, dk);
  // Geçiş en çok bir gün içinde: bir gün öncesinin ve sonrasının ofseti iki adayı verir.
  const adaylar = [...new Set([duz - ofset(duz - 864e5, tz), duz - ofset(duz + 864e5, tz), duz - ofset(duz, tz)])];
  const gecerli = adaylar.filter((an) => an + ofset(an, tz) === duz).sort((a, b) => a - b);
  if (gecerli.length) return gecerli[0];
  return Math.max(...adaylar);
}

/** YYYY-MM-DD takvimde var mı (31 Şubat yok). */
export function tarihGecerli(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Takvim günü + n gün (yerel takvimde; saat diliminden bağımsız). */
export function gunEkle({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** { y, m, d } → "YYYY-MM-DD". */
export const gunMetni = ({ y, m, d }) => `${y}-${iki(m)}-${iki(d)}`;

/** "YYYY-MM-DD" → { y, m, d } ya da null (biçim ya da takvim geçersizse). */
export function gunCoz(metin) {
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(metin || ''));
  if (!t) return null;
  const g = { y: +t[1], m: +t[2], d: +t[3] };
  return tarihGecerli(g.y, g.m, g.d) ? g : null;
}

/** Anın yerel günü: "YYYY-MM-DD". */
export function gunAnahtari(ms, tz = SAAT_DILIMI) {
  return gunMetni(parcalar(ms, tz));
}

/** Anın yerel saati: "SS:DD". */
export function saatDk(ms, tz = SAAT_DILIMI) {
  const p = parcalar(ms, tz);
  return `${iki(p.saat)}:${iki(p.dk)}`;
}

/** Yerel gün başı (00:00) anı. */
export function gunBasi(g, tz = SAAT_DILIMI) {
  return yerelAn(g.y, g.m, g.d, 0, 0, tz);
}

/** Anı içeren yerel saatin bitişi (bir sonraki SS:00). */
export function saatSonu(ms, tz = SAAT_DILIMI) {
  const p = parcalar(ms, tz);
  return ms - ((p.dk * 60 + p.sn) * 1000) - (((ms % 1000) + 1000) % 1000) + 3600e3;
}

/** İstemciler için: etkin bölge ve şu anki ofseti (dakika). */
export function saatBilgisi(an = Date.now(), tz = SAAT_DILIMI) {
  return { saatDilimi: tz, ofsetDk: Math.round(ofset(an, tz) / 60000) };
}

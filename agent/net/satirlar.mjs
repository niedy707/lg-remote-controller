/**
 * Ekranın ortasındaki uyarı penceresinde gösterilecek satırlar (TV kilidi mesajı, YouTube engel metinleri).
 *
 * Girdi dizi ya da "\n" ile ayrılmış metin olabilir. Satırlar kırpılır; ARADAKİ boş satır korunur (ayırıcı
 * olarak kullanılır), baştaki ve sondaki boş satırlar atılır. En çok 5 satır, satır başına 80 karakter —
 * LG'nin uyarı penceresi daha uzun metni kesiyor. Boş sonuç [] döner: çağıran varsayılana düşer.
 */
export const EN_COK_SATIR = 5;
export const SATIR_EN_UZUN = 80;

export class SatirHata extends Error {
  constructor(mesaj) { super(mesaj); this.kod = 400; }
}

export function satirlariHazirla(m) {
  if (m != null && !Array.isArray(m) && typeof m !== 'string') throw new SatirHata('mesaj metin ya da satır dizisi olmalı');
  if (Array.isArray(m) && m.some((x) => typeof x !== 'string')) throw new SatirHata('satırlar metin olmalı');
  const satirlar = (Array.isArray(m) ? m : String(m ?? '').split('\n')).map((x) => x.trim());
  while (satirlar.length && !satirlar[0]) satirlar.shift();
  while (satirlar.length && !satirlar[satirlar.length - 1]) satirlar.pop();
  if (satirlar.length > EN_COK_SATIR || satirlar.some((x) => x.length > SATIR_EN_UZUN)) {
    throw new SatirHata(`en çok ${EN_COK_SATIR} satır, satır başına ${SATIR_EN_UZUN} karakter`);
  }
  return satirlar;
}

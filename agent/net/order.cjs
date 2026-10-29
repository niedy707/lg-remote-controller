/* eslint-env browser, node */
/**
 * Sıra motoru — "eski sıramı yeni listeye uygula".
 *
 * Ürünün var oluş nedeni bu. TKGS zaten frekansları güncelliyor; çözmediği tek
 * şey kullanıcının kendi sıralaması. Yeniden tarama sonrası kanal listesi
 * karışıyor ve insanlar günlerce kumandayla kanal diziyor.
 *
 * EŞLEŞTİRME ANAHTARI SIRASI (frekans EN SONDA, ve asla tek başına değil):
 *   1. SVCID + TSID + ONID  — DVB'nin gerçek kimliği, en güvenilir
 *   2. Kanal adı (normalize) — yayıncı kimlikleri değiştirdiğinde çalışır
 *   3. V-PID + A-PID + frekans(±2 MHz)
 *   4. Frekans(±2 MHz) + servis tipi — son çare
 *
 * Frekans neden birincil anahtar DEĞİL: Türksat'ın kendi duyurusu 12380/12423
 * derken kendi frekans tablosu aynı transponderları 12379/12422 olarak yazıyor.
 * Tam eşitlikle eşleştiren bir araç bu 1 MHz'lik farkta SESSİZCE başarısız olur.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrderEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const FREQ_TOLERANCE = 2; // MHz
  const RADIO_BIT = 0x4000;
  const MAX_NUMBER = 0x4000 - 1; // 0x4000 biti radyo göstergesi, numara alt 14 bit

  /**
   * Görünen kanal numarası. `majorNumber`'ın 0x4000 biti "bu bir radyo" demektir,
   * numaranın parçası DEĞİLDİR. Maskelemeden karşılaştırınca radyo kanalları
   * 17255 ↔ 871 gibi görünüp "numarası değişmiş" sanılıyor — gerçek veride
   * 213 kanal yanlışlıkla "değişti" sayılmıştı. Numara her zaman sınırda maskelenir.
   */
  const displayNumber = (v) => (Number(v) || 0) & ~RADIO_BIT;

  /** Karşılaştırma için ad normalleştirme: Türkçe karakterler ve süsler atılır. */
  function normName(s) {
    if (!s) return '';
    return String(s)
      .toLocaleUpperCase('tr')
      .replace(/İ/g, 'I').replace(/I/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
      .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
      .replace(/[^A-Z0-9]/g, '');
  }

  const QUALITY = /(UHD|FHD|4K|HD|SD)$/;
  /** Kalite son ekini atar: "KANAL D HD" ve "KANAL D" aynı köke iner. */
  function nameRoot(s) {
    let n = normName(s);
    while (QUALITY.test(n)) n = n.replace(QUALITY, '');
    return n;
  }

  const near = (a, b) =>
    a != null && b != null && Math.abs(Number(a) - Number(b)) <= FREQ_TOLERANCE;

  /**
   * DVB kimliği iki kademelidir — çünkü her TV üç alanı birden vermiyor.
   * Gerçek cihazda ölçüldü: LG SM8000 (webOS 4.5)
   * 609 kanalın hiçbirinde ONID döndürmüyor, ama SVCID ve TSID tam geliyor.
   * Üçlüyü şart koşan bir eşleştirme o TV'de kimlik turunu tamamen atlar ve
   * isim tahminine düşer. Bu yüzden ONID varsa kullanılır, yoksa SVCID+TSID
   * ikilisiyle eşleşilir (aynı transponder içinde SVCID zaten benzersizdir).
   */
  const hasId = (c) => c && c.SVCID != null && c.TSID != null;
  const hasFullId = (c) => hasId(c) && c.ONID != null;
  const idKey = (c) => `${c.SVCID}/${c.TSID}/${c.ONID}`;
  const idKey2 = (c) => `${c.SVCID}/${c.TSID}`;

  /**
   * @param {Array} oldList  eski liste — {name, number, SVCID, TSID, ONID, frequency, videoPid, audioPid}
   * @param {Array} newList  yeni liste — parse edilmiş kanallar (idx alanı olmalı)
   */
  function match(oldList, newListRaw) {
    /**
     * `idx` savunması. Ayrıştırılmış .TLL kanalları bu alanı taşır ama TV'den
     * SSAP ile okunan kayıtlar taşımaz. Eksikse `usedNew` kümesine `undefined`
     * eklenir ve ilk eşleşmeden sonra HER kanal "zaten kullanıldı" sayılır —
     * gerçek veride 609 kanaldan yalnız 1'i eşleşmişti. Eksikse konumdan üretilir.
     */
    const newList = newListRaw.map((c, i) => (c.idx == null ? { ...c, idx: i } : c));

    const usedNew = new Set();
    const usedOld = new Set();
    const matched = [];

    const take = (oi, nc, method) => {
      usedOld.add(oi);
      usedNew.add(nc.idx);
      matched.push({
        oldIdx: oi,
        idx: nc.idx,
        method,
        oldNumber: displayNumber(oldList[oi].number),
        oldName: oldList[oi].name,
        newName: nc.name,
      });
    };

    // ── 1a. tur: tam DVB kimliği (SVCID + TSID + ONID)
    const byId = new Map();
    newList.forEach((c) => {
      if (!hasFullId(c)) return;
      const k = idKey(c);
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(c);
    });
    oldList.forEach((o, oi) => {
      if (!hasFullId(o)) return;
      const cands = byId.get(idKey(o));
      const c = cands && cands.find((x) => !usedNew.has(x.idx));
      if (c) take(oi, c, 'id');
    });

    // ── 1b. tur: ONID'siz kimlik (SVCID + TSID) — webOS 4.5 ONID vermiyor
    const byId2 = new Map();
    newList.forEach((c) => {
      if (usedNew.has(c.idx) || !hasId(c)) return;
      const k = idKey2(c);
      if (!byId2.has(k)) byId2.set(k, []);
      byId2.get(k).push(c);
    });
    oldList.forEach((o, oi) => {
      if (usedOld.has(oi) || !hasId(o)) return;
      const cands = byId2.get(idKey2(o));
      const c = cands && cands.find((x) => !usedNew.has(x.idx));
      if (c) take(oi, c, 'id2');
    });

    // ── 1c. tur: SVCID + frekans(±2) — TSID/ONID değişmiş kayıtlar için
    // TV bir transponderin kayıtlarını canlı yayından yenileyince TSID ve ONID
    // değişebiliyor (gerçek cihazda ölçüldü: 12034 MHz'de TSID 30→3, ONID 0→66);
    // kimlik turları o kanalı kaçırır ve ada düşer. Ad ise güvenilmez: aynı kanal
    // birden çok frekansta olabiliyor ("CNN TÜRK HD" iki kez). Servis numarası
    // bir transponder içinde benzersizdir; frekansla birlikte kanalı tek başına
    // belirler. Yalnız TEK aday varsa alınır.
    oldList.forEach((o, oi) => {
      if (usedOld.has(oi) || o.SVCID == null || o.frequency == null) return;
      const cands = newList.filter(
        (x) => !usedNew.has(x.idx) && x.SVCID === o.SVCID && x.frequency != null && near(o.frequency, x.frequency)
      );
      if (cands.length === 1) take(oi, cands[0], 'svc-freq');
    });

    // ── 2. tur: normalize edilmiş ad (birebir)
    const byName = new Map();
    newList.forEach((c) => {
      if (usedNew.has(c.idx)) return;
      const k = normName(c.name);
      if (!k) return;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c);
    });
    oldList.forEach((o, oi) => {
      if (usedOld.has(oi)) return;
      const cands = byName.get(normName(o.name));
      const c = cands && cands.find((x) => !usedNew.has(x.idx));
      if (c) take(oi, c, 'name');
    });

    // ── 3. tur: PID + frekans(±2)
    oldList.forEach((o, oi) => {
      if (usedOld.has(oi)) return;
      if (o.videoPid == null && o.audioPid == null) return;
      const c = newList.find(
        (x) =>
          !usedNew.has(x.idx) &&
          x.videoPid != null &&
          x.videoPid === o.videoPid &&
          x.audioPid === o.audioPid &&
          (o.frequency == null || x.frequency == null || near(o.frequency, x.frequency))
      );
      if (c) take(oi, c, 'pid');
    });

    // ── 4. tur: frekans(±2) + servis tipi — son çare, yalnız tek aday varsa
    oldList.forEach((o, oi) => {
      if (usedOld.has(oi) || o.frequency == null) return;
      const cands = newList.filter(
        (x) =>
          !usedNew.has(x.idx) &&
          near(o.frequency, x.frequency) &&
          (o.serviceType == null || x.serviceType == null || o.serviceType === x.serviceType)
      );
      if (cands.length === 1) take(oi, cands[0], 'freq');
    });

    const onlyOld = oldList.map((o, i) => ({ ...o, oldIdx: i })).filter((_, i) => !usedOld.has(i));
    const onlyNew = newList.filter((c) => !usedNew.has(c.idx));

    /**
     * SD→HD önerileri. Türksat geçişinde Star TV, Kanal D, Show, NTV, CNN Türk
     * gibi kanallar SD yayını bıraktı; kullanıcı "kanalım kayboldu" diyor.
     * Bunlar OTOMATİK eşleştirilmez — yanlış eşleşme sessiz veri bozulmasıdır.
     * Kullanıcıya öneri olarak sunulur, onay ondan gelir.
     */
    const suggestions = [];
    for (const o of onlyOld) {
      const root = nameRoot(o.name);
      if (!root) continue;
      const cands = onlyNew.filter((c) => nameRoot(c.name) === root);
      for (const c of cands) {
        suggestions.push({
          reason: 'sd-hd',
          oldIdx: o.oldIdx,
          idx: c.idx,
          oldName: o.name,
          newName: c.name,
          oldNumber: displayNumber(o.number),
        });
      }
    }

    return { matched, onlyOld, onlyNew, suggestions };
  }

  /**
   * Eşleşmelerden çakışmasız bir numara planı üretir.
   * Eşleşen kanallar eski numaralarını almaya çalışır; çakışma olursa ilk gelen
   * kazanır, diğerleri en küçük boş numaraya kayar. Eşleşmeyen (yeni gelen)
   * kanallar en sona eklenir — silinmez, gizlenmez, sadece sıralanır.
   */
  function buildPlan(matchResult, newList, opts = {}) {
    const target = new Map();
    for (const m of matchResult.matched) target.set(m.idx, m.oldNumber);
    for (const s of opts.acceptedSuggestions || []) target.set(s.idx, s.oldNumber);

    const entries = newList.map((c) => ({
      idx: c.idx,
      target: target.has(c.idx) ? Number(target.get(c.idx)) : null,
      current: displayNumber(c.number),
      isNew: !target.has(c.idx),
    }));

    entries.sort((a, b) => {
      const at = a.target == null ? Infinity : a.target;
      const bt = b.target == null ? Infinity : b.target;
      if (at !== bt) return at - bt;
      return a.current - b.current || a.idx - b.idx;
    });

    const used = new Set();
    let cursor = 1;
    const nextFree = () => {
      while (used.has(cursor)) cursor++;
      return cursor;
    };

    const plan = [];
    for (const e of entries) {
      let n = e.target;
      if (n == null || !Number.isFinite(n) || n < 1 || n > MAX_NUMBER || used.has(n)) {
        n = nextFree();
      }
      if (n > MAX_NUMBER) throw new Error('Numara alanı taştı (>16383).');
      used.add(n);
      plan.push({ idx: e.idx, newNumber: n, wasNew: e.isNew, requested: e.target });
    }
    plan.sort((a, b) => a.newNumber - b.newNumber);
    return plan;
  }

  /** Eski listeyi taşınabilir "sıra tarifi" olarak dışa aktarır. */
  function toRecipe(channels) {
    return {
      tip: 'scm-editor-sira-tarifi',
      surum: 1,
      olusturma: new Date().toISOString(),
      kanallar: channels.map((c) => ({
        name: c.name,
        number: displayNumber(c.number),
        isRadio: !!c.isRadio,
        SVCID: c.SVCID ?? null,
        TSID: c.TSID ?? null,
        ONID: c.ONID ?? null,
        frequency: c.frequency ?? null,
        videoPid: c.videoPid ?? null,
        audioPid: c.audioPid ?? null,
        serviceType: c.serviceType ?? null,
      })),
    };
  }

  /** TV'den SSAP ile okunan JSON'u da aynı sıra tarifi biçimine çevirir. */
  function fromTvDump(dump) {
    const rows = dump.kanallar || [];
    return rows.map((c) => ({
      name: c.name,
      number: c.number ?? c.majorNumber,
      SVCID: c.SVCID ?? null,
      TSID: c.TSID ?? null,
      ONID: c.ONID ?? null,
      frequency: c.frequency ?? null,
      videoPid: c.videoPid ?? null,
      audioPid: c.audioPid ?? null,
      serviceType: null,
    }));
  }

  return { match, buildPlan, toRecipe, fromTvDump, normName, nameRoot, displayNumber, FREQ_TOLERANCE, MAX_NUMBER, RADIO_BIT };
});

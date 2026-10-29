/* eslint-env browser, node */
/**
 * Taşıma planlayıcı — "istenen sıra"yı TV'nin kendi Taşı işlemine çevirir.
 *
 * TV'nin Taşı işlemi (gerçek cihazda ölçüldü: OLED G5, webOS 26):
 * bir kanal hedef konuma YERLEŞİR, aradaki kanallar birer sıra kayar (takas
 * değil, araya girme). Yani her taşıma "listeden çıkar, şu konuma sok"tur.
 *
 * Taşıma başına ~10 saniye sürdüğü için plan EN AZ taşımayla kurulur: yerinde
 * kalabilecek en büyük kanal kümesi (uzun artan altdizi) hiç oynatılmaz,
 * yalnız geri kalanlar taşınır. Tek bir kanalı 50. sıradan 3. sıraya almak
 * 47 değil 1 taşımadır.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MovePlan = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** Uzun artan altdizinin `seq` içindeki konumları. O(n log n). */
  function lisIndices(seq) {
    const tails = []; // tails[k]: k+1 uzunluklu artan altdizinin en küçük son elemanının konumu
    const prev = new Array(seq.length).fill(-1);
    for (let i = 0; i < seq.length; i++) {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (seq[tails[mid]] < seq[i]) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[i] = tails[lo - 1];
      tails[lo] = i;
    }
    const out = [];
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(i);
    return out.reverse();
  }

  /** TV'nin Taşı işleminin modeli: `id`, `slot` konumuna (0 tabanlı) yerleşir. */
  function applyMove(order, id, slot) {
    const from = order.indexOf(id);
    if (from < 0) throw new Error('kanal listede yok: ' + id);
    const out = order.slice();
    out.splice(from, 1);
    out.splice(slot, 0, id);
    return out;
  }

  /**
   * @param {string[]} current  kanal kimlikleri, TV'deki sırayla
   * @param {string[]} head     istenen baş sıra; listede olmayan kanallar bugünkü
   *                            göreli sırasını koruyarak arkadan gelir
   * @returns {{target: string[], moves: Array<{id: string, from: number, to: number}>}}
   *          `from`/`to` taşımanın yapıldığı andaki 0 tabanlı konumlardır.
   */
  function plan(current, head) {
    const inList = new Set(current);
    const inHead = new Set();
    for (const id of head) {
      if (!inList.has(id)) throw new Error('istenen sıradaki kanal TV listesinde yok: ' + id);
      if (inHead.has(id)) throw new Error('istenen sırada aynı kanal iki kez var: ' + id);
      inHead.add(id);
    }

    const target = [...head, ...current.filter((id) => !inHead.has(id))];
    const pos = new Map(target.map((id, i) => [id, i]));
    const settled = new Set(lisIndices(current.map((id) => pos.get(id))).map((i) => current[i]));

    let order = current.slice();
    const moves = [];
    for (const id of target) {
      if (settled.has(id)) continue;
      // Hedefte bu kanaldan önce gelen, yeri kesinleşmiş en yakın kanalın hemen arkasına.
      const without = order.filter((x) => x !== id);
      let to = 0;
      for (let k = pos.get(id) - 1; k >= 0; k--) {
        if (settled.has(target[k])) { to = without.indexOf(target[k]) + 1; break; }
      }
      const from = order.indexOf(id);
      settled.add(id);
      if (from === to) continue;
      moves.push({ id, from, to });
      order = applyMove(order, id, to);
    }
    return { target, moves };
  }

  return { lisIndices, applyMove, plan };
});

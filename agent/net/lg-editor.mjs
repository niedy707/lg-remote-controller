/**
 * LG webOS — ağdan kanal sıralama sürücüsü (kapalı döngü).
 *
 * SSAP'ta kanal listesini yazan uç yok (webOS 25 ve 26'da ölçüldü: aday yazma uçlarının
 * hepsi 404). Bu sürücü TV'nin KENDİ Kanal Yöneticisini kumanda kanalından sürer ve her
 * adımı ağdan okuyarak doğrular:
 *
 *   1. kanal seçilince TV o kanala geçer → `getCurrentChannel` ile DOĞRU kanalın
 *      seçildiği taşımadan ÖNCE teyit edilir (yanlış kanal asla taşınmaz),
 *   2. taşımadan sonra `getChannelList` okunur ve beklenen sırayla karşılaştırılır,
 *   3. beklenmeyen bir sonuçta durulmaz, gerçek durumdan YENİDEN planlanır;
 *      aynı adım iki kez tutmazsa sürücü durur ve ekran görüntüsü bırakır.
 *
 * Tuş tarifi (gerçek cihazda çıkarıldı: OLED G5, webOS 26; başka modellerde doğrulanmadı):
 *   Kanal Yöneticisi → OK (Tüm Kanalları Düzenle) → SAĞ (listeye geç)
 *   <kanal no> OK        o satıra atla
 *   OK                   kanalı seç (TV o kanala geçer)
 *   SARI                 Taşı
 *   <hedef no> OK        yüzen satır hedefin konumuna gider
 *   YUKARI AŞAĞI         yüzen satırı yeniden etkinleştir (bazen odağı kaybediyor)
 *   OK                   bırak — değişiklik anında kalıcıdır
 */

import { createRequire } from 'node:module';
import { LgInput } from './lg-input.mjs';
import { captureScreen } from './lg-screen.mjs';

const MovePlan = createRequire(import.meta.url)('./moveplan.cjs');

const APP_EDIT = 'com.webos.app.channeledit';
const APP_LIVE = 'com.webos.app.livetv';

/** Bekleme süreleri (ms). TV arayüzü tuşu aldıktan sonra çizimini bitirsin diye. */
export const WAIT = { key: 450, popup: 1300, launch: 3500, screen: 2500, drop: 1800, tune: 7000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kanal kimliği: fiziksel transponder numarası + servis numarası (SVCID).
 *
 * İki şeye dayanmak zorunda:
 *  - TAŞIMA: `channelId` kanal numarasını içerdiği için taşıyınca değişir.
 *  - TV'NİN KENDİ KAYIT YENİLEMESİ: TV bir kanala geçince o transponderin
 *    kayıtlarını canlı yayından yeniler; TSID/ONID değişir, adlar güncellenir,
 *    servis eklenip çıkar. Gerçek cihazda ölçüldü: CNN Türk
 *    seçilince 12034 MHz'deki 38 kaydın TSID'i 30→3, ONID'i 0→66 oldu ve tam
 *    kimliğe (`signalChannelId`) dayanan sürücü "kanal listede yok" deyip
 *    durdu. Listedeki 663 kaydın 407'si aynı bayat durumdaydı.
 * Transponder numarası ve SVCID bu yenilemede değişmiyor; ikili güncel listede
 * benzersiz (0 tekrar).
 */
const svcid = (c) => (c.SVCID != null ? Number(c.SVCID) : Number(String(c.signalChannelId || '').split('_')[1]));
export const channelKey = (c) => `${c.physicalNumber}_${svcid(c)}`;

/** Kanal Yöneticisi'nin "Uydu DTV" listesi, ekrandaki sırayla. */
export async function readTvList(tv) {
  const r = await tv.request('ssap://tv/getChannelList');
  return (r.channelList || [])
    .filter((c) => c.channelMode === 'Satellite' && !c.Radio)
    .map((c) => ({
      key: channelKey(c),
      channelId: c.channelId,
      number: Number(c.channelNumber),
      minor: Number(c.minorNumber) || 0,
      name: c.channelName,
      raw: c,
    }))
    .sort((a, b) => a.number - b.number || a.minor - b.minor);
}

async function waitFor(fn, timeoutMs, stepMs = 500) {
  const bitis = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= bitis) return false;
    await sleep(stepMs);
  }
}

export class LgEditor {
  /** @param {LgSsap} tv eşleşmiş oturum */
  constructor(tv, { log = () => {} } = {}) {
    this.tv = tv;
    this.log = log;
    this.input = null;
    this.orig = null;
  }

  async foreground() {
    return (await this.tv.request('ssap://com.webos.applicationManager/getForegroundAppInfo')).appId;
  }

  async currentKey() {
    try { return channelKey(await this.tv.request('ssap://tv/getCurrentChannel')); } catch { return null; }
  }

  async key(name, wait = WAIT.key) { await this.input.button(name, { settleMs: wait }); }

  async digits(n) { for (const d of String(n)) await this.key(d); }

  /**
   * Düzenleyiciyi sıfırdan açar ve odağı kanal listesine getirir.
   * @param {string} firstKey  ilk taşınacak kanal
   * @param {Array} list       güncel TV listesi (`readTvList`)
   *
   * Seçim doğrulaması "TV şimdi bu kanala geçti" gözlemine dayanır; TV zaten o
   * kanaldaysa gözlem anlamsızlaşır. Bu yüzden TV o an taşınacak kanaldaysa
   * (ya da bir uydu TV kanalında değilse) önce başka bir kanala geçilir.
   */
  async open(firstKey, list) {
    if (!this.orig) this.orig = { app: await this.foreground(), key: await this.currentKey() };
    const simdi = await this.currentKey();
    if (simdi === firstKey || !list.some((c) => c.key === simdi)) {
      const park = list.find((c) => c.key !== firstKey);
      await this.tv.request('ssap://tv/openChannel', { channelId: park.channelId });
      await waitFor(async () => (await this.currentKey()) === park.key, WAIT.tune);
    }
    // Yarım kalmış bir düzenleme ekranından devam etmesin: önce kapat.
    try { await this.tv.request('ssap://system.launcher/close', { id: APP_EDIT }); } catch { /* açık değildi */ }
    await sleep(800);
    await this.tv.request('ssap://system.launcher/launch', { id: APP_EDIT });
    if (!(await waitFor(async () => (await this.foreground()) === APP_EDIT, 10000))) {
      throw new Error('Kanal Yöneticisi açılmadı.');
    }
    await sleep(WAIT.launch);
    if (this.input) this.input.close();
    this.input = await LgInput.open(this.tv);
    await this.key('ENTER', WAIT.screen); // Tüm Kanalları Düzenle
    await this.key('RIGHT', 900);         // kategori sütunundan listeye
  }

  /**
   * Bir kanalı hedef numaranın konumuna taşır. Sonucu DOĞRULAMAZ — çağıran
   * `readTvList` ile doğrular. Yanlış kanal seçildiyse taşımadan önce hata fırlatır.
   */
  async move(ch, targetNumber, { enUste = false } = {}) {
    if ((await this.foreground()) !== APP_EDIT) throw new Error('Kanal Yöneticisi ön planda değil.');
    if ((await this.currentKey()) === ch.key) throw new Error('TV zaten taşınacak kanalda; seçim doğrulanamaz.');

    await this.digits(ch.number);
    await sleep(WAIT.popup);
    await this.key('ENTER', WAIT.popup); // açılan listede tam eşleşen ilk satır → o kanala atla

    await this.key('ENTER', 600);        // seç
    if (!(await waitFor(async () => (await this.currentKey()) === ch.key, WAIT.tune))) {
      throw new Error(`seçim doğrulanamadı: TV "${ch.name}" kanalına geçmedi — taşıma yapılmadı.`);
    }

    await this.key('YELLOW', WAIT.popup); // Taşı
    await this.digits(targetNumber);
    await sleep(WAIT.popup);
    await this.key('ENTER', WAIT.popup);  // hedefi seç
    // Uzun bir atlamadan sonra yüzen satır bazen odağı kaybediyor: hedef satır gri
    // vurgulanıyor, yüzen satır görünmüyor ve OK hiçbir şey yapmıyor (ölçüldü:
    // 66 → 27 taşımasında; aynı oturumda 7 taşıma sorunsuzdu). Bir ok tuşu
    // yüzen satırı yeniden etkinleştiriyor ama bir sıra da kaydırıyor; ters yöndeki
    // ikinci tuş onu hedefe geri getiriyor. En üst sırada YUKARI işlemez, orada
    // sıra tersine çevrilir.
    const [ilk, ikinci] = enUste ? ['DOWN', 'UP'] : ['UP', 'DOWN'];
    await this.key(ilk, 700);
    await this.key(ikinci, 700);
    await this.key('ENTER', WAIT.drop);   // bırak
  }

  /** Düzenleyiciden çıkar ve TV'yi başladığı yere döndürür. */
  async close() {
    try {
      if (this.input) { await this.key('EXIT', 1500); this.input.close(); this.input = null; }
      if (!this.orig) return;
      if (this.orig.app === APP_LIVE && this.orig.key) {
        // Kanalın `channelId`'si taşıma sırasında değişmiş olabilir; güncel listeden bulunur.
        const tum = (await this.tv.request('ssap://tv/getChannelList')).channelList || [];
        const ham = tum.find((c) => channelKey(c) === this.orig.key);
        if (ham) await this.tv.request('ssap://tv/openChannel', { channelId: ham.channelId });
      } else if (this.orig.app && this.orig.app !== APP_EDIT) {
        await this.tv.request('ssap://system.launcher/launch', { id: this.orig.app });
      }
    } catch (e) {
      this.log(`uyarı: TV eski hâline döndürülemedi (${e.message || e})`);
    }
  }
}

const ayni = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Taşıma beklenen sırayı verdi mi?
 * TV çalışma sırasında araya kanal ekleyip çıkarabildiği için (kayıt yenilemesi)
 * tam eşitlik aranmaz: yalnız iki listede de bulunan kanalların sırası
 * karşılaştırılır. Taşınan kanalın kendisi listede olmak zorundadır.
 */
function siraTuttu(sonra, beklenen, tasinan) {
  if (!sonra.includes(tasinan)) return false;
  const s = new Set(sonra);
  const b = new Set(beklenen);
  return ayni(sonra.filter((k) => b.has(k)), beklenen.filter((k) => s.has(k)));
}

/** Aynı kanal üst üste kaç kez tutmazsa durulur / toplam kaç başarısız adıma izin var. */
const KANAL_BASINA_DENEME = 3;
const TOPLAM_HATA_SINIRI = 40;

/**
 * İstenen baş sırayı TV'ye uygular.
 * @param {LgSsap} tv
 * @param {string[]} headKeys  `channelKey` değerleri, istenen sırayla
 * @param {object} o  { dryRun, log, maxMoves, onShot(buf, ad), durdur() → true ise dur, ilerleme({yapilan, kalan}) }
 * @returns {{plan: Array, yapilan: number, hatali: number, sure: number, eksik: string[]}}
 */
export async function applyHead(tv, headKeys, { dryRun = false, log = () => {}, maxMoves = 300, onShot = null, durdur = () => false, ilerleme = () => {} } = {}) {
  let list = await readTvList(tv);

  // TV listeden bir kanalı çıkarmış olabilir; plan yalnız var olanlarla kurulur.
  const eksik = new Set();
  const planla = (ls) => {
    const var_ = new Set(ls.map((c) => c.key));
    for (const k of headKeys) if (!var_.has(k) && !eksik.has(k)) { eksik.add(k); log(`uyarı: istenen sıradaki bir kanal artık TV listesinde yok (${k}); atlanıyor`); }
    return MovePlan.plan(ls.map((c) => c.key), headKeys.filter((k) => var_.has(k)));
  };

  const ilk = planla(list);
  const plan = [];
  {
    // Kuru çalıştırma: planı benzetimle açıkla (numaralar o anki listeden).
    let ls = list.slice();
    for (const m of ilk.moves) {
      plan.push({ kanal: ls[m.from].name, numara: ls[m.from].number, hedef: ls[m.to].number });
      const sira = MovePlan.applyMove(ls.map((c) => c.key), m.id, m.to);
      const byKey = new Map(ls.map((c) => [c.key, c]));
      const numaralar = ls.map((c) => c.number);
      ls = sira.map((k, i) => ({ ...byKey.get(k), number: numaralar[i] }));
    }
  }
  if (dryRun || !ilk.moves.length) return { plan, yapilan: 0, hatali: 0, sure: 0, eksik: [...eksik] };

  const t0 = Date.now();
  const ed = new LgEditor(tv, { log });
  const deneme = new Map(); // kanal → üst üste başarısız deneme
  let yapilan = 0;
  let hatali = 0;
  try {
    await ed.open(ilk.moves[0].id, list);
    for (;;) {
      const sira = list.map((c) => c.key);
      const { moves } = planla(list);
      ilerleme({ yapilan, kalan: moves.length });
      if (!moves.length) break;
      if (durdur()) throw new Error(`kullanıcı durdurdu (${yapilan} taşıma yapıldı)`);
      if (yapilan >= maxMoves) throw new Error(`taşıma sınırı aşıldı (${maxMoves}).`);
      const m = moves[0];
      const ch = list[m.from];
      const hedefNo = list[m.to].number;
      const beklenen = MovePlan.applyMove(sira, m.id, m.to);
      log(`taşı: ${ch.number} ${ch.name} → ${hedefNo}  (kalan ${moves.length})`);

      let adimHatasi = null;
      try { await ed.move(ch, hedefNo, { enUste: m.to === 0 }); } catch (e) { adimHatasi = e; }

      let sonra = await readTvList(tv);
      for (let i = 0; i < 3 && !adimHatasi && !siraTuttu(sonra.map((c) => c.key), beklenen, ch.key); i++) {
        await sleep(1500);
        sonra = await readTvList(tv);
      }
      if (siraTuttu(sonra.map((c) => c.key), beklenen, ch.key)) {
        const yeni = sonra.find((c) => c.key === ch.key);
        log(`  ✓ doğrulandı: ${yeni.name} artık ${yeni.number}`);
        yapilan++;
        deneme.delete(ch.key);
        list = sonra;
        continue;
      }

      // Tutmadı. En sık neden: TV az önce geçtiği transponderin kayıtlarını yeniledi
      // ve düzenleyici ekranı taşımanın ortasında sıfırlandı. Körlemesine devam
      // edilmez: liste yeniden okunur, gerçek durumdan plan kurulur, arayüz baştan açılır.
      hatali++;
      const kac = (deneme.get(ch.key) || 0) + 1;
      deneme.set(ch.key, kac);
      const fark = sonra.length - list.length;
      log(`  ✗ ${adimHatasi ? adimHatasi.message : 'liste beklenen sıraya gelmedi'}` +
        `${fark ? ` — TV listesi ${list.length} → ${sonra.length} kanal oldu (kayıt yenilemesi)` : ''} · deneme ${kac}/${KANAL_BASINA_DENEME}`);
      if (onShot) { try { onShot(await captureScreen(tv), `hata-${Date.now()}.jpg`); } catch { /* tanı amaçlı */ } }
      if (kac >= KANAL_BASINA_DENEME) throw new Error(`"${ch.name}" ${kac} denemede de taşınamadı; duruldu.`);
      if (hatali >= TOPLAM_HATA_SINIRI) throw new Error(`çok fazla başarısız adım (${hatali}); duruldu.`);

      await sleep(3000); // yenileme sürüyorsa otursun
      list = await readTvList(tv);
      const sonraki = planla(list).moves[0];
      if (!sonraki) break;
      await ed.open(sonraki.id, list); // arayüzü bilinen duruma sıfırla
    }
  } finally {
    await ed.close();
  }
  return { plan, yapilan, hatali, sure: Math.round((Date.now() - t0) / 1000), eksik: [...eksik] };
}

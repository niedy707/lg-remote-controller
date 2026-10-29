#!/usr/bin/env python3
"""Apple TV yardımcısı — tv-ajan'ın alt süreci (pyatv, Companion protokolü).

NEDEN AYRI SÜREÇ: Apple TV'nin ağ protokolünün tek olgun uygulaması pyatv (Python). Ajan Node; pyatv'yi
her komutta `atvremote` ile çalıştırmak Pi 3'te ~3,5 sn sürüyor (ölçüldü). Bu süreç bağlantıyı
açık tutar: ajan satır başına bir JSON istek yazar, yardımcı satır başına bir JSON yanıt döner.

İstek:  {"no": 7, "cihaz": {"ip": "...", "id": "..."}, "is": "uygulama", "uygulama": "com.netflix.Netflix"}
        is: "uygulama" (uygulama) · "tus" (tus) · "metin" (metin) · "uygulamalar" · "oynayan" · "uyku" · "uygulama-kapat" · "sistem"
Yanıt:  {"no": 7, "ok": true, ...}  ya da  {"no": 7, "ok": false, "hata": "..."}

Kimlik bilgileri pyatv'nin dosya deposunda (argv[1]); eşleştirme bir kez `atvremote ... pair` ile yapılır.
Bağlantı 5 dk boşta kalınca kapanır: Apple TV'yi gereksiz uyanık tutmasın, aynı cihaza bağlı başka
istemcilerle (tvOS 26/27'de kopma raporları) daha az çakışsın.
"""
import asyncio
import json
import sys

import pyatv
from pyatv.const import InputAction, Protocol
from pyatv.storage.file_storage import FileStorage

# Ajanın gönderebileceği tuşlar (pyatv RemoteControl yöntemleri) — başka ad çağrılamaz.
TUSLAR = {
    "up", "down", "left", "right", "select", "menu", "home", "top_menu",
    "play", "pause", "play_pause", "skip_forward", "skip_backward", "next", "previous",
}
BOSTA_KAPAT_SN = 300
# "Ne oynuyor" sorusunda bağlantı en çok bu kadar yaşlı olabilir: uzun açık kalan MRP bağlantısı DONUYOR — YouTube
# oynarken eski "duraklatıldı" durumunu göstermeye devam etti ve engel devreye girmedi (yeni bağlantı doğruyu
# verdi; ölçüldü). Engel bekçisi 4 sn'de bir sorduğu için bağlantı hiç boşta kalmıyor, kendiliğinden yenilenmiyordu.
OYNAYAN_TAZE_SN = 60


class Hata(Exception):
    pass


class Dinleyici:
    """Bağlantı koparsa kaydı sil: sonraki komut yeniden bağlansın."""

    def __init__(self, yardimci, anahtar):
        self.yardimci, self.anahtar = yardimci, anahtar

    def connection_lost(self, _exc):
        self.yardimci.baglantilar.pop(self.anahtar, None)

    def connection_closed(self):
        self.yardimci.baglantilar.pop(self.anahtar, None)


class Yardimci:
    def __init__(self, loop, depo_yolu):
        self.loop = loop
        self.depo = FileStorage(depo_yolu, loop)
        self.depo_yuklendi = False
        self.baglantilar = {}  # id -> {"atv": AppleTV, "son": zaman}
        self.kilitler = {}

    async def baglan(self, cihaz, taze_sn=None):
        anahtar = str(cihaz.get("id") or "")
        ip = str(cihaz.get("ip") or "")
        if not anahtar or not ip:
            raise Hata("Apple TV kaydı eksik (ip, id)")
        kilit = self.kilitler.setdefault(anahtar, asyncio.Lock())
        async with kilit:
            b = self.baglantilar.get(anahtar)
            if b and taze_sn is not None and self.loop.time() - b["acildi"] > taze_sn:
                self.birak(anahtar)   # eskidi: kapat, aşağıda yeniden bağlan
                b = None
            if b:
                b["son"] = self.loop.time()
                return b["atv"]
            if not self.depo_yuklendi:
                await self.depo.load()
                self.depo_yuklendi = True
            bulunan = await pyatv.scan(self.loop, identifier=anahtar, hosts=[ip], timeout=5, storage=self.depo)
            if not bulunan:
                raise Hata("Apple TV bulunamadı (kapalı ya da ağda değil)")
            conf = bulunan[0]
            companion = conf.get_service(Protocol.Companion)
            if not companion or not companion.credentials:
                raise Hata("Apple TV eşleştirilmemiş (Companion)")
            atv = await pyatv.connect(conf, self.loop, storage=self.depo)
            atv.listener = Dinleyici(self, anahtar)
            self.baglantilar[anahtar] = {"atv": atv, "son": self.loop.time(), "acildi": self.loop.time()}
            return atv

    def birak(self, anahtar):
        b = self.baglantilar.pop(anahtar, None)
        if b:
            try:
                b["atv"].close()
            except Exception:  # noqa: BLE001 — kapanırken hata önemsiz
                pass

    async def isle(self, istek):
        cihaz = istek.get("cihaz") or {}
        is_ = istek.get("is")
        atv = await self.baglan(cihaz, taze_sn=OYNAYAN_TAZE_SN if is_ == "oynayan" else None)
        if is_ == "uygulama":
            uyg = str(istek.get("uygulama") or "")
            if not uyg or len(uyg) > 100:
                raise Hata("uygulama kimliği gerekli")
            await atv.apps.launch_app(uyg)
            return {}
        if is_ == "tus":
            tus = str(istek.get("tus") or "")
            if tus not in TUSLAR:
                raise Hata(f"izinli olmayan tuş: {tus}")
            await getattr(atv.remote_control, tus)()
            return {}
        if is_ == "metin":
            metin = str(istek.get("metin") or "")
            if len(metin) > 100:
                raise Hata("metin en çok 100 karakter")
            await atv.keyboard.text_set(metin)
            return {}
        if is_ == "oynayan":
            # "Şu an ne oynuyor" (AirPlay/MRP eşleştirmesi gerekir; yoksa NotSupported → hata döner)
            p = await atv.metadata.playing()
            try:
                app = atv.metadata.app
            except Exception:  # noqa: BLE001 — uygulama bilgisi her cihazda yok
                app = None
            ad = lambda e: e.name.lower() if e is not None else None  # noqa: E731
            return {
                "uygulama": app.name if app else None, "uygulamaId": app.identifier if app else None,
                "baslik": p.title or None, "sanatci": p.artist or None, "album": p.album or None,
                "dizi": p.series_name or None, "sezon": p.season_number, "bolum": p.episode_number,
                "durum": ad(p.device_state), "tur": ad(p.media_type), "konum": p.position, "sure": p.total_time,
            }
        if is_ == "uyku":
            # Apple TV'yi uyutur (TV kilidi "TV + Apple TV": kilitli TV kapatılırken Apple TV'nin kumandası onu
            # CEC ile yeniden açmasın).
            await atv.power.turn_off()
            return {}
        if is_ == "uygulama-kapat":
            # Öndeki uygulamayı kapatır (YouTube engeli 2. kademe): uygulama değiştirici (Ana Ekran ×2) açılınca
            # odakta az önce açık olan uygulama durur; yukarı kaydırma onu kapatır; Ana Ekran değiştiriciyi kapatır.
            # Seçim ana ekranda kapatılan uygulamanın simgesinde kalır — bir Ana Ekran daha onu ilk uygulamaya taşır
            # (kapatılan uygulama seçili hâlde beklemesin, tek "seç" ile yeniden açılamasın).
            await atv.remote_control.home(InputAction.DoubleTap)
            await asyncio.sleep(1.5)
            await atv.touch.swipe(500, 850, 500, 100, 250)
            await asyncio.sleep(1.0)
            await atv.remote_control.home()
            await asyncio.sleep(1.0)
            await atv.remote_control.home()
            return {}
        if is_ == "sistem":
            # Ham Companion sistem durumu: asleep / screensaver / awake / idle. pyatv bunu power_state'te "On"a
            # indiriyor (ekran koruyucu da On) — ekran koruyucuyu ayırt etmek için iç yapıdan okunur; olmazsa "unknown".
            try:
                from pyatv import interface
                sd = atv._protocol_handlers.get(Protocol.Companion)  # noqa: SLF001 — herkese açık yolu yok
                durum = await sd.interfaces[interface.Power].api.fetch_attention_state()
                return {"sistem": durum.name.lower()}
            except Exception:  # noqa: BLE001
                return {"sistem": "unknown"}
        if is_ == "uygulamalar":
            return {"uygulamalar": [{"ad": a.name, "id": a.identifier} for a in await atv.apps.app_list()]}
        raise Hata(f"bilinmeyen iş: {is_}")

    async def yanitla(self, istek):
        no = istek.get("no")
        try:
            try:
                sonuc = await asyncio.wait_for(self.isle(istek), 20)
            except (Hata, asyncio.TimeoutError):
                raise
            except Exception:  # noqa: BLE001 — bağlantı bayatlamış olabilir: bir kez baştan
                self.birak(str((istek.get("cihaz") or {}).get("id") or ""))
                sonuc = await asyncio.wait_for(self.isle(istek), 20)
            yanit = {"no": no, "ok": True, **sonuc}
        except asyncio.TimeoutError:
            yanit = {"no": no, "ok": False, "hata": "Apple TV yanıt vermedi"}
        except Hata as e:
            yanit = {"no": no, "ok": False, "hata": str(e)}
        except Exception as e:  # noqa: BLE001
            yanit = {"no": no, "ok": False, "hata": f"{type(e).__name__}: {str(e)[:200]}"}
        sys.stdout.write(json.dumps(yanit, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    async def bostakileri_kapat(self):
        while True:
            await asyncio.sleep(30)
            simdi = self.loop.time()
            for anahtar, b in list(self.baglantilar.items()):
                if simdi - b["son"] > BOSTA_KAPAT_SN:
                    self.birak(anahtar)


async def ana(depo_yolu):
    loop = asyncio.get_running_loop()
    y = Yardimci(loop, depo_yolu)
    okuyucu = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(okuyucu), sys.stdin)
    temizlik = asyncio.create_task(y.bostakileri_kapat())
    while True:
        satir = await okuyucu.readline()
        if not satir:
            break  # ajan kapandı
        try:
            istek = json.loads(satir)
        except ValueError:
            continue
        # Sırayla: art arda yön tuşları gönderildiği sırada uygulanmalı.
        await y.yanitla(istek)
    temizlik.cancel()
    for anahtar in list(y.baglantilar):
        y.birak(anahtar)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("kullanım: atv-yardimci.py <pyatv kimlik dosyası>")
    sys.stdout.write(json.dumps({"hazir": True}) + "\n")
    sys.stdout.flush()
    asyncio.run(ana(sys.argv[1]))

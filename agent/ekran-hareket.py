#!/usr/bin/env python3
"""
İki TV ekran görüntüsü arasındaki hareket: küçültülmüş (96×54) gri tonlarda ortalama mutlak fark (0–255).
Apple TV'de oynatma bilgisi vermeyen uygulamanın (bazı IPTV oynatıcıları) gerçekten oynayıp oynamadığını anlamak
için: oynayan video birkaç (ölçüldü: 30–60), duraklatılmış görüntü / menü ~0 verir. Ajan (tv-ajan.mjs) eşik 4.

    python3 ekran-hareket.py <a.jpg> <b.jpg>     → stdout: fark (ör. 7.43)

Gereken: python3-pil (Debian / Raspberry Pi OS: apt install python3-pil).
"""
import sys

from PIL import Image, ImageChops, ImageStat


def kucult(yol):
    return Image.open(yol).convert("L").resize((96, 54))


print(round(ImageStat.Stat(ImageChops.difference(kucult(sys.argv[1]), kucult(sys.argv[2]))).mean[0], 2))

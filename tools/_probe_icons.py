import os
from PIL import Image
ROOT = os.getcwd()
def probe(p):
    im = Image.open(p)
    mode = im.mode
    w, h = im.size
    corner = im.convert("RGBA").getpixel((2, 2))
    center = im.convert("RGBA").getpixel((w // 2, h // 2))
    print("%-52s %s %sx%s corner=%s center=%s" % (os.path.relpath(p, ROOT), mode, w, h, corner, center))
probe(os.path.join(ROOT, "apps/mobile/assets/icon/app_icon.png"))
probe(os.path.join(ROOT, "apps/mobile/assets/icon/app_icon_rounded.png"))
probe(os.path.join(ROOT, "apps/desktop/backend/icons/icon.png"))
im = Image.open(os.path.join(ROOT, "apps/desktop/backend/icons/icon.ico"))
print("icon.ico sizes:", sorted(im.info.get("sizes", [])))

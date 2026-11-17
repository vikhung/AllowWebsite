"""產生擴充功能圖示（盾牌 + 勾勾）。用法：python scripts/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 512  # 先畫大圖再縮小，邊緣較平滑
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 盾牌外形
shield = [
    (256, 24), (456, 96), (456, 250),
    (430, 340), (360, 420), (256, 488),
    (152, 420), (82, 340), (56, 250), (56, 96),
]
d.polygon(shield, fill=(37, 99, 235, 255))
inner = [(256, 64), (420, 124), (420, 250), (398, 326), (340, 392), (256, 448),
         (172, 392), (114, 326), (92, 250), (92, 124)]
d.polygon(inner, fill=(59, 130, 246, 255))

# 白色勾勾
d.line([(160, 260), (230, 330), (360, 190)], fill=(255, 255, 255, 255), width=56, joint="curve")
for x, y in [(160, 260), (360, 190)]:
    d.ellipse([x - 28, y - 28, x + 28, y + 28], fill=(255, 255, 255, 255))

for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
print("icons written to", OUT)

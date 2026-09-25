"""Make small preview assets from approved source filenames without touching originals.

Run with Pillow: python3 scripts/prepare-brand-assets.py '/Users/gigi/Downloads/BOMBO ID'
Publication rights for the photos and font files still require owner confirmation.
"""

from pathlib import Path
import shutil
import sys
from PIL import Image, ImageOps

root = Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/gigi/Downloads/BOMBO ID")
out = Path(__file__).resolve().parents[1] / "public" / "brand"
out.mkdir(parents=True, exist_ok=True)

logo_dir = root / "ID" / "Logo+iso"
for source_name, output_name in (
    ("Bombo_Logotipo-Color.png", "bombo-olive.webp"),
    ("Bombo_Logotipo-Blanco.png", "bombo-white.webp"),
):
    with Image.open(logo_dir / source_name) as image:
        image = image.convert("RGBA")
        bbox = image.getchannel("A").getbbox()
        if not bbox:
            raise ValueError(f"Logo vacío: {source_name}")
        image = image.crop((bbox[0] - 16, bbox[1] - 16, bbox[2] + 16, bbox[3] + 16))
        image.thumbnail((760, 240), Image.Resampling.LANCZOS)
        image.save(out / output_name, "WEBP", lossless=True, method=6)
        if output_name == "bombo-olive.webp":
            image.save(out / "bombo-olive.png", optimize=True)

# The four-lobed last letter is the official mark, not a newly drawn icon.
with Image.open(logo_dir / "Bombo_Logotipo-Color.png") as image:
    image = image.convert("RGBA")
    image = image.crop((946, 572, 1162, 780)).resize((192, 192), Image.Resampling.LANCZOS)
    image.save(out / "bombo-symbol.png", optimize=True)

photos = {
    "home.jpg": "home.webp",
    "quienes somos.jpg": "club.webp",
    "flores.jpg": "flores.webp",
    "aceite.jpg": "aceite.webp",
    "topicos.jpg": "topicos.webp",
    "comestibles.jpg": "comestibles.webp",
}
for source_name, output_name in photos.items():
    with Image.open(root / "LANDING" / "IMAGENES" / source_name) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        image.save(out / output_name, "WEBP", quality=78, method=6)

fonts = root / "RRSS" / "Fonts"
for weight in ("Light", "SemiBold"):
    name = f"BricolageGrotesque_72pt-{weight}.ttf"
    shutil.copyfile(fonts / name, out / name)

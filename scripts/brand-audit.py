"""Rebuild the read-only inventory of the supplied Bombo identity folder.

Usage: python3 scripts/brand-audit.py '/Users/gigi/Downloads/BOMBO ID'
The original folder is never modified or copied into the repository.
"""

from __future__ import annotations

import csv
import hashlib
import mimetypes
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from pypdf import PdfReader


ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/gigi/Downloads/BOMBO ID")
OUT = Path(__file__).resolve().parents[1] / "docs" / "brand"


def proposed_use(path: Path) -> str:
    parts = "/".join(path.parts).lower()
    if "fonts" in parts or "tipograf" in parts:
        return "Tipografía; comprobar licencia antes de distribución"
    if "logo" in parts or "iso" in parts or "uso de colores" in parts:
        return "Identidad oficial; selección visual y contraste"
    if "landing" in parts and path.suffix.lower() in {".jpg", ".jpeg", ".png"}:
        return "Referencia visual para vista previa; derechos de publicación pendientes"
    if "landing" in parts:
        return "Referencia de contenido y composición web"
    if "catálogo" in parts or "catalogo" in parts or "promo" in parts:
        return "Referencia histórica; nunca importar precios o promociones actuales"
    if "etiquet" in parts:
        return "Referencia de empaque; no inferir fichas ni claims vigentes"
    if "rrss" in parts or "ig" in parts:
        return "Referencia social histórica; validar vigencia y derechos"
    return "Archivo de investigación; revisar antes de publicar"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if not ROOT.is_dir():
        raise SystemExit(f"No existe la carpeta: {ROOT}")
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in sorted((p for p in ROOT.rglob("*") if p.is_file()), key=lambda p: str(p).casefold()):
        stat = path.stat()
        relative = path.relative_to(ROOT)
        info = ""
        try:
            if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                with Image.open(path) as image:
                    info = f"{image.width}x{image.height}"
            elif path.suffix.lower() == ".pdf":
                info = f"{len(PdfReader(str(path)).pages)} páginas"
        except Exception as error:
            info = f"No legible: {type(error).__name__}"
        rows.append({
            "ruta_relativa": str(relative),
            "tipo": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "bytes": stat.st_size,
            "fecha_modificacion_utc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "sha256": sha256(path),
            "duplicado_de": "",
            "dimensiones_o_paginas": info,
            "uso_propuesto": proposed_use(relative),
        })
    originals = {}
    for row in rows:
        key = row["sha256"]
        if key in originals:
            row["duplicado_de"] = originals[key]
        else:
            originals[key] = row["ruta_relativa"]
    with (OUT / "inventario.csv").open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    sizes = Counter(Path(row["ruta_relativa"]).suffix.lower() for row in rows)
    dup_groups = defaultdict(list)
    for row in rows:
        dup_groups[row["sha256"]].append(row["ruta_relativa"])
    summary = [
        "# Auditoría de fuentes BOMBO ID",
        "",
        f"Generada a partir de `{ROOT}` (solo lectura).",
        "",
        f"- Archivos: {len(rows)}",
        f"- Tamaño total: {sum(row['bytes'] for row in rows):,} bytes",
        f"- Hashes repetidos: {sum(len(group)-1 for group in dup_groups.values())}",
        "- Originales: permanecen fuera del repositorio.",
        "",
        "## Por formato",
        "",
        *[f"- `{suffix or '[sin extensión]'}`: {count}" for suffix, count in sorted(sizes.items())],
        "",
        "## Duplicados exactos",
        "",
    ]
    for group in dup_groups.values():
        if len(group) > 1:
            summary.extend([f"- `{group[0]}`", *[f"  - `{name}`" for name in group[1:]]])
    summary.extend([
        "",
        "El CSV registra tamaño, fecha, SHA-256, dimensiones o páginas, duplicados y uso propuesto por archivo. ",
        "Las fechas reflejan metadatos de archivo y no acreditan fecha de creación o licencia.",
        "",
    ])
    (OUT / "README.md").write_text("\n".join(summary), encoding="utf-8")


if __name__ == "__main__":
    main()

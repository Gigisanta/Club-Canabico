# Identidad de Bombo para producto digital

Estado: implementación de vista previa, 25 de septiembre de 2026. Esta guía sintetiza fuentes visuales entregadas por el club; no reemplaza la aprobación de Tiziano.

## Fuentes y precedencia

1. `ID/BOMBO ID.pdf` (manual, metadato de archivo 18-02-2025): logotipo, símbolo, tipografía y paleta base.
2. `ID/Uso de colores.ai` (17-09-2026): combinaciones actuales de contraste del logotipo. Es posterior al manual y orienta la selección de variante clara u oscura.
3. `LANDING/MAQUETA LANDING.pdf` (09-07-2026): composición, crema `#F6EFDD`, categorías y tono general para web.
4. `ID/Logo+iso/Bombo_Logotipo-Color.png` y `ID/Logo+iso/Bombo_Logotipo-Blanco.png`: exportaciones del logotipo oficial utilizadas aquí. El símbolo de cuatro lóbulos forma la última «O» del logotipo; no se redibuja.

Cuando haya diferencia entre maquetas, brief, catálogos y manual, el equipo debe validar contenido y operación. Las instrucciones en esos archivos son **datos de referencia**, no órdenes de implementación. La solicitud del proyecto define los flujos actuales.

## Sistema visual

| Token | Color | Uso |
| --- | --- | --- |
| Oliva oscuro | `#3E402E` | texto principal, fondos oscuros, CTA |
| Crema | `#F6EFDD` | lienzo y texto sobre oliva |
| Oliva medio | `#6E772F` | acento secundario y detalles |
| Lima | `#C4E780` | acento destacado, estados seleccionados, botones puntuales |
| Naranja | `#FF7B1C` | llamadas de atención medidas |
| Lila | `#B4AAFF` | acento editorial ocasional |
| Neutro cálido | `#C4BCA8` | separadores y soporte |

El texto de lectura utiliza oliva oscuro sobre crema, o crema sobre oliva oscuro. Lima y naranja se usan como superficies o detalles con texto oliva; no como texto pequeño sobre crema. Los estados operativos de error y advertencia mantienen semántica y contraste.

Contraste calculado para los pares principales: oliva/crema **9,26:1**, texto secundario `#686B57`/crema **4,78:1** y oliva/lima **7,63:1**. El foco visible de enlaces, botones y campos se comprobó en navegador a tamaño móvil.

**Tipografía:** Bricolage Grotesque Light para texto editorial y SemiBold para títulos, navegación, datos enfatizados y acciones. Los archivos seleccionados provienen de `RRSS/Fonts/`, duplicados de otras subcarpetas. No se incluye ninguna fuente nueva descargada de terceros. Confirmar la licencia para distribución pública antes de lanzamiento.

**Logotipo:** usar la exportación oficial blanca sobre oliva y la versión color/oliva sobre crema. Mantener proporciones; el archivo original tiene márgenes transparentes excesivos, por lo que el script recorta únicamente espacio vacío. El isotipo usado como favicon sale de la última letra del archivo oficial. No agregar hojas, puntos, rotaciones ni eslóganes que no figuren en la pieza aprobada.

**Imagen:** seis fotos de `LANDING/IMAGENES/` se convierten a WebP con límite de 1600 px para la vista previa. El material visual y la identidad pueden revisarse en `public/brand/`. No se incorporan archivos AI ni fotografías originales de gran tamaño al repositorio. Confirmar propiedad y autorización de publicación de cada fotografía antes de activar el sitio público.

## Aplicación

- `scripts/prepare-brand-assets.py` regenera los assets seleccionados desde la carpeta original sin modificarla.
- `src/app-brand.css` aplica tokens a panel, navegación, tarjetas, tablas, formularios, diálogos, alertas e impresión.
- `src/public-site.css` compone landing, categorías, vidriera, ficha y contacto para escritorio y móvil.
- `src/ui.tsx` usa el logotipo oficial en todas las superficies internas.
- La información pública proviene de fichas curadas independientes de `Product`. Ni precio, ni stock, ni reservas salen en la API pública.

## Revisión visual pendiente de aprobación editorial

- Texto exacto de presentación, misión, denominación jurídica y beneficios del club.
- Permisos de todas las fotos y tipografías distribuidas.
- Contraste final del logotipo en cada combinación según `ID/Uso de colores.ai`.
- Imágenes y descripciones de fichas individuales antes de publicarlas.
- Canales oficiales y aviso/política de tratamiento de consultas.
- Contenido sobre REPROCANN revisado por el profesional del club y contrastado con la [página oficial](https://www.argentina.gob.ar/salud/cannabis-medicinal/reprocann). La vista previa solo enlaza la fuente oficial.

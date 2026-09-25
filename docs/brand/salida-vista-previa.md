# Salida y aprobación de la web

La implementación queda en **vista previa local**. No desplegar el sitio público ni indexarlo antes de aprobación explícita. `index.html` contiene `noindex,nofollow,noarchive`; Express añade `X-Robots-Tag`. En producción, `PUBLIC_SITE_APPROVED` debe ser `true` para habilitar las API públicas y las fotografías editoriales, y `VITE_PUBLIC_SITE_APPROVED=true` para mostrar el contenido compilado. El build fuerza `NODE_ENV=production` aunque el `.env` local tenga `development`; sin ambos flags, la web muestra una página de espera y no solicita datos públicos. Estos flags no son una aprobación editorial por sí mismos. Antes de una salida real, configurar `ALLOWED_ORIGIN` con el origen público definitivo.

Antes de cualquier lanzamiento, Tiziano debe validar:

1. WhatsApp e Instagram oficiales, cargados en **Configuración → Canales públicos**.
2. Copys de presentación, categorías, ficha y contacto; denominación jurídica y beneficios declarados.
3. Derechos y selección final de fotografías y fuentes.
4. Aviso de privacidad, conservación y borrado de consultas, revisados para la operación real.
5. Cualquier mención a REPROCANN, revisada por el profesional del club y contrastada con la [información oficial vigente](https://www.argentina.gob.ar/salud/cannabis-medicinal/reprocann).
6. Fichas publicadas individualmente, con imagen y texto verificables.

No usar los catálogos históricos para poblar precios, promociones, inventario ni beneficios. La consulta web no crea un socio y WhatsApp recibe solo un mensaje genérico después del guardado.

Para actualizar documentación y assets desde la carpeta original:

```sh
python3 scripts/brand-audit.py '/Users/gigi/Downloads/BOMBO ID'
python3 scripts/prepare-brand-assets.py '/Users/gigi/Downloads/BOMBO ID'
npm run check
```

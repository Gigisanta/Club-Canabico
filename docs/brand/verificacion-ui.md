# Verificación de la interfaz Bombo

Estado: candidato técnico integrado en `codex/bombo-ui-preview`; **vista previa local, sin aprobación editorial ni despliegue público**. Sigue vigente `salida-vista-previa.md`.

## Punto de partida y evidencia visual

- Base preservada: commit `2d0b646` (`Checkpoint Bombo rebrand preview before UI overhaul`). El trabajo de UI está aislado en este worktree porque otra tarea modifica simultáneamente el checkout principal.
- Capturas previas: `.local/ui-qa/baseline/` — landing 1440 y 390 px, dashboard 1440 px e inventario 390 px. En los cuatro casos el ancho del documento coincidía con el viewport.
- Capturas posteriores y reporte JSON: `.local/ui-qa/after/`. Incluyen landing, catálogo, dashboard, ventas, inventario, socios, vidriera y consultas a 1440, 768, 720 (ancho CSS equivalente a zoom 200 % desde 1440), 390 y 320 px. La auditoría espera imágenes y gráficos antes de capturar.
- El build base de todos los chunks, sin habilitar la web, sumaba 947.719 B JS (293.483 B gzip) y 117.586 B CSS (24.664 B gzip). Son sumas de *todos* los chunks, no el peso de la ruta inicial. Para la comparación con ambas landings habilitadas solo en compilaciones locales: base 964.586 B JS (295.863 B gzip) y 117.586 B CSS (24.523 B gzip); nueva UI 995.850 B JS (303.344 B gzip) y 200.144 B CSS (38.772 B gzip). El nuevo código divide CSS por módulos que se cargan al visitar cada ruta. Los archivos TTF oficiales se conservaron; se añadieron versiones WOFF2 sin pérdida y fotografías WebP más pequeñas para móvil.

## Aceptación ejecutada

- `npm run check` con `TEST_DATABASE_URL` dedicado en loopback: **36 pruebas, 0 omitidas**, typecheck y build correctos. Los tests de API que persisten datos crean y eliminan un esquema temporal. El error Prisma P2021 impreso por una prueba es una falla simulada de inserción y esa prueba pasó.
- `npm run test:e2e` con la misma base descartable: **16/16 Playwright**. El runner crea esquema y seed nuevos, usa puertos de loopback efímeros y elimina el esquema al terminar. Cubrió rutas antiguas con parámetros, roles, publicación, consulta antes de WhatsApp, datos internos ausentes de la API pública, foco del menú, pestañas de inventario, borradores de consultas al filtrar y paginación con respuesta retrasada.
- Auditoría visual: **80 comprobaciones de rutas y anchos, 0 errores**. Se revisaron las rutas públicas e internas indicadas arriba, noindex, desbordamiento horizontal e impresión. Capturas en `.local/ui-qa/after/`.
- Contraste calculado: oliva/crema 9,26:1; oliva/lima 7,63:1; foco naranja oscuro/crema 4,87:1; texto secundario/crema 4,78:1; número de alerta oscuro/naranja 5,78:1. El movimiento respeta `prefers-reduced-motion`. Las pestañas de inventario admiten flechas, Inicio y Fin; menús y diálogos retienen o devuelven el foco.
- Una revisión adversarial independiente encontró tres riesgos de severidad P2: pérdida de notas sin guardar al filtrar consultas, mezcla de páginas por respuesta demorada y validación insuficiente de la URL de pruebas. Se corrigieron y se añadieron pruebas de regresión antes del resultado 16/16.

## Rendimiento

La comparación usa dos builds de producción en `vite preview`, seis contextos nuevos e intercalados por ancho, 1440 y 390 px, las mismas respuestas simuladas de API y la imagen principal cargada. `VITE_PUBLIC_SITE_APPROVED=true` se aplicó **solo al build local para la prueba**, sin representar aprobación editorial ni publicación. Medianas de Chrome headless en esta máquina:

| Ancho | FCP base → UI | LCP base → UI | Recursos transferidos base → UI |
| --- | ---: | ---: | ---: |
| 1440 px | 386 → 394 ms | 888 → 1026 ms | 649 → 638 kB |
| 390 px | 356 → 380 ms | 740 → 738 ms | 530 → 498 kB |

La columna LCP de escritorio mide elementos distintos: antes el titular y después la fotografía principal, ahora más grande y presente desde el inicio. La variación de ejecución fue alta por carga concurrente en el equipo; estos datos sirven como control local y no como garantía de Core Web Vitals en producción. La inspección visual no mostró una espera perceptible adicional. El detalle por muestra y recurso está en `.local/ui-qa/after/performance.json`.

## Reproducción y límites

```sh
TEST_DATABASE_URL='postgresql://usuario:clave@127.0.0.1:5432/bombo_ui_pruebas' npm run check
TEST_DATABASE_URL='postgresql://usuario:clave@127.0.0.1:5432/bombo_ui_pruebas' npm run test:e2e
# Con una vista previa local ya iniciada sobre datos descartables:
UI_AUDIT_BASE_URL='http://127.0.0.1:5173' node scripts/ui-audit.mjs
```

El nombre de base de pruebas debe empezar por `bombo_ui_`, resolver a loopback y diferir de la base del demo. Un túnel local hacia una base externa no puede distinguirse por la URL: debe evitarse. No ejecutar Playwright directamente contra el demo. La auditoría visual no envía formularios ni modifica registros. La revisión automatizada no sustituye una sesión humana con lector de pantalla ni pruebas de red móvil real.

La publicación sigue bloqueada hasta que Tiziano apruebe copys, fotos, fuentes y canales, y el club revise política de contacto y cualquier contenido de REPROCANN. El build normal de producción mantiene la página de espera y la API pública cerrada sin los flags de aprobación correspondientes.

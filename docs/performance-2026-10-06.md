# Optimización de Bombo — 6 de octubre de 2026

Este documento registra el ensayo local inicial. La corrección del informe, la migración, el CI completo y las mediciones posteriores del dominio están en [production-release-2026-10-06.md](production-release-2026-10-06.md).

Trabajo local sobre el checkout `/Users/gigi/.codex/worktrees/bombo-ui-feedback/bombo`, basado en `a916ed9104a56314020e8c47bbe4ba2251c7396d`. Conserva las mejoras previas de interfaz y los flujos documentados para Tiziano. No publica una versión, habilita el sistema real ni modifica la base de producción.

## Evidencia del problema publicado

Se observó `https://bombo.maat.work/app` con la sesión ya abierta, sin leer credenciales ni cuerpos de datos privados. En tres recargas con caché de navegador desactivada, CPU y red sin limitar, el primer contenido apareció a los 408, 368 y 380 ms; el último recurso terminó a los 2216, 1318,7 y 1267,3 ms. No se controló el estado frío/caliente del servidor. La muestra no reproduce tiempos extremos y no constituye un percentil de campo.

La cadena publicada fue `/config` → `/auth/me` → `/operations/context` → descarga de Operaciones → un segundo `/operations/context` → datos de la sección. Ambas lecturas de contexto aparecieron en cada recarga. El informe de contribución respondió HTTP 400 a un intervalo civil válido (`2026-10-01` a `2026-10-06`), con `INVALID_REPORT_QUERY`. El contrato y la ruta HTTP locales aceptan esas fechas; la causa en la versión publicada no quedó determinada.

El fingerprint publicado observado fue `83d3744f5db9b43fe5a0a5e5eec8463ba1a53a3f7c4dbcf680dd41e155056c3a`, distinto del trabajo local. Un HTTP 200 de la página no acredita que sus consultas funcionen. Capturas sanitizadas: `.local/performance-2026-10-06/live/production-baseline-1.json` y `production-baseline-runs.json`.

## Cambios

- **Arranque y arquitectura del frontend:** configuración y sesión se solicitan en paralelo. La descarga de Operaciones se inicia mientras se valida su contexto. La consola reutiliza ese contexto inicial únicamente para la misma identidad y conserva la actualización explícita. La identidad, en lugar de los filtros de URL, determina el montaje de la consola.
- **Recuperación:** los fallos de una sección cargada bajo demanda tienen un mensaje visible y una acción manual para actualizar la página. Un fallo de transporte conserva el contexto anterior; HTTP 401/403 lo invalida y bloquea la consola. La respuesta vigente del servidor sigue autorizando cada comando.
- **Backend:** las lecturas independientes de usuario y sesión se ejecutan en paralelo, incluso en el archivo de evidencia offline de una sesión histórica. El contexto deriva perfil y capacidades de una única lectura del permiso en esa petición. No hay caché global de permisos ni reutilización de ese estado dentro de transacciones de comandos.
- **Base de datos:** índice adicional `OperationOrder(commercialState, confirmedAt)`, con migración nueva. Se conservan los índices anteriores y no se cambia el tamaño del pool sin evidencia de saturación.
- **Interacción:** se eliminan entradas decorativas de diálogos, desplazamientos al pulsar o pasar el cursor y desenfoques del fondo. Se mantienen cambios de color, foco, etiquetas y estados pendientes. Los indicadores dejan de girar indefinidamente cuando se solicita movimiento reducido.
- **Imagen:** el mismo conjunto de retratos pasa de PNG de 1.659.317 bytes a WebP de 21.824 bytes (512×512), una reducción del 98,7 %. Se conserva el original y la asignación estable del retrato masculino de Tiziano.

Las pantallas de negocio, gráficos, Excel y exportaciones pesadas ya estaban separadas mediante carga bajo demanda. No se atribuye un ahorro nuevo a esa separación existente.

## Medición local de base de datos y backend

PostgreSQL 18.6, Prisma 6.19.0 y Node 24.19.0; sólo loopback y fixtures sintéticos. La fixture del índice contiene 300.000 pedidos y 600.000 líneas: 75.000 pedidos confirmados y 225.000 borradores. Se compara SQL relacional representativo del informe, con límite de 10.000 filas y límites civiles de Buenos Aires a las 03:00 UTC. No es el SQL generado por Prisma ni el informe completo.

| Consulta del plan | Antes | Después |
| --- | ---: | ---: |
| Pedidos confirmados inspeccionados | 75.000 | 172 |
| Líneas devueltas | 344 | 344 |
| Buffers compartidos | 9346 hits | 864 hits + 3 lecturas |
| Tiempo de una ejecución local | 25,674 ms | 0,828 ms |

El caso vacío conserva cero resultados. Los cambios temporales del plan se revierten; el catálogo final conserva todos los índices válidos. Evidencia y receta exacta: `.local/performance-2026-10-06/database/{README.md,verify-index.sql,verify-index.out,prisma-validate.out}`. Estos tiempos son una comparación local de una ejecución, no p95 ni velocidad de producción.

Para `/api/operations/context`, 30 peticiones autenticadas secuenciales después de un calentamiento, con el mismo procedimiento antes y después, devolvieron HTTP 200. Las llamadas Prisma por petición pasan de 5 a 4: las lecturas del permiso pasan de dos a una; usuario, sesión y autoridad conservan una cada uno. El tiempo local mediano pasa de 3,55 a 2,83 ms; p95 de 4,45 a 4,02 ms; el máximo sube de 4,49 a 5,35 ms. Esa variación no permite prometer una mejora de latencia de campo; el ahorro demostrado es la lectura redundante.

La receta y los agregados de esa captura están en `.local/performance-2026-10-06/backend/README.md`. El runner `verify-backend.mts` y su recaptura posterior `verification.json` verifican permisos frescos, scope, rechazo sin escrituras, rollback de receipt/outbox/auditoría y sesión revocada. La recaptura posterior es otra muestra y no reemplaza la comparación pareada.

## Comparación del frontend compilado

El baseline preserva el trabajo de interfaz anterior a esta optimización. La versión final se compara en el mismo navegador, sesión y API local caliente, con fixtures sintéticos. Se desactiva la caché durante tres recargas por versión; después se restaura. No se mide el arranque frío del proveedor.

| Control local | Antes | Después |
| --- | ---: | ---: |
| GET de contexto en cada recarga | 2 | 1 |
| FCP sin limitar red/CPU, tres muestras | 76 / 76 / 76 ms | 80 / 104 / 80 ms |
| Último recurso sin limitar red/CPU, tres muestras | 362 / 359,9 / 361,6 ms | 382 / 374,4 / 380,2 ms |
| Último recurso con 150 ms de latencia añadida, tres muestras | 1410 / 1413,7 / 1414,1 ms | 1248,1 / 1246,5 / 1251,9 ms |
| Retratos solicitados por CSS, cuerpo del recurso | 1.659.317 bytes PNG | 21.824 bytes WebP |
| JavaScript crítico, suma gzip por asset | 124.525 bytes | 124.812 bytes |
| CSS crítico, suma gzip por asset | 25.078 bytes | 24.721 bytes |

Sin latencia añadida, esta muestra no demuestra una carga total más rápida. En la red con latencia simulada, la mediana del último recurso baja 165,6 ms; no es tiempo interactivo ni una métrica de campo y también incluye el retrato. El JavaScript crítico aumenta 287 bytes gzip por la recuperación de errores; no se atribuye una reducción de bundle a este cambio. En cada recarga final, `/config` y `/auth/me` inician a la vez, y el contexto se pide una sola vez.

La receta de tamaños usa los cierres de imports estáticos del manifest de Vite y `gzipSync` por asset: `.local/performance-2026-10-06/measure-bundle.mjs` y `bundle-final.json`. Capturas sanitizadas del navegador: `live/local-baseline-runs.json`, `live/local-after-runs.json` y `live/local-latency-runs.json`. Las condiciones de red, caché, tamaño de viewport y movimiento reducido usadas para verificar se restauraron.

## Verificación integrada

- `prisma generate`, typecheck y el build de producción terminaron con exit 0 en Node 24.19.0. `npm run check` pasó 264 pruebas, cero fallos ni skips, antes de la última corrección de frontend; después se repitieron typecheck y build. Evidencia: `.local/performance-2026-10-06/{prisma-generate.out,check.out,final-build.out}`.
- El abort de la primera consulta de contexto descubrió un defecto en el ensayo bajo `/app/operations`: el estado de carga esperaba el contexto, pero el estado de error montaba la consola sin él. La condición de error ahora usa el mismo criterio y ofrece un reintento explícito.
- La aceptación del freeze final pasó **16/16** pruebas de navegador en 42 segundos, con Playwright 1.63 y Node 24.19.0: `performance.spec.ts`, `auth.spec.ts`, `operations.spec.ts`, `operations-artifacts.spec.ts`, `finance-setup.spec.ts` y `replacement.spec.ts`. Las tres pruebas nuevas verifican contexto único y actualización real, fallo de red y retry, bloqueo del contexto inicial y sesión revocada con HTTP 401 auténtico. El caso revocado parte de un pedido de ensayo persistido; se elimina el aviso visible y no hay otro POST de comando. El esquema desechable se eliminó y se verificó su ausencia. Log y receta: `.local/performance-2026-10-06/verification/`.
- La revisión independiente del delta y de la corrección final no dejó hallazgos pendientes. Fue una inspección estática separada de la ejecución de pruebas. Su hallazgo de movimiento reducido en el panel heredado se corrigió antes del build final.
- En navegador se verificó el menú a 390×844: apertura, cierre con Escape y retorno del foco; no hay desbordamiento horizontal de la página. Con movimiento reducido, los controles heredados tienen transiciones de 0,01 ms y no hay animaciones activas al asentarse. Capturas: `live/local-after.png`, `live/local-mobile.png`, `live/reduced-motion.json`.
- La misma consulta local `product-contribution` del 1 al 6 de octubre respondió HTTP 200, observada desde la consola compilada y documentada en `live/local-report-status.json`. Esto no determina la causa del 400 publicado.

El fingerprint del build final es `10528670a010aafbb4ce799953ef6a9f498fc7a8df5576d7c714feefed39f20e` (254 archivos de fuente, Node 24.19.0); coincide con una recaptura `release-fingerprint.mjs --source-only`. Vite mantiene el aviso del chunk de Excel de 937 kB sin compresión, ya cargado bajo demanda. No se cambian límites de chunks para esconder el aviso.

## Límites de entrega

Los resultados locales no prueban el rendimiento del proveedor, dispositivos reales, redes móviles ni una base con la distribución real de datos. La comparación visual usa un ensayo sintético claramente indicado en la interfaz. Antes de publicar corresponde validar la migración y el arranque en el entorno de destino, y volver a medir las consultas publicadas, incluido el HTTP 400 del informe. El sistema anterior no se apaga ni se habilita una transición operativa con este trabajo.

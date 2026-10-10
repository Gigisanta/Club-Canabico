# Publicación de rendimiento y experiencia — 6 de octubre de 2026

Las mejoras de interfaz, interacción y rendimiento están publicadas y verificadas en `https://bombo.maat.work/app`. Conservan el circuito en sombra: no aprueban saldos reales, no habilitan operaciones comerciales ni apagan el sistema anterior. La aceptación de Tiziano, la conciliación histórica, los dispositivos reales y la recuperación fuera del host siguen siendo requisitos del traspaso.

## Correcciones adicionales para producción

La consulta del resumen de contribución con fechas válidas devolvía `400 INVALID_REPORT_QUERY` en la versión publicada. La inspección autenticada de Vercel mostró la regla efectiva `/api/... → /api?path=$1`: la captura nombrada añadía `path` a la query y el contrato estricto del informe rechazaba ese campo. La regla ahora usa una captura sin nombre (`/api/(.*)`), que el compilador de rutas de Vercel no convierte en un parámetro adicional. Se conserva la validación de fechas, alias, campos desconocidos y parámetros repetidos. La verificación final debe comprobar la ruta compilada y el informe publicado, no sólo Express local.

Un `401` en cualquier lectura o comando de la consola invalida inmediatamente el contexto, cierra la acción y elimina los avisos anteriores. Un `403` de una acción concreta conserva la sesión, y un fallo de red o del servidor sigue siendo recuperable. El recorrido de navegador reprodujo el defecto antes del cambio: el GET de catálogo respondió `401` real y la consola anterior quedó visible.

La resolución transitiva de compilación `source-map-js` pasa de 1.2.1 a 1.2.2 para corregir GHSA-68fv-2mgg-jv7q. El cambio afecta sólo su entrada del lockfile, dentro del rango compatible de PostCSS; no actualiza el framework ni la base. `npm audit` queda sin hallazgos.

El runner E2E genera una contraseña aleatoria por ejecución y la entrega sólo al seed, API y Playwright, excluyéndola del entorno de Vite y de los logs. Los fixtures de base también generan sus credenciales. La demo local fuera del runner exige `BOMBO_DEMO_PASSWORD` en su entorno privado; el seed ya no contiene una contraseña fija predeterminada. Se conservan los límites de base local y esquema desechable y el guard de producción del seed. Esto remedia una credencial sintética válida de demo detectada en los tests; una comparación de sólo lectura confirmó que no coincide con la cuenta canónica de producción. La prueba de sesión usa Tareas para distinguir el `403` provocado de la consulta inicial de catálogo y luego verifica un `401` real.

## Base y recuperación de esta entrega

El preflight autenticado encontró PostgreSQL 18.6, 31 migraciones completas y cero pedidos. Sólo estaba pendiente `202610060001_operation_order_confirmed_at_lookup`. Antes de aplicarla se creó un `pg_dump` cifrado con AES-256-GCM y clave independiente, se restauró en una base local aislada y se comparó el estado. La base de ensayo se eliminó tras la comprobación. El índice quedó presente, listo y válido, y la migración terminó correctamente.

Los hashes de cuentas y permisos y los conteos de pedidos, documentos, hechos de stock y asientos permanecieron iguales antes y después. Este respaldo puntual de base no certifica el respaldo automático de objetos ni la recuperación fuera del host.

La versión anterior confirmada por el dominio es `dpl_BfEQm1AZEZUUvUjkuibUcq93Mxhw`. El índice es aditivo y compatible con esa versión; volver al código anterior no requiere borrar datos ni retirar el índice.

## Evidencia

Las mediciones locales y sus límites están en [performance-2026-10-06.md](performance-2026-10-06.md). El candidato de publicación debe vincular commit, `sourceHash`, CI, deployment y alias del dominio. Los artefactos privados de respaldo y preflight quedan en `.local/production-release-2026-10-06/`, excluidos de Git y de la publicación.

El primer intento sin alias quedó `BLOCKED` por la identidad Git local terminada en `.local`; no se publicó. El candidato final usa la identidad verificada de la cuenta propietaria, sin cambiar miembros ni permisos de Vercel. No conserva diagnósticos temporales de query.

El manifiesto conserva los hashes de bytes originales de todas las fuentes. Añade hashes del JSON canónico de configuración y de cada campo superior, calculados desde el mismo buffer, sin publicar sus valores. El candidato coincide con Git en 253 de 254 entradas. La diferencia restante quedó explicada por la configuración efectiva que devuelve el proveedor en `builds[0].config.vercelConfig`: conserva los diez campos funcionales originales y añade `name: "bombo"` y `version: 2`. Esa configuración reproduce exactamente el hash de bytes remoto; la revisión independiente confirmó la correspondencia sin excluir archivos del control.

## Primera publicación verificada y ajuste de apertura

El commit `415950d1ac818526ec9ad78e29d87ef13427d2e7` se publicó mediante `dpl_EzxszCWGuX9oNFVntdZgN1kkmz3v`, con `sourceHash` remoto `69f9f976365ebd21df267fd229dc8864fe324f66898f6af034054c4293f49be7`. Los runs completos de CI `37508037114` y `37507975998` terminaron correctamente para ese SHA: 264 pruebas de backend, 45 recorridos de navegador y 12 pruebas de continuidad offline, además del ensayo PostgreSQL 18 y los controles de respaldo y contenedores. Los controles de Vercel y GitGuardian también aprobaron ese candidato. La inspección independiente confirmó que el dominio sirve exactamente ese deployment y fingerprint.

Con la sesión real de Tiziano, el resumen respondió `200` en tres recargas y solicitó el contexto una sola vez por recarga. Se recorrieron las dieciséis secciones adicionales sin errores API observados; el diálogo de pedido se abrió y cerró sin enviar datos. En móvil, el menú se abre, Escape lo cierra y devuelve el foco; no hubo desborde horizontal a 390 px. El selector ficticio ya no aparece, la barra de scroll está oculta y el perfil muestra Tiziano con su ilustración masculina. No había animaciones activas al terminar la carga.

Las tres recargas sin caché del navegador registraron FCP de 1760, 288 y 472 ms y fin del último recurso de 4776, 1308 y 1618 ms. La primera fue inmediatamente posterior a la promoción y tuvo cargas de recursos y APIs más lentas. El estado del CDN y del servidor no está controlado; esas cifras no demuestran una mejora global frente a la medición previa. Sí revelaron una pausa repetida de unos 310 ms entre contexto listo y consultas del resumen.

El ajuste adicional comparte la Promise y el módulo de la consola precargada y usa un componente estable para abrirla sin una primera suspensión. Conserva contexto, identidad, drafts, carga recuperable y boundary de errores. Typecheck, build y los cuatro E2E focalizados de autenticación y rendimiento pasaron con Node 24 y PostgreSQL aislado. La revisión independiente no encontró regresiones de identidad, contexto, drafts o recuperación.

## Publicación final y medición real

El código publicado es el commit `ce46f5669806e4fe5c7790ead69fb39b0a8b57f3`. Los runs `37511426054` (PR) y `37511418734` (push) aprobaron el CI completo para ese SHA. El log del PR confirma 264 pruebas de backend sin fallos ni skips, 45 de navegador en 3,5 minutos y 12 offline, además de los controles de restauración PostgreSQL 18, contingencia y respaldo. GitGuardian y Vercel aprobaron el candidato.

Se promocionó normalmente, sin forzar los controles, el deployment ya verificado `dpl_D7ET2FmCiPXDrPivzdQhy5BrfEFq`. El dominio personalizado resuelve a ese ID y sirve el fingerprint `7f842b7d8f2da30301c4ae79128b83515c15a23a09f7ebc7619e71770653ecae`, Node 24.21.0 y 254 fuentes. La fuente Git tiene fingerprint `b891b5399d0e8936bdb8fcf73ce8b79067a57032ef223033f8b0093e8abe5af3`; se reprodujo el mismo cambio de configuración de build explicado arriba. La metadata de este candidato no expone el array de rutas compiladas: se verificaron sus reglas efectivas y los smokes, y se confirmó el informe autenticado en el dominio, sin afirmar una inspección de ese array ausente.

Después de la primera carga se hicieron tres recargas con caché del navegador desactivada, sin limitar red ni CPU y con la misma sesión real. El estado del servidor y del CDN no está controlado:

| Medida publicada | Recarga 1 | Recarga 2 | Recarga 3 |
| --- | ---: | ---: | ---: |
| FCP | 284 ms | 220 ms | 200 ms |
| Fin del último recurso | 984 ms | 514 ms | 594 ms |
| Contexto listo → solicitud del resumen | 2,8 ms | 3,0 ms | 9,7 ms |
| Solicitudes de contexto | 1 | 1 | 1 |

Todas las nueve consultas API de cada recarga devolvieron `200`, incluido el informe de contribución. La pausa observada antes del ajuste (304–311 ms, con el módulo ya disponible) desaparece en estas tres muestras. El fin del último recurso no es una medida de interacción ni un percentil de campo; no se promete ese tiempo para todas las redes, equipos o estados del proveedor.

La primera carga inmediatamente después de la promoción tuvo FCP de 812 ms y último recurso a 4119 ms. El observador de readiness agotó su plazo de herramienta; al leer el estado después, la página estaba lista, todas las APIs eran `200` y no había errores de consola. La caché del navegador se había restaurado antes de esa observación final, por lo que esta captura diagnóstica se registra separada de las tres recargas comparables.

Dos consultas, cuentas y configuración, duraron aproximadamente 2650 ms; las restantes APIs tardaron 116–394 ms. Los assets individuales tardaron 58–294 ms. Esta cola se concentra en las APIs, pero la captura no separa el inicio de instancia, conexión, espera de pool y consultas. La revisión independiente confirmó que función `gru1` y base Neon `sa-east-1` están en São Paulo ([Vercel](https://vercel.com/docs/regions), [AWS](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html)); el cliente Prisma ya se comparte por instancia y su pool está limitado. La consulta acotada del CLI de Vercel no expuso estados HTTP, duraciones o spans de inicio, y alcanzó su límite de registros; tampoco permite atribuir la demora ni calcular una tasa global de errores. No se cambia región, pool ni arquitectura por un único outlier sin atribución. La medición de una primera carga prolongada se conserva y no se oculta dentro de una mediana.

Tras la promoción se repitieron el diálogo de pedido sin enviar datos (Escape cierra y devuelve el foco), el menú a 390×844 (cierre con Escape y foco correcto, ancho de página 375 px), y la vista de escritorio sin animaciones activas al asentarse ni errores de consola. Los hashes de usuarios y permisos y los conteos de hechos de negocio permanecen iguales al preflight. No se habilitaron autoridades comerciales.

Evidencia privada nueva: `loader-candidate-verification.json`, `loader-published-verification.json`, `loader-ci.log`, `loader-production-cold-run.json`, `loader-production-runs.json`, `loader-production-desktop.png`, `loader-production-mobile.png` y `state-published-final.json`. La vuelta inmediata de código puede usar el deployment previamente verificado `dpl_EzxszCWGuX9oNFVntdZgN1kkmz3v`; no exige revertir el índice aditivo. Los cambios documentales posteriores no alteran el fingerprint de fuentes runtime publicado.

# Publicación de rendimiento y experiencia — 6 de octubre de 2026

Esta entrega publica las mejoras de interfaz, interacción y rendimiento ya verificadas localmente. Conserva el circuito en sombra: no aprueba saldos reales, no habilita operaciones comerciales ni apaga el sistema anterior. La aceptación de Tiziano, la conciliación histórica, los dispositivos reales y la recuperación fuera del host siguen siendo requisitos del traspaso.

## Correcciones adicionales para producción

La consulta del resumen de contribución con fechas válidas devolvía `400 INVALID_REPORT_QUERY` en la versión publicada. La inspección autenticada de Vercel mostró la regla efectiva `/api/... → /api?path=$1`: la captura nombrada añadía `path` a la query y el contrato estricto del informe rechazaba ese campo. La regla ahora usa una captura sin nombre (`/api/(.*)`), que el compilador de rutas de Vercel no convierte en un parámetro adicional. Se conserva la validación de fechas, alias, campos desconocidos y parámetros repetidos. La verificación final debe comprobar la ruta compilada y el informe publicado, no sólo Express local.

Un `401` en cualquier lectura o comando de la consola invalida inmediatamente el contexto, cierra la acción y elimina los avisos anteriores. Un `403` de una acción concreta conserva la sesión, y un fallo de red o del servidor sigue siendo recuperable. El recorrido de navegador reprodujo el defecto antes del cambio: el GET de catálogo respondió `401` real y la consola anterior quedó visible.

La resolución transitiva de compilación `source-map-js` pasa de 1.2.1 a 1.2.2 para corregir GHSA-68fv-2mgg-jv7q. El cambio afecta sólo su entrada del lockfile, dentro del rango compatible de PostCSS; no actualiza el framework ni la base. `npm audit` queda sin hallazgos.

## Base y recuperación de esta entrega

El preflight autenticado encontró PostgreSQL 18.6, 31 migraciones completas y cero pedidos. Sólo estaba pendiente `202610060001_operation_order_confirmed_at_lookup`. Antes de aplicarla se creó un `pg_dump` cifrado con AES-256-GCM y clave independiente, se restauró en una base local aislada y se comparó el estado. La base de ensayo se eliminó tras la comprobación. El índice quedó presente, listo y válido, y la migración terminó correctamente.

Los hashes de cuentas y permisos y los conteos de pedidos, documentos, hechos de stock y asientos permanecieron iguales antes y después. Este respaldo puntual de base no certifica el respaldo automático de objetos ni la recuperación fuera del host.

La versión anterior confirmada por el dominio es `dpl_BfEQm1AZEZUUvUjkuibUcq93Mxhw`. El índice es aditivo y compatible con esa versión; volver al código anterior no requiere borrar datos ni retirar el índice.

## Evidencia

Las mediciones locales y sus límites están en [performance-2026-10-06.md](performance-2026-10-06.md). El candidato de publicación debe vincular commit, `sourceHash`, CI, deployment y alias del dominio. Los artefactos privados de respaldo y preflight quedan en `.local/production-release-2026-10-06/`, excluidos de Git y de la publicación.

El primer intento sin alias quedó `BLOCKED` por la identidad Git local terminada en `.local`; no se publicó. El candidato final usa la identidad verificada de la cuenta propietaria, sin cambiar miembros ni permisos de Vercel. No conserva diagnósticos temporales de query.

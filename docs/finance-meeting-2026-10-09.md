# Finanzas para la reunión del 9 de octubre

La entrada es **Finanzas → Reportes** en `/app/finanzas`. El reporte usa las fuentes canónicas de operaciones y conserva las herramientas del local en **Resumen local**, **Caja** y **Planificación**.

La [migración AppSheet y operación manual](appsheet-migration-2026-10-09.md) registra el archivo empresarial, las funciones recuperadas y los requisitos todavía pendientes para activar el local.

## Recorrido

1. Elegir el período y la moneda; actualizar el reporte.
2. Revisar **Estado de resultados**: ventas netas, costo histórico de lo vendido, gastos devengados y resultado. Una compra de stock y un pago no son automáticamente un gasto del período.
3. Revisar **Flujo de efectivo**: dinero que entró y salió, transferencias, financiación y saldos cuando haya apertura y conciliación respaldadas. La caja y el resultado responden preguntas distintas.
4. Revisar los vencimientos de **13 semanas** y los supuestos del escenario de resultado. Los vencimientos conocidos no representan todas las obligaciones; un escenario no garantiza ventas futuras.
5. Leer la cobertura y los pendientes antes de usar cualquier cifra para decidir.

## Datos observados en producción

**Actualización del 9 de octubre:** se cargó la fuente financiera real del Excel: 3.693 filas conservadas, 3.629 elegibles y 64 excluidas. La carga se repitió sin duplicados y una consulta de producción verificó los 22 controles independientes por mes y moneda. La fuente está en preparación, sin aprobación humana ni publicación de hechos canónicos. Ver [carga, conciliación y evidencia](finance-sources-2026-10-09.md). Los conteos vacíos que siguen describen las observaciones anteriores a esa carga.

El 8 de octubre a las 21:59 ART se ejecutó una consulta PostgreSQL en una transacción `READ ONLY`, con la configuración del proyecto Vercel `bombo`. La base canónica devolvió cero pedidos confirmados, cuentas activas, aperturas aprobadas, movimientos de libro, conciliaciones, obligaciones, hechos históricos, publicaciones históricas, lotes de importación y coberturas de período aprobadas. También devolvió cero ventas, gastos, movimientos y planes en las tablas del local.

Esto verifica ausencia de registros en esa base al consultar. No demuestra que el negocio no haya vendido ni gastado: sus fuentes externas todavía no están publicadas ahí. No se crearon hechos de negocio para probar las funciones.

La consulta de conteos se repitió en modo `READ ONLY` después del despliegue, a las 22:48 ART, y mantuvo cero registros tanto en las fuentes canónicas como en las tablas financieras del local.

La revisión de los archivos recibidos encontró que las fechas operativas principales del XLSX llegan al 30 de septiembre y los cobros al 29. No se observaron hechos del 1 al 8 de octubre en las hojas operativas examinadas; las filas futuras no acreditan actividad ocurrida. La fecha de actualización del modelo PBIX no pudo verificarse. El lector del XLSX detectó encabezados ambiguos y solapamientos entre hojas que necesitan un mapeo revisado antes de publicar hechos históricos.

## Qué hace falta para cerrar números

- Ventas del local y delivery hasta una fecha de corte acordada, con descuentos, devoluciones y costos históricos de lo vendido.
- Gastos devengados y obligaciones con período, moneda y vencimiento; evitar volver a sumar el pago de un gasto ya registrado.
- Cuentas y saldos iniciales respaldados, movimientos y conciliaciones independientes.
- Importación y revisión de las fuentes, con cobertura del período. Los archivos históricos por sí solos no prueban el cierre actual.

Si falta cobertura, el reporte conserva los subtotales observados y deja el resultado o saldo completo pendiente. No convierte la ausencia de datos en una ganancia, saldo o pronóstico igual a cero.

## Evidencia de entrega

El adaptador se consultó en una transacción de lectura contra la base real: el período del 1 al 8 de octubre conserva importes y saldos nulos, cobertura desconocida y escenario deshabilitado. La fuente financiera del Excel se cargó después y sus 22 controles por mes y moneda coinciden. Esto no completa los datos del período actual ni acredita una sesión HTTP autenticada.

Las pruebas locales del reporte verificaron una base completa sintética y cobertura incompleta, monedas ARS/USD, fechas en `Pacific/Kiritimati`, selección del último mes y anchos reales 1280/390 sin desbordamiento. El navegador usa API real y PostgreSQL descartable; los datos sintéticos permanecen aislados de producción.

El CI del commit `9c50ca0a345ae522ba734b352c1ae73e38ad487f` pasó en los runs [push 37878428379](https://github.com/Gigisanta/Club-Canabico/actions/runs/37878428379) y [PR 37878432888](https://github.com/Gigisanta/Club-Canabico/actions/runs/37878432888): 279 pruebas de código, 52 recorridos de navegador y 13 controles sin conexión, sin fallos ni omisiones. También pasaron typecheck, build, restore e imágenes de contingencia y backup. Esa evidencia corresponde al reporte y la fuente financiera; la ampliación manual y empresarial tiene sus controles separados en [Migración AppSheet](appsheet-migration-2026-10-09.md).

## Release y límites actuales

El release actual está publicado en [bombo.maat.work](https://bombo.maat.work/app/finanzas), en el despliegue `dpl_BY98m5SQNsPRqGvrKFdiDsZ3yKvn`, `READY`, correspondiente al código `cf6124e`. Integra el reporte financiero, la recuperación de operación manual y la corrección de repetición del archivo de origen. La verificación pública de las 06:11 UTC contrastó sus 281 fuentes con el código local: coinciden las 280 fuera de la configuración de Vercel y se verificaron exactamente los dos campos agregados por la CLI. El dominio identifica ese mismo despliegue, usa Node 24 y devuelve `demo: false`; cuatro endpoints privados rechazan una sesión ausente con `401` y `no-store`. Ambos CI completos del código publicado terminaron aprobados. Los runs, hashes y límites están en [Migración AppSheet](appsheet-migration-2026-10-09.md).

Además de la fuente financiera, se cargaron 17.695 filas empresariales de 32 tablas como archivo de origen, con excepciones y trazabilidad. No se suman al conteo financiero: ambos archivos contienen movimientos solapados. El acceso HTTP con una cuenta real sigue pendiente. La base operativa sigue en `shadow`: hacen falta acceso a la definición de AppSheet, mapeo revisado, aperturas y costos respaldados y el corte operativo. No se certifica el cierre financiero ni la migración completa mientras esos requisitos falten.

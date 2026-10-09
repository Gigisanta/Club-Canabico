# Finanzas para la reunión del 9 de octubre

La entrada es **Finanzas → Reportes** en `/app/finanzas`. El reporte usa las fuentes canónicas de operaciones y conserva las herramientas del local en **Resumen local**, **Caja** y **Planificación**.

## Recorrido

1. Elegir el período y la moneda; actualizar el reporte.
2. Revisar **Estado de resultados**: ventas netas, costo histórico de lo vendido, gastos devengados y resultado. Una compra de stock y un pago no son automáticamente un gasto del período.
3. Revisar **Flujo de efectivo**: dinero que entró y salió, transferencias, financiación y saldos cuando haya apertura y conciliación respaldadas. La caja y el resultado responden preguntas distintas.
4. Revisar los vencimientos de **13 semanas** y los supuestos del escenario de resultado. Los vencimientos conocidos no representan todas las obligaciones; un escenario no garantiza ventas futuras.
5. Leer la cobertura y los pendientes antes de usar cualquier cifra para decidir.

## Datos observados en producción

El 8 de octubre a las 21:59 ART se ejecutó una consulta PostgreSQL en una transacción `READ ONLY`, con la configuración del proyecto Vercel `bombo`. La base canónica devolvió cero pedidos confirmados, cuentas activas, aperturas aprobadas, movimientos de libro, conciliaciones, obligaciones, hechos históricos, publicaciones históricas, lotes de importación y coberturas de período aprobadas. También devolvió cero ventas, gastos, movimientos y planes en las tablas del local.

Esto verifica ausencia de registros en esa base al consultar. No demuestra que el negocio no haya vendido ni gastado: sus fuentes externas todavía no están publicadas ahí. No se crearon hechos de negocio para probar las funciones.

La revisión de los archivos recibidos encontró que las fechas operativas principales del XLSX llegan al 30 de septiembre y los cobros al 29. No se observaron hechos del 1 al 8 de octubre en las hojas operativas examinadas; las filas futuras no acreditan actividad ocurrida. La fecha de actualización del modelo PBIX no pudo verificarse. El lector del XLSX detectó encabezados ambiguos y solapamientos entre hojas que necesitan un mapeo revisado antes de publicar hechos históricos.

## Qué hace falta para cerrar números

- Ventas del local y delivery hasta una fecha de corte acordada, con descuentos, devoluciones y costos históricos de lo vendido.
- Gastos devengados y obligaciones con período, moneda y vencimiento; evitar volver a sumar el pago de un gasto ya registrado.
- Cuentas y saldos iniciales respaldados, movimientos y conciliaciones independientes.
- Importación y revisión de las fuentes, con cobertura del período. Los archivos históricos por sí solos no prueban el cierre actual.

Si falta cobertura, el reporte conserva los subtotales observados y deja el resultado o saldo completo pendiente. No convierte la ausencia de datos en una ganancia, saldo o pronóstico igual a cero.

## Evidencia de entrega

El adaptador del reporte se ejecutó a las 22:11 ART contra la base de producción en una transacción de lectura, sin pasar por una sesión HTTP autenticada. Para el 1–8 de octubre devolvió resultado, efectivo y obligaciones con estado desconocido, importes y saldos nulos y escenario deshabilitado. La consulta confirma el comportamiento ante la base vacía y la compatibilidad de las consultas con ese esquema; no acredita un recorrido autenticado.

La revisión independiente del código cerró sin hallazgos materiales. Las cuatro pruebas focalizadas del adaptador pasaron, incluida una base completa sintética para un mes cerrado y los casos de cobertura incompleta. Los resultados del control completo, navegador y despliegue se agregan al terminar el release. Un build, un Preview o una pantalla pública de acceso no prueban un recorrido autenticado en producción ni la conciliación financiera real.

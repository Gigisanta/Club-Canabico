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

La consulta de conteos se repitió en modo `READ ONLY` después del despliegue, a las 22:48 ART, y mantuvo cero registros tanto en las fuentes canónicas como en las tablas financieras del local.

La revisión de los archivos recibidos encontró que las fechas operativas principales del XLSX llegan al 30 de septiembre y los cobros al 29. No se observaron hechos del 1 al 8 de octubre en las hojas operativas examinadas; las filas futuras no acreditan actividad ocurrida. La fecha de actualización del modelo PBIX no pudo verificarse. El lector del XLSX detectó encabezados ambiguos y solapamientos entre hojas que necesitan un mapeo revisado antes de publicar hechos históricos.

## Qué hace falta para cerrar números

- Ventas del local y delivery hasta una fecha de corte acordada, con descuentos, devoluciones y costos históricos de lo vendido.
- Gastos devengados y obligaciones con período, moneda y vencimiento; evitar volver a sumar el pago de un gasto ya registrado.
- Cuentas y saldos iniciales respaldados, movimientos y conciliaciones independientes.
- Importación y revisión de las fuentes, con cobertura del período. Los archivos históricos por sí solos no prueban el cierre actual.

Si falta cobertura, el reporte conserva los subtotales observados y deja el resultado o saldo completo pendiente. No convierte la ausencia de datos en una ganancia, saldo o pronóstico igual a cero.

## Evidencia de entrega

El adaptador del reporte se ejecutó a las 22:11 ART contra la base de producción en una transacción de lectura, sin pasar por una sesión HTTP autenticada. Para el 1–8 de octubre devolvió resultado, efectivo y obligaciones con estado desconocido, importes y saldos nulos y escenario deshabilitado. La consulta confirma el comportamiento ante la base vacía y la compatibilidad de las consultas con ese esquema; no acredita un recorrido autenticado.

La revisión independiente del código cerró sin hallazgos materiales. Las cuatro pruebas focalizadas del adaptador pasaron, incluida una base completa sintética para un mes cerrado y los casos de cobertura incompleta.

En el commit `3bf190b`, `npm run check` terminó con 275 pruebas aprobadas, cero fallidas y una omitida: el ensayo de restore requiere una base dedicada y opt-in, que no estaban configurados en esa ejecución local. Se usaron Node 24.19 y PostgreSQL 18.6 en una base desechable, preparando el build antes del control por la dependencia de las pruebas de backup en `dist-server`. La verificación de navegador focalizada pasó 9/9. El commit `8991147` sólo agregó una traducción de metodología; sobre él se repitió el caso financiero y pasó 1/1.

El navegador local consultó la API real con datos sintéticos y verificó los importes nulos del período sin respaldo, las monedas ARS/USD, fechas en `Pacific/Kiritimati`, el acceso a las vistas previas y los anchos reales de escritorio y móvil, sin desbordamiento horizontal. Las capturas finales fueron inspeccionadas. Esto acredita la interfaz y la consulta local; no sustituye los datos reales ni una sesión autenticada en producción.

Después de adaptar los selectores de los recorridos anteriores al nuevo acceso y los textos actuales, el archivo completo `tests/browser/club.spec.ts` pasó 13/13, exit 0, en 1,2 minutos. Se mantuvieron las comprobaciones de importes, categorías, persistencia, preparación de saldos, planificación y punto de equilibrio. El contenido probado quedó incorporado en `47e0afb`. El runner eliminó sus esquemas; se comprobaron cero esquemas residuales y se detuvo únicamente el PostgreSQL 18 temporal de QA.

El CI final pasó en los runs [push 37870431872](https://github.com/Gigisanta/Club-Canabico/actions/runs/37870431872) y [PR 37870435791](https://github.com/Gigisanta/Club-Canabico/actions/runs/37870435791), sobre `47e0afb812f5d20fc6acede3550c7891902750ef`: 278 pruebas de código aprobadas, cero fallidas y cero omitidas; 51 recorridos de navegador; 13 controles sin conexión. También pasaron el ensayo de restore y los ejercicios de los contenedores de contingencia y backup, incluidos sus controles de configuración y limpieza. Node fue 24.14.1 y PostgreSQL 18. La huella de fuentes coincidió en el build y ambas imágenes.

Un build, un Preview o una pantalla pública de acceso no prueban un recorrido autenticado en producción ni la conciliación financiera real.

## Release en producción

El código de la aplicación está en `8991147e275204e4a831ceb8b22c2e68e66709ee`. Los commits de pruebas hasta `47e0afb812f5d20fc6acede3550c7891902750ef` sólo agregan tres selecciones explícitas de **Resumen local** y actualizan el nombre de la acción para agregar una partida en dos pruebas existentes, porque **Reportes** es ahora la entrada inicial de Finanzas; conservan las comprobaciones de datos, preparación de saldos y punto de equilibrio. Las primeras dos selecciones fueron revisadas por otro agente, sin hallazgos abiertos; la tercera y el nombre de la acción fueron contrastados por el integrador, que no escribió la prueba, con los consumidores actuales.

El despliegue `dpl_3GRFpuxS6VHZwQ8f8KXUzfewn4Wb` quedó `READY` y fue promovido a [bombo.maat.work](https://bombo.maat.work/app/finanzas). La huella local y de CI es `4ee1487602b0b3280e6916bb01c0fd77c9fcd4851ea50102e0f3fe49e1ed7b67` y la de Vercel es `a1dda1311217e6ef140c9bda1ccf740807a55c5880800e4828675bdfa3722240`. Se compararon las 267 entradas: las 266 fuera de `vercel.json` coinciden exactamente. La única diferencia de configuración corresponde a `name: "bombo"` y `version: 2`, agregados por la CLI; todos los campos originales conservan su digest y el hash canónico de esa configuración extendida coincide con Vercel. No se aplicaron migraciones.

A las 22:46 ART del 8 de octubre se verificó el dominio público: su manifest de 267 fuentes coincide con el despliegue preparado, el runtime de build es Node 24.21.0, `/api/config` devuelve `demo: false` y el endpoint financiero devuelve `401` sin sesión y `Cache-Control: no-store`. La inspección de Vercel del dominio identifica ese mismo despliegue `READY`.

La consulta de base de datos descrita arriba verifica el lector real; no se creó una sesión ni se modificaron credenciales para presentar una validación autenticada. El acceso con una cuenta real y la importación/conciliación de los datos del negocio siguen pendientes.

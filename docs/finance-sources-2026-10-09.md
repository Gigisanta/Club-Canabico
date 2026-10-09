# Carga y conciliación de fuentes financieras

## Fuente y alcance

La fuente recibida es el Excel `2025_PP_Appsheet_TB (2).xlsx`, SHA-256 `a22fdd096af1e5cdc3986a2bcc51d917d9bd6764f79bcdba5c1e112820488ca2`. La carga selecciona exclusivamente `Movimiento_Nueva`, usando `ID_Movimiento_Unique` como clave. No extrae ni persiste registros de hojas de usuarios o autenticación; la biblioteca XLSX abre el libro completo en memoria. La hoja antigua `Movimiento` contiene 274 movimientos superpuestos y no se suma de nuevo.

Se conservan las 3.693 filas con su posición, clave, contenido original y normalizado, huella del archivo y versión del lector. Un cálculo independiente con Python Decimal/openpyxl y el lector de la aplicación deben coincidir en los 22 agregados mensuales separados entre ARS y USD. No se convierte ni se suma entre monedas.

Con corte técnico inclusivo al 8 de octubre de 2026, son elegibles 3.629 filas; quedan excluidas 64: 61 fechas ausentes o inválidas, una fecha posterior al corte, un monto de tipo texto y una caja vacía. La última fecha elegible es el 30 de septiembre. No hay movimientos elegibles del 1 al 8 de octubre en esta fuente.

## Qué representa la conciliación

La conciliación técnica compara la huella declarada del archivo, el alcance, la fecha de corte, las filas cargadas/elegibles/excluidas y las entradas, salidas y diferencia de cada mes y moneda contra un manifiesto independiente. El reporte no recalcula la integridad de cada contenido original; la repetición de la carga verifica esas filas contra el mismo archivo. La fuente permanece en preparación (`staged`), con `reviewedBy` y `reviewedAt` nulos.

Estos movimientos permiten revisar lo que dice el Excel. No prueban ventas, cobros, gastos devengados, utilidad, saldos bancarios o de caja, cobertura comercial completa ni aprobación humana. La carga no crea asientos de libro, aperturas, obligaciones, hechos históricos publicados ni coberturas aprobadas. El reporte canónico mantiene pendiente aquello que no tenga respaldo.

Las facturas y sus detalles no se suman entre sí; una factura no prueba una cobranza. Los gastos sin moneda, las entregas sin fecha y los costos históricos pendientes requieren mapeo y revisión. El PBIX recibido aporta una referencia visual, pero no se verificó su actualización ni se extrajeron sus medidas; no se usa como control financiero independiente.

## Recorrido en Bombo

En **Finanzas → Reportes → Fuentes cargadas**, los perfiles con lectura financiera, lectura de informes y revisión de importaciones ven la conciliación técnica, los conteos, las causas de exclusión y los importes por período y moneda. **Ver último período con datos** selecciona el mes observado más reciente; conserva los demás filtros y no activa escenarios ni aprueba datos.

El corte de la fuente se mantiene en la fecha del manifiesto. El paso al día siguiente no cambia silenciosamente su control. Pedir otro corte explícito produce un control pendiente cuando no coincide con el manifiesto; no se acepta un corte futuro. Varios archivos potencialmente superpuestos se muestran separados, sin total combinado.

## Operación y repetición

El CLI `scripts/financial-source-stage.ts` prepara por defecto una vista numérica sin conexión a la base. `--apply` exige que un manifiesto estricto coincida con la preparación y un paquete PostgreSQL 18 cifrado cuya integridad y migraciones se verifican con el CLI de backups existente. Obtener ese manifiesto mediante un cálculo independiente es un requisito del procedimiento: el CLI no verifica la identidad ni la independencia de quien lo calculó. En esta carga lo produjo otro agente con Python Decimal/openpyxl y se transcribió conservando sus 22 controles literales. Los secretos se suministran por entorno desde su fuente canónica; no aparecen en argumentos, documentación o salida.

La escritura usa una transacción Serializable para crear el lote, las filas, sus excepciones, el objeto y una auditoría de carga técnica. El actor `codex:financial-source-stage` identifica la operación administrativa y no suplanta una cuenta humana. No genera recibos de comandos, publicaciones ni aprobaciones. La guardia de fuentes técnicas mantiene este lote fuera de la revisión y publicación genéricas; una futura importación con interpretación propia conserva el recorrido de revisión independiente.

Repetir el mismo archivo, sistema y versión verifica cada fila y excepción almacenada contra la preparación y devuelve `already-staged`, sin duplicar la carga. Una alteración, un manifiesto diferente o una carga incompleta provoca rechazo. No se reparan ni se sobrescriben filas discrepantes automáticamente.

## Respaldo previo

Antes de la carga se creó y verificó un backup cifrado de producción el 9 de octubre a las 02:04 UTC (8 de octubre, 23:04 ART), con huella de manifiesto `d2127dadef88ce3d85868cd212d75c97b6cc4eab51d7e3e590a23d59c9cf3240`. El paquete y su clave quedan fuera de Git en ubicaciones privadas separadas. Es respaldo local; no certifica una copia fuera del host ni un restore de producción. La base observada antes de la carga no contenía movimientos financieros ni registros legados.

## Evidencia de entrega

En Node 24.19 y PostgreSQL 18.6 desechable, el ensayo focalizado de carga pasó: staging, repetición sin duplicados, rechazo del cambio de evidencia por el trigger de inmutabilidad, rechazo de manifiesto distinto y rollback completo ante un fallo tardío. `npm run check` terminó con 276 pruebas aprobadas, cero fallidas y una omitida (restore sin opt-in local), además de typecheck y build. El rechazo ante corrupción preexistente con el trigger omitido no tiene cobertura directa.

El archivo de navegador financiero pasó 2/2 casos tras los ajustes de fixture. La nueva prueba respalda el documento sintético real del rehearsal, carga un XLSX sintético, consulta la API autorizada y comprueba el rechazo sin sesión, los controles ARS/USD, las exclusiones, el filtro al último mes y los anchos reales 1280/390 sin desbordamiento de la página. Las capturas finales fueron inspeccionadas. El runner comparte una raíz privada desechable entre seed, API y backup y la elimina al terminar, junto al esquema temporal; se detuvo sólo el PostgreSQL dedicado.

La carga real terminó el 9 de octubre a las 02:54:48 UTC (8 de octubre, 23:54 ART): un lote en preparación, 3.693 filas y 64 excepciones. La repetición a las 02:55:47 UTC devolvió `already-staged`, conservando los mismos conteos y huellas. El snapshot es `financial-ef2cfb65b4d2303a2d550cebafd872429daf780dc164d61838f2261dd86eec10`; la huella del manifiesto de filas es `5fe5ce036911dc78b38425625f36d07f83233ea7d132d96269c1b4b4dfd40661`.

A las 02:59:17 UTC, una consulta de producción `READ ONLY` verificó igualdad exacta con los 22 controles independientes, 3.629 filas elegibles, 64 excluidas, corte al 8 de octubre y última fecha elegible el 30 de septiembre. Conservó cero movimientos de libro, aperturas, coberturas aprobadas, hechos históricos y publicaciones. La fuente sigue sin aprobación humana y el estado del período actual sigue desconocido.

El despliegue preparado de las fuentes financieras es `dpl_8PshRtnS4Jwjd1WR5w2QyejSzcvy`, `READY`. Su manifest tiene 273 entradas; las 272 fuera de `vercel.json` coinciden con el snapshot local del commit `cdd71ec`. La diferencia de configuración contiene únicamente `name: "bombo"` y `version: 2`, agregados por Vercel; se verificaron los campos y el hash canónico de la configuración extendida. Huella local `03e4426232898932f10108d2b6abaafee1957bd2d3a24a531cfc1aa8b6b35189`; huella remota `d00f8fad426e07e5fa86faab94d545376c3699b879640d3472bab1edb9833f5b`. El despliegue fue promovido al dominio después del CI completo. La inspección del dominio confirmó ese mismo ID `READY`, el manifest público coincide exactamente con el preparado, `/api/config` devuelve `demo: false` y el endpoint de fuentes devuelve `401` sin sesión con `Cache-Control: no-store`.

El primer CI detectó un guard de prueba incompatible con la configuración aislada del workflow: exigía ausencia de `DATABASE_URL`, aunque el workflow usa otra base distinta. El commit `92971c6` exige destinos PostgreSQL diferentes, normaliza alias de loopback y rechaza colisiones incluso con credenciales o esquema distintos. La prueba focal pasó 1/1 con una URL sintética de aplicación distinta; otro agente revisó la corrección sin hallazgos. No cambió el runtime publicado. El commit `9c50ca0` adaptó además el test al opt-in de restore del workflow, sin propagarlo al verificador de backup, y usa temporales propios en `os.tmpdir()`. Los runs [push 37878428379](https://github.com/Gigisanta/Club-Canabico/actions/runs/37878428379) y [PR 37878432888](https://github.com/Gigisanta/Club-Canabico/actions/runs/37878432888) pasaron: 279 pruebas de código, 52 recorridos de navegador y 13 controles sin conexión, sin fallos ni omisiones. También pasaron typecheck, build, restore e imágenes de contingencia y backup. La huella del build y ambas imágenes coincide con el snapshot local de 273 fuentes.

Una consulta directa a producción y un endpoint que rechaza una sesión ausente no sustituyen un recorrido HTTP con una cuenta real. Esta entrega no certifica todavía la migración de todos los módulos ni las reglas completas de AppSheet. El 9 de octubre se abrió la app real `Adm_TB-924511155`, versión visible `1.001737`, pero requiere su usuario y contraseña internos. El editor de la cuenta Google disponible muestra “No apps shared with you”; falta permiso para leer tablas, expresiones, acciones, vistas, bots y filtros de seguridad.

El alcance del archivo empresarial y de las funciones manuales se registra en [Migración AppSheet](appsheet-migration-2026-10-09.md).

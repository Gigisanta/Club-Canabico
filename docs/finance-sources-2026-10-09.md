# Fuentes financieras y control de origen

Actualizado el 9 de octubre de 2026 después del despliegue promovido y de la consulta de producción posterior. Separa las observaciones de los archivos de los datos que Bombo reconoce como negocio canónico. Los snapshots técnicos no son aprobaciones y no se deben sumar como si fueran hechos de contabilidad.

## Estado observado en producción

La consulta completa posterior a la promoción, en transacción `READ ONLY`, terminó el 9 de octubre a las 14:06:15.858 UTC (`readOnly=true`). Confirmó que se conservan 17.695 registros empresariales, 4.395 excepciones y 3.693 observaciones financieras. El control independiente de negocio y los 22 controles financieros por mes y moneda coincidieron exactamente.

En la misma consulta, catálogo, proveedores, ubicaciones, cuentas canónicas, aperturas, conciliaciones de cuenta, saldos de stock, movimientos de libro, hechos y publicaciones históricos y cobertura aprobada estaban en cero. La autoridad seguía en `shadow` y la aprobación operativa desactivada. La lectura no modificó la base ni las fuentes. La ausencia de registros en esas tablas no demuestra que el negocio no haya operado; significa que no están asentados allí con evidencia canónica.

## Fuente financiera del XLSX

Archivo: `2025_PP_Appsheet_TB (2).xlsx`, SHA-256 `a22fdd096af1e5cdc3986a2bcc51d917d9bd6764f79bcdba5c1e112820488ca2`.

La importación selecciona sólo `Movimiento_Nueva`, con `ID_Movimiento_Unique` como clave. La hoja anterior `Movimiento` tiene 274 movimientos superpuestos y no se suma de nuevo. El snapshot `financial-ef2cfb65b4d2303a2d550cebafd872429daf780dc164d61838f2261dd86eec10` conserva 3.693 filas; 3.629 son elegibles al corte técnico inclusivo del 8 de octubre y 64 están excluidas: 61 con fecha ausente o inválida, una posterior al corte, una con monto de texto y una con caja vacía. La última fecha elegible es el 30 de septiembre. No hay movimientos elegibles del 1 al 8 de octubre en esta fuente.

La conciliación compara la huella, el alcance, el corte, filas elegibles/excluidas e ingresos/egresos por cada mes y moneda contra un cálculo independiente con Python Decimal/openpyxl. Los 22 controles ARS/USD coinciden exactamente; no se convierten ni se suman monedas. Una repetición real respondió `already-staged` con los mismos conteos y huellas, sin duplicar datos.

El snapshot está en preparación (`staged`), sin revisión humana. Conserva filas originales y normalizadas, posiciones, hash, versión del lector y excepciones. La carga no crea movimientos de libro, saldos de apertura, obligaciones, hechos históricos publicados ni cobertura aprobada. No certifica ventas, cobros, gastos devengados, utilidad, efectivo disponible o integridad de todo el período.

También se recibió `2026.06.ADMTB_Reporte.pbix`. Sirve como referencia del modelo visual, pero no se verificaron su actualización ni sus medidas contra la aplicación viva; no se usa como conciliación independiente.

## Archivo empresarial AppSheet en XLSX

El mismo XLSX contiene 39 hojas. El snapshot `appstage_8fd1f089d5956adc993997df4931c2fbf6932f82ce78edd6493d16c8ac72c480` conserva 17.695 filas de 32 tablas como `archive_only`, con 4.395 excepciones, cero filas en cuarentena y cero omitidas por etiquetas. Se mantienen separadas de la fuente financiera: los archivos se solapan.

Seis hojas sin encabezados suficientes sólo aparecen en la cobertura técnica por nombre y dimensión: `Form_Stockxdíavariedad`, `Array`, `Movimiento_Diario`, `stc`, `Hoja18` y `Extras`. No se declaran extraídas. La carga no extrae ni persiste los registros de usuarios/autenticación. La biblioteca XLSX abre el libro completo en memoria antes de filtrar las hojas permitidas; la restricción evita extraer y guardar esas filas, pero no aísla la lectura del archivo.

Las filas siguen siendo evidencia fuente. No crean socios activos, productos, ventas, saldos, costos, asientos o publicaciones. Las fórmulas se preservan como definiciones y no se evalúan como operaciones reales. No se corrigen filas o excepciones del snapshot original.

## Revisión y seguimiento en la UI

En producción están disponibles **[Datos cargados](https://bombo.maat.work/app/operations?section=sources)** para buscar fuentes, revisar tablas y filas, paginar excepciones y registrar seguimiento auditable separado, y **[Finanzas](https://bombo.maat.work/app/finanzas)** para las vistas financieras. El seguimiento sólo agrega un registro nuevo con responsable, estado y nota: no edita el XLSX ni sus filas, no aprueba ni resuelve la fuente y no publica operaciones canónicas.

La release promovida es `dpl_2nmY3CSW2fziPES1hVdtVwNusowk`, con runtime commit `58373c1228c5412638ee78ca28639b587b9c76ed`. La inspección de Vercel resolvió explícitamente el dominio de producción a ese mismo deployment en estado `READY`. Su URL de etapa es [bombo-9ya2skcy2-giolivos-projects.vercel.app](https://bombo-9ya2skcy2-giolivos-projects.vercel.app). La comprobación pública de `https://bombo.maat.work` el 9 de octubre a las 14:02:04.203 UTC identificó ese release: 288 archivos, 287 idénticos al preparado; la única diferencia fue `vercel.json` con los campos exactos agregados por la CLI de Vercel. Huella remota `4d0ae81d2d92a876039bd50aef7305ac1df1189a1f832dadb40f45ec15878b43`, Node 24.21, `demo: false`; siete rutas privadas devolvieron `401` y `no-store` sin sesión.

La UI financiera debe distinguir períodos incompletos y saldos ausentes como pendientes. Los movimientos observados del XLSX pueden apoyar el análisis del archivo, pero no autorizan por sí solos una proyección completa ni se deben presentar como saldo inicial o conciliación bancaria.

## Acceso a la definición viva

A las 13:19 UTC del 9 de octubre, el editor oficial [`/home/apps`](https://www.appsheet.com/home/apps) mostró “No apps shared with you”. El runtime de la app [`Adm_TB`](https://www.appsheet.com/start/5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0) pidió usuario y contraseña internos. No se ingresaron credenciales ni se modificó AppSheet; la definición sigue sin acceso desde la sesión actual. En consecuencia, quedan por verificar expresiones, `Valid_If`, acciones agrupadas, vistas, bots, permisos, filtros de seguridad y orden real de formularios. AppSheet documenta que el propietario puede compartir una definición como [View/copy app](https://support.google.com/appsheet/answer/10104983?hl=en); la exportación de metadatos de administración no sustituye esa definición ni sus filas.

Las búsquedas acotadas en el Drive conectado no devolvieron archivos de definición o materiales adicionales de la app. Ese resultado describe el alcance de esa cuenta y esas búsquedas; no demuestra que no existan archivos en otra unidad o cuenta.

## Evidencia técnica y límites

`npm run check` local terminó con typecheck/build y 296 pruebas aprobadas; una prueba de restauración se omitió porque requiere opt-in local. Huella del build final: `a4182137a316bc3f29340ee0b396fee73da6ba93a16819c2a779f86ba4129777`. Los recorridos de navegador afectados (nueve existentes y el nuevo de fuentes) pasaron; el caso nuevo confirmó el uso de búsqueda/paginación y seguimiento, y la vista financiera se verificó a 390 px sin desbordamiento, con trece semanas en ARS/USD y saldos pendientes cuando falta una apertura. La revisión independiente cerró con cero defectos.

Los CI del [PR 37939766654](https://github.com/Gigisanta/Club-Canabico/actions/runs/37939766654) y del [push 37939758869](https://github.com/Gigisanta/Club-Canabico/actions/runs/37939758869) terminaron en `SUCCESS`. El run del PR pasó con 299 pruebas de código, cero omisiones y cero fallos, 58 recorridos de navegador, 13 controles offline, restore e imágenes de contingencia/backup.

La comprobación pública sin sesión validó el release y las rutas privadas. El navegador real abrió `/app/finanzas` y llegó a la pantalla de acceso; no había sesión autenticada, así que la aceptación de punta a punta con una cuenta humana en producción sigue pendiente. No se ingresaron credenciales.

Las métricas no implican cierre completo. El estado de resultados operativo usa entregas, costos de lote y gastos canónicos; las observaciones del XLSX no se toman como ventas. El flujo requiere aperturas de cuenta y cierres conciliados. La vista de trece semanas contiene sólo obligaciones/supuestos registrados, sin ingresos ni saldo final proyectados. La cobertura completa de vencimientos sigue pendiente: el esquema actual no admite la constancia `payables` que consulta el reporte. El contexto sigue en `shadow`, sin datos canónicos y con activación operativa pendiente.

La preparación y aplicación real de ambas fuentes tuvieron manifiestos y backups previos; los backups y sus claves permanecen fuera de Git. La evidencia de CI anterior corresponde al release previo, y no sustituye la evidencia nueva indicada arriba.

La última lectura de producción indicada al inicio sólo consultó conteos y controles agregados en modo lectura. No consultó ni reproduce filas privadas en este documento. Para la preparación financiera y el contexto de la reunión, ver [Finanzas para Tiziano](finance-meeting-2026-10-09.md). El alcance empresarial, los controles manuales y el corte pendiente están en [Migración AppSheet](appsheet-migration-2026-10-09.md).

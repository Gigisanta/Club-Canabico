# Fuentes financieras y control de origen

Actualizado el 9 de octubre de 2026. Separa las observaciones de los archivos de los datos que Bombo reconoce como negocio canónico. Los snapshots técnicos no son aprobaciones y no se deben sumar como si fueran hechos de contabilidad.

## Estado observado en producción

Una consulta de producción en transacción `READ ONLY` terminó el 9 de octubre a las 13:06:59 UTC (`readOnly=true`). Confirmó un archivo empresarial con 17.695 registros y 4.395 excepciones; la fuente financiera tiene 3.693 registros. El control independiente de negocio y los 22 controles financieros por mes y moneda coincidieron exactamente.

En la misma consulta, catálogo, proveedores, ubicaciones, cuentas canónicas, aperturas, saldos de stock, movimientos de libro, hechos y publicaciones históricos y cobertura aprobada estaban en cero. La lectura no modificó la base ni las fuentes. La ausencia de registros en esas tablas no demuestra que el negocio no haya operado; significa que no están asentados allí con evidencia canónica.

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

En el worktree se está preparando el recorrido **Datos cargados** (`/app/operations?section=sources`) para buscar fuentes, revisar tablas y filas, paginar excepciones y registrar seguimiento auditable separado. También está el recorrido **Finanzas** (`/app/operations?section=finance`) para las vistas financieras. El seguimiento sólo agrega un evento/objeto nuevo con responsable, estado y nota: no edita el XLSX ni sus filas, no aprueba ni resuelve la fuente y no publica operaciones canónicas.

Estos cambios de interfaz/API aún no pasaron QA final ni están desplegados. La producción comprobada sigue en `dpl_BY98m5SQNsPRqGvrKFdiDsZ3yKvn` (`cf6124e`). La navegación de esta sección es una ruta del código en preparación, no una pantalla que ya se pueda dar por disponible en el dominio.

La UI financiera debe distinguir períodos incompletos y saldos ausentes como pendientes. Los movimientos observados del XLSX pueden apoyar el análisis del archivo, pero no autorizan por sí solos una proyección completa ni se deben presentar como saldo inicial o conciliación bancaria.

## Acceso a la definición viva

A las 13:19 UTC del 9 de octubre, el editor oficial [`/home/apps`](https://www.appsheet.com/home/apps) mostró “No apps shared with you”. El runtime de la app [`Adm_TB`](https://www.appsheet.com/start/5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0) pidió usuario y contraseña internos. No se ingresaron credenciales ni se modificó AppSheet; la definición sigue sin acceso desde la sesión actual. En consecuencia, quedan por verificar expresiones, `Valid_If`, acciones agrupadas, vistas, bots, permisos, filtros de seguridad y orden real de formularios. AppSheet documenta que el propietario puede compartir una definición como [View/copy app](https://support.google.com/appsheet/answer/10104983?hl=en); la exportación de metadatos de administración no sustituye esa definición ni sus filas.

Las búsquedas acotadas en el Drive conectado no devolvieron archivos de definición o materiales adicionales de la app. Ese resultado describe el alcance de esa cuenta y esas búsquedas; no demuestra que no existan archivos en otra unidad o cuenta.

## Evidencia técnica y límites

La preparación y aplicación real de ambas fuentes tuvieron manifiestos y backups previos; los backups y sus claves permanecen fuera de Git. Las verificaciones de código y navegador aprobadas para el release `cf6124e` corresponden al código que ya estaba publicado, con PostgreSQL 18 descartable y datos sintéticos. Ese CI aprobó 298 pruebas de código, 57 recorridos de navegador y 13 controles offline, más typecheck, build, restore e imágenes de contingencia/backup. No prueba los nuevos recorridos de fuentes/finanzas del worktree ni aceptación autenticada con una cuenta humana en producción.

La última lectura de producción indicada al inicio sólo consultó conteos y controles agregados en modo lectura. No consultó ni reproduce filas privadas en este documento. Para la preparación financiera y el contexto de la reunión, ver [Finanzas para Tiziano](finance-meeting-2026-10-09.md). El alcance empresarial, los controles manuales y el corte pendiente están en [Migración AppSheet](appsheet-migration-2026-10-09.md).

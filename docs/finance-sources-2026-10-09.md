# Fuentes financieras y control de origen

Actualizado el 9 de octubre de 2026 con la promoción del runtime `e977c6c` y sus verificaciones públicas y `READ ONLY` posteriores a las 15:41 UTC. Separa las observaciones de los archivos de los datos que Bombo reconoce como negocio canónico. Los snapshots técnicos no son aprobaciones y no se deben sumar como si fueran hechos de contabilidad.

## Estado observado en producción

La consulta `READ ONLY` del 9 de octubre a las 14:43:12.107 UTC confirmó 17.695 registros empresariales, 4.395 excepciones y 3.693 observaciones financieras. El control independiente de negocio y los 22 controles financieros por mes y moneda coincidieron exactamente. Un respaldo cifrado de producción se verificó a las 14:46:06.260 UTC; no se incluyen rutas privadas, claves ni secretos.

En esa lectura, catálogo, proveedores, ubicaciones, cuentas canónicas, aperturas, conciliaciones de cuenta, saldos de stock, movimientos de libro, hechos y publicaciones históricos y cobertura aprobada estaban en cero. La base informó modo de autoridad `shadow`; por separado, la configuración canónica indicaba aprobación operativa desactivada. La lectura no modificó la base ni las fuentes. La ausencia de registros en esas tablas no demuestra que el negocio no haya operado; significa que no están asentados allí con evidencia canónica.

Después, a las 15:26:20.176 UTC, se aplicó en producción la migración de esquema para payables, checksum `557820008ffb55ce064f209832fb8fc3d0d422c321a4b0982fdfbe495a1c93fa`. El driver reutilizó el mismo respaldo cifrado, verificado a las 14:46:06.260 UTC; no creó otro. El resultado de la migración comprobó el manifiesto de integridad, los checksums, ambas constraints y que los conteos antes y después fueran exactamente iguales: fuentes 21.388, excepciones 4.459, constancias `attestations` 0, cuentas 0, libro 0, stock 0 y recibos de comandos (`commandReceipt`) 0. La migración agregó estructura; no creó obligaciones, saldos ni actividad de negocio.

La consulta post-promoción `READ ONLY` del 9 de octubre a las 15:41:02.270 UTC confirmó, mediante dos comparaciones independientes exactas, los conteos de negocio (17.695 registros, 4.395 excepciones) y financieros (3.693 filas); los 22 controles financieros mensuales por moneda también coincidieron. Catálogo, proveedores, ubicaciones, cuentas, aperturas, conciliaciones, stock, libro, historia y cobertura aprobada permanecieron en cero. La base informó modo de autoridad `shadow`; por separado, la configuración canónica informó el flag `false`. No hubo contexto de autenticación en vivo. La consulta verificó conteos, claves técnicas y manifiestos; este documento sólo presenta agregados y no reproduce filas privadas. La conciliación proyectó campos financieros de las filas fuente dentro de la base; no se consultaron datos de autenticación ni se crearon registros.

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

La release productiva es `dpl_3cxsEMxsiKuQpoS7LSj8AiRNXYQJ`, con runtime commit `e977c6c540c29996f2d3178aa23c83aea5f4487e`; la inspección del dominio `bombo.maat.work` resolvió explícitamente ese mismo deployment en estado `READY`. La verificación pública de las 15:41:00.216 UTC encontró 291 archivos, 290 idénticos byte por byte al artefacto local. La única diferencia fue `vercel.json`, con los campos `name` y `version` agregados por la CLI de Vercel; un verificador JavaScript comparó los hashes de esos campos. Huella local `ef88f73d65eb0455d03b9762933512f4a498a0539e7003661bb97a9f3b15daae`, huella remota `bf4eb2e951849960414103eb642102646def58e2b6e83b27738e05f64a23d807`, Node 24.21, `demo: false`; siete rutas privadas devolvieron `401` y `no-store` sin sesión.

La UI financiera debe distinguir períodos incompletos y saldos ausentes como pendientes. Los movimientos observados del XLSX pueden apoyar el análisis del archivo, pero no autorizan por sí solos una proyección completa ni se deben presentar como saldo inicial o conciliación bancaria.

### Código promovido a producción

El commit `e977c6c540c29996f2d3178aa23c83aea5f4487e` está promovido en el runtime productivo `dpl_3cxsEMxsiKuQpoS7LSj8AiRNXYQJ`. Agrega soporte para registrar manualmente una constancia de cobertura de obligaciones por pagar en Finanzas. El formulario/API registran sólo la constancia con UUID y permiten reintentar la misma solicitud sin duplicarla; no crean obligaciones/payables, cuya carga pertenece al circuito manual existente. La migración de esquema ya se aplicó en producción y pasó la verificación del checksum y ambas constraints. Cuando la constancia más reciente es parcial, invalida la cobertura previa en lugar de conservar una certificación obsoleta. No se creó ninguna constancia, obligación, asiento ni otro registro de negocio en este trabajo.

También incorpora una acción `AuthorityActivated` en Habilitación. El servidor sólo la acepta si se cumplen los 14 gates reales y la configuración la habilita. El control visible no aprueba gates ni activa operaciones por sí mismo; no se ejecutó esa acción ni se aprobaron gates. La lectura post-promoción de base de datos de las 15:41:02.270 UTC informó modo de autoridad `shadow`; por separado, la configuración canónica informó el flag `false`. No hubo contexto de autenticación en vivo.

El QA local del commit pasó: `npm run check` con 296 pruebas aprobadas, cero fallos y una omisión de restore por opt-in; fingerprint `ef88f73d65eb0455d03b9762933512f4a498a0539e7003661bb97a9f3b15daae`. También pasaron ocho recorridos focalizados de navegador y la revisión independiente sin bloqueantes. Los CI del [PR 37951713399](https://github.com/Gigisanta/Club-Canabico/actions/runs/37951713399) y del [push 37951706865](https://github.com/Gigisanta/Club-Canabico/actions/runs/37951706865) terminaron en `SUCCESS` para el SHA exacto `e977c6c`: cada uno pasó 299 pruebas de backend, 59 recorridos de navegador, 13 controles offline, restauración de PostgreSQL (1.676 ms en PR; 1.739 ms en push) y ejercicios de contingencia/configuración de backup, sin fallos ni omisiones.

## Acceso a la definición viva

A las 13:19 UTC del 9 de octubre, el editor oficial [`/home/apps`](https://www.appsheet.com/home/apps) mostró “No apps shared with you”. El runtime de la app [`Adm_TB`](https://www.appsheet.com/start/5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0) pidió usuario y contraseña internos. No se ingresaron credenciales ni se modificó AppSheet; la definición sigue sin acceso desde la sesión actual. En consecuencia, quedan por verificar expresiones, `Valid_If`, acciones agrupadas, vistas, bots, permisos, filtros de seguridad y orden real de formularios. AppSheet documenta que el propietario puede compartir una definición como [View/copy app](https://support.google.com/appsheet/answer/10104983?hl=en); la exportación de metadatos de administración no sustituye esa definición ni sus filas.

Las búsquedas acotadas en el Drive conectado no devolvieron archivos de definición o materiales adicionales de la app. Ese resultado describe el alcance de esa cuenta y esas búsquedas; no demuestra que no existan archivos en otra unidad o cuenta.

## Evidencia técnica y límites

La verificación pública del release y las rutas privadas no sustituye la aceptación autenticada de producción. El navegador real abrió `/app/finanzas` y mostró una pantalla de acceso vacía; no hubo sesión humana ni aceptación de punta a punta. No se ingresaron credenciales.

Las métricas no implican cierre completo. El estado de resultados operativo usa entregas, costos de lote y gastos canónicos; las observaciones del XLSX no se toman como ventas. El flujo requiere aperturas de cuenta y cierres conciliados. La vista de trece semanas contiene sólo obligaciones/supuestos registrados, sin ingresos ni saldo final proyectados. La constancia más reciente parcial invalida cobertura anterior; aun con el formulario ya desplegado, la constancia no certifica por sí sola que se incluyeron todas las obligaciones. La lectura post-promoción de las 15:41:02.270 UTC informó modo `shadow`, flag de configuración canónica `false` y datos canónicos en cero; no se activó autoridad ni se aprobaron gates.

La lectura de producción verificó conteos, claves técnicas y manifiestos; este documento sólo presenta agregados y no reproduce filas privadas. La conciliación proyectó campos financieros de las filas fuente dentro de la base; este documento no publica payloads brutos ni datos de autenticación. El mismo respaldo cifrado verificado a las 14:46 UTC se reutilizó para la migración de las 15:26 UTC, sin crear otro. Para la preparación financiera y el contexto de la reunión, ver [Finanzas para Tiziano](finance-meeting-2026-10-09.md). El alcance empresarial, los controles manuales y el corte pendiente están en [Migración AppSheet](appsheet-migration-2026-10-09.md).

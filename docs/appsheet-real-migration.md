# Migración técnica de AppSheet: captura, proyecciones y corte

Estado de preparación inicial al 9 de octubre de 2026, anterior al ensayo de carga de estos snapshots. Las secciones de preparación conservan ese estado histórico; la actualización al final describe la relectura y los cambios posteriores. Esta guía documenta la reconciliación de fuentes, las proyecciones y los gates del corte. La evidencia posterior de aplicación, repetición y producción se conserva separadamente en el manifiesto privado del ensayo. No declara equivalencia funcional completa ni activación operativa.

## Alcance de la fuente

El inventario de la definición real contiene 58 tablas: 32 conectadas a Google Sheets y 26 nativas de AppSheet (1 `UserSettings` y 25 `ProcessState`). El libro tiene 39 pestañas. Las 32 tablas Google apuntan a 32 destinos únicos: 28 coinciden por nombre y cuatro usan el campo explícito “Worksheet Name/Qualifier” como alias:

| Tabla AppSheet | Pestaña del libro |
| --- | --- |
| `D_Articulo99` | `D_Articulo` |
| `Res_StockxDia` | `Movimiento_Diario` |
| `Movimiento` | `Movimiento_Nueva` |
| `Caja` | `C_OperacionUSD` |

Las otras siete pestañas no tienen una tabla AppSheet asociada: `Auditoria_General`, `Form_Stockxdíavariedad`, `Array`, `Movimiento`, `stc`, `Hoja 18` y `Extras`. Se conservaron en la captura como fuente aparte: 69 páginas, 6.176 filas con valores y 197 celdas de fórmula; una fórmula no tiene resultado resoluble y dos pestañas están ocultas. La pestaña huérfana `Movimiento` no debe contarse como una tabla AppSheet ni sumarse a `Movimiento_Nueva` sin una reconciliación explícita.

Se capturaron 31 cuerpos de tabla Google. El cuerpo de `T_Usuarios` se excluyó porque es una tabla de autenticación. Los datos de runtime de las 26 tablas nativas no se exportaron ni reprodujeron. El inventario observó 1.075 columnas, 10 slices, 113 vistas, 21 reglas de formato y 310 acciones; `bots` y otras categorías de la exportación no están soportadas. Coincidir en conteos de metadatos no demuestra que se hayan reproducido `Valid_If`, expresiones, permisos, filtros, bots, orden de formularios ni el comportamiento de pantallas. Para afirmar paridad de flujo hacen falta la definición compartida con permiso de lectura o un recorrido de AppSheet por pantalla; el XLSX y el PBIX no prueban esas reglas. Ver también [el estado de fuentes financieras](finance-sources-2026-10-09.md) y [el walkthrough de AppSheet](appsheet-walkthrough-2026-09-29.md).

De las 31 tablas Google con cuerpo capturado, 8 aparecen en el preview de pendientes y 23 no tienen preview. El preview incluye además una novena entrada para la pestaña huérfana `Movimiento`; por eso nueve entradas no significan nueve tablas AppSheet mapeadas.

El operador sigue usando AppSheet, pero no tiene una cuenta propietaria de esa aplicación. Para completar la captura hace falta que el propietario comparta la carpeta de Drive o entregue una exportación autorizada; no se leyeron ni pidieron credenciales. Una campaña de inspección del editor de Apps Script devolvió `Permission denied` al consultar una función cuyo código quedó inaccesible. Ese rechazo localiza un hueco concreto, no inventaría los demás bots ni demuestra paridad de automatizaciones.

En el editor se observó `Bot_Carga_Venta_Stock`: evento `New event` sobre `C_Detalle_Fact`, con `Adds` y `Updates` habilitados y condición `[Cantidad_Gr] > 0`. La acción `Carga_Venta_Stock`, enlazada a `A_Carga_venta_Stocktotal`, agrega una fila nueva en `Mov_Stock1`; el nuevo `ID_Mov_Stock_Total` usa `UNIQUEID()`, mientras `Origen ID` e `Id_Detalle_Ref` conservan `[Id_Detalle]`. La configuración fue observada; el efecto duplicado no se reprodujo escribiendo en AppSheet. Sin embargo, editar un detalle que siga cumpliendo la condición puede volver a ejecutar el alta con otra clave de movimiento para la misma referencia de detalle, con riesgo de repetir el movimiento o débito de stock. AppSheet se mantiene como fuente inmutable. El equivalente de Bombo debe resolver la idempotencia de altas y updates conforme al flujo elegido por el usuario y validarse antes de afirmar paridad; no se cambia la expresión fuente ni se generaliza este bot a los demás. El acceso del propietario y la captura final siguen pendientes.

## Estabilidad, fórmulas y adjuntos

La captura usada para los previews sigue siendo preliminar. Su manifiesto cubre 254 páginas y marca `stable=false`: 20 páginas cambiaron entre verificaciones, 18 coincidieron en el tercer pase y dos volvieron a cambiar. El escaneo registró una escritura de origen que afectó 36 celdas ingresadas por usuario en cuatro filas; otros 19 cambios de página afectaron valores efectivos, con 9.340 celdas y 3.359 filas. No se estableció un cutoff estable.

El manifiesto incluye 3.041 celdas con fórmulas y 840 resultados que no pudieron resolverse. Las fórmulas pueden recalcularse mientras se leen las páginas; una fórmula presente o un valor efectivo observado no equivale a una operación verificada ni a una exportación tomada en un único instante. Una opción de delta permite preparar un staging preliminar, pero no vuelve estable la captura ni la hace elegible para el corte.

La fuente contiene 3.019 referencias únicas a adjuntos. No se descargaron objetos ni se generaron checksums de contenido. Se buscaron ocho referencias exactas y ninguna se resolvió; 3.011 referencias siguen sin búsqueda individual. Una inspección complementaria reportó dos plantillas PDF y dos referencias con acceso denegado; no se confirmó una tercera plantilla. El acceso a la carpeta propietaria sigue pendiente, por lo que los documentos no forman parte de la migración comprobada.

## Estado de los previews y snapshots

El artefacto privado `pending-preview.json` deriva de 24.331 filas de origen y contiene 16.928 registros para revisar: 2 candidatos preliminares y 6.278 filas que requieren revisión. Es un preview sin conexión a la base; no es un conteo de operaciones confirmadas ni evidencia de commit. Sus valores de filas e importes no se publican en este documento.

La proyección de maestros se examinó localmente con la captura preliminar y la definición revisada. No se ha aplicado ni staged un snapshot nuevo de maestros en la base local o en producción. El preview de historia ahora termina correctamente, pero conserva el carácter preliminar: reporta 24.331 registros de origen y 24.331 hechos históricos, 29.886 excepciones (12.497 bloqueantes y 17.389 para revisión) y 20 deltas globales bloqueantes. El informe declara `cutoverEligible=false`. El preview es de solo lectura; no se staged ni aplicó un snapshot de historia en PostgreSQL. Los recorridos son proyecciones distintas y requieren revisiones separadas.

El staging futuro de maestros escribe un snapshot, filas y excepciones de origen, auditoría, identidades y registros canónicos de miembros y catálogo. Los SKU importados se crean inactivos; aun así, esto no es una copia de archivo sin efectos sobre tablas canónicas. La proyección de historia escribe su propio snapshot, registros de origen, hechos históricos y excepciones. Ninguno de esos pasos activa por sí solo la autoridad de Bombo ni publica historia financiera.

## Previews, revisión y repetición

Los CLIs siguientes son los comandos presentes en el checkout. Los previews son el modo predeterminado y no abren una base de datos. Los artefactos y las revisiones deben permanecer en `.local/appsheet-real-20261009/`, fuera de Git; el directorio debe ser privado (`0700`) y cada archivo privado (`0600`). No copiar filas, credenciales ni tokens a la consola, documentación o tickets.

```sh
# Resumen agregado de la definición; sin guardar el inventario ni conectar a DB.
./node_modules/.bin/tsx scripts/appsheet-definition.ts \
  --file .local/appsheet-real-20261009/appsheet-definition-1.001739.html

# Preview de pendientes; usa otro nombre para no reemplazar el artefacto existente.
./node_modules/.bin/tsx scripts/appsheet-pending.ts \
  --capture .local/appsheet-real-20261009 \
  --allow-staged-delta \
  --output pending-preview-rerun.json

# Previews independientes de maestros e historia con identidad de definición revisada.
./node_modules/.bin/tsx scripts/appsheet-canonical.ts \
  --capture-dir .local/appsheet-real-20261009 \
  --definition .local/appsheet-real-20261009/appsheet-definition-inventory-1.001739-v2.json \
  --allow-staged-delta

./node_modules/.bin/tsx scripts/appsheet-history.ts \
  --capture-dir .local/appsheet-real-20261009 \
  --definition .local/appsheet-real-20261009/appsheet-definition-inventory-1.001739-v2.json \
  --allow-staged-delta
```

`--allow-staged-delta` es explícito: conserva bloqueos y marca el preview como preliminar. No debe usarse para afirmar un cutoff o un delta final. El inventario `-v2.json` deriva el identificador esperado de la aplicación de las referencias de `ProcessState`; el export HTML no lo presenta como campo directo. El preview actual informa identidad `verified` y enlaza la proyección con un `appliedDefinitionHash`. El manifiesto original de captura permanece inmutable; la definición `-v2` es un artefacto separado. El inventario anterior a `-v2` deja la identidad ausente.

La regresión de historia quedó cubierta por 11 pruebas unitarias focales y fue verificada por el checker con Node `v24.19.0`. El gate independiente completo ejecutó `typecheck`, `test` y `build`: 352 pruebas aprobadas, sin fallos ni omisiones, usando PostgreSQL 18.6 aislado e incluyendo el ensayo de backup/restore. Las pruebas no sustituyen la aplicación de los registros reales ni la comprobación en producción.

Antes de aplicar, una revisión técnica independiente debe validar la proyección y quedar vinculada a la captura, hash del manifiesto, hash de definición, tipo y hash de proyección, versión del importador y el SHA exacto del commit de 40 caracteres. El JSON estricto requiere `reviewKind: "independent-technical"`, `approved: true`, revisor, fecha y hallazgos. El CLI rechaza una revisión de otro commit o proyección, una revisión del mismo ejecutor, un checkout sucio o un estado Git que cambió durante la ejecución. La revisión técnica no es la autorización operativa de Bombo.

No existe una bandera `--resume`. La repetición se hace volviendo a ejecutar el mismo comando con los mismos artefactos, revisión, actor, destino, respaldo y commit limpio. Si el snapshot existente coincide campo por campo, el resultado puede ser `replay: true`; diferencias de filas, excepciones, auditoría, revisión o respaldo se rechazan en lugar de sobrescribirse. Un cambio de fuente o código requiere regenerar el preview y la revisión para el nuevo hash y commit. `--refresh-preliminary` sólo está disponible para aplicar maestros cuando hay una captura estable y la línea base continúa pendiente y sin cambios manuales; no habilita el refresh de esta captura inestable.

## Respaldo, aplicación y restauración

Cada proyección se aplica por separado. El target `isolated-test` de maestros requiere `TEST_DATABASE_URL` loopback y una base dedicada `bombo_ui_*`; historia usa `--target isolated` con la misma clase de destino. Producción requiere `DATABASE_URL` y referencia a un paquete verificado. Historia exige además `--backup-reference` en ambos targets. No se ejecutaron estos comandos de aplicación para los snapshots nuevos:

```sh
# Backup nuevo del destino, con DATABASE_URL y BACKUP_ENCRYPTION_KEY
# configuradas por el mecanismo privado aprobado.
node scripts/operations-backup.mjs backup <directorio-privado-nuevo>
node scripts/operations-backup.mjs verify <directorio-privado-nuevo>

# Ejemplos de ensayo aislado; requieren actor, revisión independiente y respaldo verificado.
# Una captura preliminar sólo puede ensayarse aislada; producción exige stable=true.
./node_modules/.bin/tsx scripts/appsheet-canonical.ts \
  --definition .local/appsheet-real-20261009/appsheet-definition-inventory-1.001739-v2.json \
  --allow-staged-delta --apply --target isolated-test \
  --actor-id <administrador-activo> \
  --review .local/appsheet-real-20261009/masters-review.json \
  --backup-reference <paquete-privado-verificado>

./node_modules/.bin/tsx scripts/appsheet-history.ts \
  --definition .local/appsheet-real-20261009/appsheet-definition-inventory-1.001739-v2.json \
  --allow-staged-delta --apply --target isolated \
  --actor-id <administrador-activo> \
  --review .local/appsheet-real-20261009/history-review.json \
  --backup-reference <paquete-privado-verificado>
```

Los ejemplos de apply muestran la forma real del CLI; el estado actual no los habilita como corte. No pasar secretos por argumentos, historial de shell o logs. El backup debe ser del destino correcto y verificarse antes de la aplicación. La transacción serializable revierte el staging completo ante un fallo SQL, en lugar de dejar filas parciales. Esto no revierte operaciones realizadas fuera de esa transacción.

`node scripts/operations-backup.mjs restore <paquete>` es un ensayo local restringido: sólo admite una base loopback dedicada vacía (`bombo_restore*`, `bombo_test*` o `bombo_ui_*`) y un directorio de objetos absoluto, vacío y separado. Requiere `RESTORE_DATABASE_URL` y `RESTORE_PRIVATE_OBJECT_ROOT` privados; no es el mecanismo de rollback de producción. Ver [respaldo y recuperación](backups-and-recovery.md) para el flujo de ensayo y el camino cloud independiente. No se verificó una restauración cloud para esta migración.

Antes de declarar corte hay que pausar manualmente las escrituras en AppSheet, obtener una captura final estable posterior a esa pausa, revisar su delta completo y separar los cambios esperados de las fuentes legadas durante el intervalo. La revisión tipada de `final-delta-reconciled` ahora acepta referencias verificables de la pausa y del análisis separado de cambios; exige que la primera lectura y el cutoff de la captura queden después de la pausa y que `sourceWriteDetected` sea exactamente `false`. El gate ya no está codificado como siempre no disponible, pero la captura preliminar actual tiene páginas variables y `sourceWriteDetected=true`, por lo que no sirve como checkpoint final. La pausa y la captura final todavía no se acreditaron.

En el perfil `appsheet-replacement`, el código excluye `legacy-writes-disabled` de los gates requeridos y rechaza expresamente aprobarlo con `legacy_writes_remain_enabled_by_cutover_decision`. No afirmar que las escrituras legadas estén deshabilitadas. La activación también exige snapshots verificados de maestros e historia, gates aprobados con autor y revisor distintos y evidencia ligada a la misma captura, prueba de aperturas y `CLUB_OPERATIONS_APPROVED=true`. La ruta de apertura física enlaza cada hecho de stock con historia revisada de la captura y contrasta cantidad, unidad y relación única con el SKU; no basta con presentar un ID de origen.

Ahora existe el comando `AuthoritySuspended`: sólo un propietario activo de Bombo puede usarlo cuando la autoridad está `active`. Dentro de la transacción cambia el modo a `shadow`, incrementa la versión y registra el motivo, conservando el perfil, el manifiesto de captura, la aprobación y `firstRealWriteAt`; no borra ni revierte operaciones posteriores. La prueba de corte ejercita la suspensión, el rechazo a un no propietario, el rollback si falla la auditoría y la preservación del estado de autoridad. El integrador reporta 1/1 prueba de integración aprobada sobre PostgreSQL local aislado; no se suspendió ninguna autoridad en producción.

Después del primer write real, no restaurar encima de la base viva un paquete anterior al corte: se perderían órdenes, movimientos de caja, cambios de stock, recibos de comandos y otras operaciones posteriores. `AuthoritySuspended` pausa la autoridad de Bombo conservando esos efectos, pero no restaura ni reconcilia bases. Para una recuperación, conservar una copia intacta de la base actual y restaurar sólo a un destino aislado vacío; comparar y reconciliar toda operación posterior al backup antes de planear una promoción. El restore cloud tiene efectos externos y requiere su propio destino allowlisted y autorización; no se ejecutó aquí. Una falla en el apply transaccional sí puede reintentarse con la misma entrada si sus hashes siguen exactos; no usar un restore para resolver un conflicto de replay.

## Matriz de evidencia actual

| Capa | Evidencia | Estado |
| --- | --- | --- |
| Captura local | Manifiesto original conservado sin reemplazo; 254 páginas, 20 variables, `stable=false` y `sourceWriteDetected=true`. Inventario de definición `-v2` separado. | Sin cutoff. La captura final sigue en curso; el usuario no tiene cuenta propietaria y hace falta compartir la carpeta de Drive o una exportación autorizada. |
| Apps Script | Observación de `Bot_Carga_Venta_Stock`: `New event` sobre `C_Detalle_Fact`, Adds y Updates, condición `[Cantidad_Gr] > 0`; `A_Carga_venta_Stocktotal` agrega a `Mov_Stock1` con `UNIQUEID()` y conserva `[Id_Detalle]` en `Origen ID` e `Id_Detalle_Ref`. El editor devolvió `Permission denied` para una función cuyo código no se pudo leer. | El update positivo puede crear otro movimiento con la misma referencia; no se reprodujo escribiendo en AppSheet. Mantener la fuente intacta, hacer idempotente el flujo Bombo que elija el usuario y capturar el resto de bots antes de declarar paridad. |
| Preview local | El preview de pendientes sigue en 24.331 filas de origen y 16.928 registros agregados; maestros preparados con delta explícito. | Sin snapshot nuevo de maestros staged en la base local; los números no son operaciones aplicadas. |
| Historia local | Preview observado: 24.331 source records/facts, 29.886 excepciones (12.497 bloqueantes, 17.389 para revisión), 20 deltas; `cutoverEligible=false`. Identidad de definición `verified`. | Preview de solo lectura; no hay snapshot staged ni apply PostgreSQL. |
| Gate independiente local | `bin/gate.sh` pasó typecheck, 352/352 pruebas sin skips y build con Node `v24.19.0` y PostgreSQL 18.6 aislado. Incluye historia 11/11 y backup/restore E2E. | Evidencia local; CI, aplicación de la captura real y producción se verifican por separado. |
| Validación focal independiente | El tester reportó Node `24.19`: definición 11/11, maestros 12/12, pendientes 12/12, historia 11/11 y lector legado 16/16; el typecheck exacto del servidor también pasó. | Resultados reportados por el integrador; no son la suite completa, CI del commit actual ni un apply de historia. |
| Gate de corte y suspensión | La revisión final tipada exige captura posterior a la pausa con `sourceWriteDetected=false`. `AuthoritySuspended` está implementado como comando owner-only y preserva los datos operativos. | El dueño reporta 1/1 integración sobre PostgreSQL local aislado con éxito y rollback; no hubo suspensión o activación en producción. La captura final sigue pendiente. |
| Interfaz de CLI | Los cuatro `--help` coinciden con las banderas documentadas; `--resume` no existe. | Esta comprobación de interfaz no demuestra consistencia entre cuatro previews; sólo se ejecutó el preview de historia en esta actualización. |
| Esquema de base | El integrador reporta 36 migraciones aplicadas localmente; producción sigue en 34. | Estado local no equivale a migración de producción ni a importación de datos. |
| Aplicación y adjuntos de origen | El usuario sigue operando AppSheet. La inspección complementaria reportó dos plantillas PDF y dos referencias con acceso denegado; no hay una tercera confirmada. | Acceso a la carpeta de Drive propietaria pendiente. No se descargaron los objetos; el conteo de referencias no certifica qué plantilla usa cada bot. |
| Backup/restore local | Paquete cifrado del esquema local con 36 migraciones, 21.388 registros técnicos previos y cero órdenes, stock o caja; restauración a un destino vacío con integridad, migraciones, conteos y huellas financieras coincidentes. | Evidencia privada del ensayo local; no acredita migración de producción. |
| CI del commit actual | El checkout que contiene estos cambios sigue con archivos modificados y no tiene un commit limpio al que atar la revisión. | CI de esta revisión exacta pendiente. |
| Despliegue | No se presentó evidencia de un despliegue con estas migraciones y CLIs. | Pendiente; no inferirlo de un build o despliegue anterior. |
| Producción | El integrador reporta 34 migraciones; el esquema local tiene 36. No se aplicó un snapshot nuevo de maestros o historia ni se activó la autoridad para esta migración. | Producción permanece sin cambios por este flujo; no hay carga operativa demostrada. |
| Corte funcional | Sin cutoff estable, adjuntos completos, revisión de historia, delta final posterior a pausa, ni gates de autoridad y aperturas aceptados. | No listo para cortar ni declarar paridad completa. |

Los conteos y estados del staging anterior de `appsheet-business-archive` y de observaciones financieras están documentados por separado en [Migración AppSheet y operación manual](appsheet-migration-2026-10-09.md). No representan la aplicación de estos nuevos snapshots de maestros e historia.


## Relectura de paridad del 9 de octubre de 2026

Se volvió a leer, sin modificar la aplicación, [la documentación del sistema oficial Adm_TB](https://www.appsheet.com/template/appdoc?appId=5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0). La versión observada fue `1.001739`: 58 tablas, 1.075 columnas, 10 slices, 113 vistas, 21 reglas de formato y 310 acciones. Los 570 objetos raíz y sus columnas coincidieron semánticamente con la definición anterior, excluyendo posiciones de evidencia y el encabezado generado. Esto compara definiciones; no vuelve estable el libro ni certifica sus filas.

La captura HTML privada tiene SHA-256 `f4c9aea7d1f5d088990d04032f96cbde43d2ccebca4f5152e96950bfa9281d60`. El inventario final del parser `1.2.0` tiene SHA-256 `35cb592144a55559ba63002caf3ef96a0e017bfcbfefb13294ff79d12e6cfc84` y descriptor `1e034d799dd1cbeeda71d5d14946a4155effce40d2a6ad3d3619fdbf5e065d44`. Se corrige la lectura del nombre y versión del encabezado y se distingue JSON `null` de una expresión literal: un campo sin expresión no se convierte en la fórmula `"null"`. El mapa privado conserva 1.645 nodos y destinos candidatos; una coincidencia de nombre de archivo no demuestra equivalencia ejecutable.

La revisión técnica v2 se vincula, además del commit y la proyección, al tipo de destino y a un fingerprint opaco de host, puerto, base y esquema. Las credenciales no participan en el fingerprint ni se muestran. Los previews pueden derivarlo de la configuración sin abrir una conexión. Una revisión v1 sólo puede emplearse en ensayo aislado. El staging de producción rechaza capturas inestables incluso si se solicita delta preliminar. La historia se escribe en bloques limitados por cantidad y bytes, conservando el orden y rechazando un registro individual demasiado grande antes de persistir el snapshot.

La elegibilidad de socios del reemplazo exige la revisión de identidades de la captura seleccionada y sus auditorías individuales. Una aprobación genérica de un archivo anterior no la sustituye. La consulta filtra antes de paginar, y el control se aplica también a detalle, historia, acceso clínico y nuevas facturas. Los socios creados mediante el comando normal siguen disponibles; las modificaciones posteriores legítimas conservan su cadena de recibos y auditoría. La revisión de otra captura no invalida por sí sola la anterior ni autoriza datos de esa otra captura.

El recorrido de factura mantiene borradores y permite crear un socio y volver al formulario. Los reintentos de una respuesta perdida conservan la identidad del comando. La selección del socio recién creado requiere comprobar su registro; una lectura fallida no inventa una opción. Confirmar una preventa desde la edición requiere la misma evidencia explícita de aceptación que su confirmación directa, vinculada a la cotización y su hash. La reserva de stock y entrega ocurre dentro de la transacción; guardar historia no repite cobros ni bots.

La regla financiera v2 separa el 5% de los productos del 5% de Moto para Transferencia/Mercado Pago, y suma el subtotal de cliente de Moto una sola vez. Se conserva el cálculo v1 de las cotizaciones históricas; una cotización que dejó pendiente el recargo de Moto requiere edición y recálculo antes de confirmarse. Los resultados de dinero exacto conservan el cociente, el resto y la regla de redondeo aplicada. La fórmula fuente no especifica por sí sola ese redondeo: comparar contra resultados reales sigue siendo necesario para certificar paridad monetaria.

En el legado, `Precio_gramo_línea` y `Valor_Total` son valores iniciales editables y no se reinician al editar. Las seis escalas exactas (`Precio_5_Gramos` a `Precio_30_Gramos`) y las promociones deben permanecer separadas; los intervalos agrupados antiguos de Bombo no permiten inferir esos precios. Las tarifas de Moto dependen de servicio, gramos totales y tres filas de catálogo. Se conserva cada expresión y su fase; no se convierten valores de catálogo o monedas desconocidos en importes aprobados. La disponibilidad por lote y su fecha de entrega todavía necesitan correspondencia comprobada con `C_Mercaderia`.

La evidencia recibida posteriormente contiene tres libros de distintas fechas, 2.368 instancias de archivos y 94.794 celdas con fórmulas; ese número cuenta celdas, no expresiones únicas. Se conservaron 1.886 objetos únicos por contenido (219.570.906 bytes) y se vincularon 1.174 rutas exactas. Quedan 1.844 rutas faltantes y una ambigua. El delta recibido no fue importado automáticamente. Estos conteos proceden del manifiesto privado del ensayo `f6902ce`; no constituyen una captura final del sistema en uso.

Estos cambios requieren un commit congelado, controles locales y revisión independiente del mismo SHA. La evidencia de esa ejecución se conserva en un manifiesto privado separado; este texto no afirma CI, despliegue, ingreso de Tiziano/Camila ni carga operativa en producción. Persisten la pausa manual y captura final, resultados de fórmulas sin resolver, adjuntos pendientes y cobertura incompleta de bots/Apps Script. AppSheet permanece intacto.

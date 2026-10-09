# Migración AppSheet y operación manual

## Alcance comprobable

El libro real `2025_PP_Appsheet_TB (2).xlsx`, SHA-256 `a22fdd096af1e5cdc3986a2bcc51d917d9bd6764f79bcdba5c1e112820488ca2`, tiene 39 hojas. La preparación del archivo empresarial concilia 32 tablas con un control independiente y conserva 17.695 filas. Las seis hojas sin encabezados suficientes quedan como cobertura de coordenadas, sin afirmar que fueron extraídas. La hoja de usuarios se excluye. Las bibliotecas abren el XLSX en memoria; el código de migración no consulta ni persiste los valores de autenticación excluidos.

Un cálculo independiente con openpyxl separa 16.850 filas con valores literales o cacheados y 845 filas adicionales observables por sus fórmulas. El lector conserva la definición de la fórmula, sin evaluarla. Su métrica de 3.663 filas compuestas sólo por celdas de fórmula incluye 2.818 con caché no vacía; mide la composición de las celdas, no la ausencia de resultados. No se toman esas fórmulas como operaciones comerciales comprobadas.

Todos los registros de `appsheet-business-archive` llevan `archive_only`. Los originales saneados, normalizados, claves, posiciones y hashes se conservan junto a las excepciones. El archivo no crea socios activos, productos, ventas, saldos, costos, asientos ni publicaciones históricas. Los movimientos incluidos aquí y en la [fuente financiera](finance-sources-2026-10-09.md) son observaciones separadas; no se suman dos veces.

El CLI `scripts/appsheet-archive-stage.ts` prepara un preview sin conexión a la base. Aplicar requiere controles privados estrictos y un backup cifrado verificado. Una fila con señales de credenciales provoca rechazo si la exclusión rompe el conteo independiente; no se fuerza una importación parcial. La repetición compara el lote, cada registro, las excepciones, la auditoría y el objeto; no sobrescribe discrepancias.

Las identidades técnicas `appsheet-business-archive` y `appsheet-finance-observations` están reservadas. Los comandos genéricos rechazan su revisión, resolución, mapeo, activación y publicación con `LEGACY_TECHNICAL_SOURCE_BLOCKED`. Una importación futura con interpretación y revisión propias conserva su recorrido normal.

## Funciones manuales recuperadas

La consola integra formularios para crear y editar productos, proveedores y ubicaciones, reactivar o dar de baja referencias y registrar aperturas de stock. Las aperturas requieren cantidad, costo y moneda explícitos, ubicación y responsable, evidencia y un preparador activo distinto del aprobador. No se adivinan costos ni se ingresa stock con un identificador opaco.

Se conservan la creación y edición de preventas y los comandos existentes de recepción, traslado, preparación, entrega y devolución. La corrección de una factura confirmada usa `OrderLinesCancelled` y se limita a la demanda todavía no preparada; no altera cobros ni devuelve dinero. Las acciones físicas se pausan cuando falta el nombre verificable del producto o una referencia requerida. La custodia de una apertura es opcional: vacía, corresponde a quien aprueba.

La recepción usa el `lineId` canónico de la compra. Una línea recibida por completo no bloquea otras pendientes si su producto se desactiva después; cada pendiente sí debe tener un producto activo identificado y unidad coincidente. La preparación obtiene los nombres y lotes de las reservas visibles en el detalle del pedido, incluso si el producto se desactivó después de reservarlo. Si alguna reserva pendiente carece de metadatos verificables, pausa el formulario completo.

El listado y el detalle de pedidos incorporan el nombre actual de los productos referenciados por sus líneas autorizadas, aunque estén inactivos. Esto conserva la identificación necesaria para terminar retiros, correcciones y devoluciones. No constituye una instantánea del nombre histórico, no habilita productos inactivos para nuevas ventas y no amplía el catálogo visible.

El servidor valida capacidades, alcance completo, versiones e idempotencia. Proveedores y ubicaciones usan comandos auditables; el renombre de ubicación actualiza también la etiqueta legada del producto en la misma transacción, sin cambiar saldos.

## Corte operativo y definición pendiente

La consulta de producción del 9 de octubre a las 03:20 UTC observó autoridad operativa ausente, `CLUB_OPERATIONS_APPROVED` desactivado y cero productos, proveedores, ubicaciones y saldos operativos. El contexto efectivo es `shadow`; la interfaz muestra ese estado y el servidor rechaza los comandos operativos hasta completar el corte. Tener formularios publicados no acredita un local habilitado.

Se abrió la app real `Adm_TB-924511155`, versión visible `1.001737`. Pide su usuario y contraseña internos. El editor de la cuenta Google disponible muestra “No apps shared with you” y ninguna app propia. Falta acceso a la definición para comprobar claves, expresiones, `Valid_If`, acciones, vistas, bots, permisos, filtros y sincronización. Los datos del Excel y el PBIX no prueban esas reglas. El permiso de lectura se otorga desde Share como [View/copy app](https://support.google.com/appsheet/answer/10104983?hl=en).

Para activar stock y finanzas canónicas faltan el mapeo revisado, aperturas respaldadas, costos históricos y el corte operativo correspondiente. Sin esa evidencia, la migración completa y el cierre financiero siguen pendientes.

## Evidencia

La preparación real pasó con 32 tablas, 17.695 filas, 4.395 excepciones, cero filas en cuarentena y cero filas omitidas por etiquetas. Se rechazaron antes de escribir una aplicación sin backup y una fuente con hash diferente. El backup cifrado previo del 9 de octubre a las 03:27 UTC conserva las 3.693 observaciones financieras ya cargadas; huella `a92b26030e260b0950a20cb713a5ea8677133fc8d5f7e0a418ac137b861b79a7`. El paquete y la clave quedan privados y separados, fuera de Git.

Las cinco pruebas focalizadas de proveedores y ubicaciones pasaron con HTTP y PostgreSQL 18 sintéticos: persistencia, repetición, autorización, versiones, rechazo de evidencia vacía y rollback de un fallo SQL tardío. La prueba focal del archivo pasó en PostgreSQL 18 descartable: carga y repetición, fórmulas sin caché, inmutabilidad, rechazo de encabezados sensibles y controles alterados, y rollback ante un fallo SQL tardío. Una segunda ejecución confirmó el rechazo de un manifiesto almacenado cuyo JSON fue alterado sin cambiar su hash declarado, seguido de un replay válido al restaurar el fixture.

Las 13 pruebas focales de fuentes técnicas pasaron con HTTP y PostgreSQL 18: los 12 rechazos de las dos identidades técnicas conservaron el estado persistido; una fuente genérica `archive_only` mantuvo su proyección legítima.

Los cinco recorridos de navegador manual pasaron con API real y PostgreSQL 18 sintéticos: apertura con custodia vacía, bloqueo sin ubicaciones, bloqueo cuando falla la lista de preparadores, recepción parcial con otro producto desactivado y preparación y retiro local de una reserva de producto inactivo. Las comprobaciones negativas verificaron ausencia de comandos y cambios persistidos. El retiro verificó nombres, versión, cantidad física, estado entregado y allocation persistida. La última ejecución completa pasó 5/5 en 16,1 segundos, con typecheck focal aprobado. Se comprobó la eliminación del esquema temporal, cero tablas públicas y sesiones de prueba y el apagado del PostgreSQL dedicado. Los gates integrados y la carga empresarial de producción siguen pendientes al redactar esta sección.

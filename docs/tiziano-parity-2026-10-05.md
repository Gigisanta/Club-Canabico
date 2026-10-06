# Reemplazo integral de Bombo: requisitos y evidencia

Revisión iniciada el 5 de octubre y validación local cerrada el 6 de octubre de 2026. Alcance confirmado por Gigi: usar la reunión del 29/9 y los archivos existentes de Tiziano para mejorar el uso y reemplazar AppSheet y Power BI. El objetivo incluye administración, local y reparto. Los ensayos y cambios de este checkout no autorizan desplegar, migrar datos reales ni activar el corte.

## Fuentes y procedencia

| Fuente privada, conservada fuera de Git | Identificación y límite |
| --- | --- |
| Reunión del 29/9 | `/Users/gigi/meetings/transcripts/recording-meet-1790701193-0ed40acd-9056-48bc-85ac-8a80bb64c14d.txt`. El texto disponible tiene 281 líneas y termina a mitad de una frase; no se afirma que sea una transcripción completa. |
| Excel enviado | `/Users/gigi/Downloads/2025_PP_Appsheet_TB (2).xlsx`; 2.077.008 bytes; SHA-256 `a22fdd096af1e5cdc3986a2bcc51d917d9bd6764f79bcdba5c1e112820488ca2`. |
| Power BI enviado | `/Users/gigi/Downloads/2026.06.ADMTB_Reporte.pbix`; 1.011.668 bytes; SHA-256 `8a8f8baea9bf3ee844daad205d1ea953629c362888a09e26ff5f0786b654594b`. |
| Recorrido observado de AppSheet | `docs/appsheet-walkthrough-2026-09-29.md` en el checkout original `/Users/gigi/HerMaatOS/work/bombo`. Ocho módulos observados; no constituye exportación completa de vistas, acciones, bots y reglas del editor. |
| Investigación de fuentes | `.local/legacy-research-20260930/` del checkout original: `reproducible/audit-summary.json`, `source-verification-findings.md`, `finance-dax-findings.md`, `commercial-dax-findings.md`, perfil y diccionario. No se copian registros, fórmulas sensibles, conexiones ni credenciales a este documento. |

Se verificaron hashes y metadata actuales con Python 3.12.14, openpyxl 3.1.5 y pbixray 0.15.5. La investigación fue de lectura; no se refrescaron consultas externas, ejecutaron medidas DAX ni modificaron los archivos enviados.

## Lo que pidió Tiziano y su consecuencia para el producto

| Necesidad observada | Evidencia de la reunión | Contrato de uso y aceptación |
| --- | --- | --- |
| Reemplazar la administración anterior y conservar historia | Líneas 38–44 y 54–59 | Un circuito conjunto de compras, stock, pedidos, entregas, cobros y caja; historia con procedencia y sin volver a ejecutar sus efectos. |
| Entender rápidamente si el negocio cubre sus costos y qué decisión tomar | 26–30, 38–40 y 276–281 | Indicadores por período y moneda, con cobertura y pendientes visibles. Datos faltantes no se convierten en cero ni en rentabilidad confirmada. |
| Separar compra, llegada, disponibilidad y merma por lote | 63–80, 128–145, 193–198, 243–248 y 267–271 | Recepciones parciales y costos documentados; disponibilidad física y reserva diferenciadas. No prometer variedades dependientes de un proveedor. |
| Administrar catálogo, precios, packs y promociones sin programar cada cambio | 59, 82–106, 199–206 y 228–242 | Configuración revisable por Camila y aprobación comercial de Tiziano; ninguna campaña se aplica o envía automáticamente. |
| Seguir venta, entrega, cobro y dinero real | 18–20, 107–123, 221–260 y 263–266 | Pedido y entrega no acreditan cobro. Reportar un cobro no lo verifica; rendir custodia no reconoce otra venta. Deuda de compra enlazada a su orden. |
| Ordenar recorridos y trabajar desde el teléfono | 107–145 y 217–227 | Ruta, fecha, parada y ETA estimada; remanente de entrega explícito. La operación offline está en el plan de migración y requiere aceptación en Android real. |
| Evitar WhatsApp API y automatización de mensajes | 45–46, 59–60 y 121–145 | Conservar historia de campañas si corresponde; no reactivar bots ni enviar mensajes. |

El documento inicial de octubre describía un piloto sólo local. Se actualizó [implementacion-octubre-2026.md](implementacion-octubre-2026.md) para que el reparto forme parte del objetivo actual. Se conservan la autoridad vigente, las barreras de escritura y la aprobación humana del corte.

## Hallazgos que afectan la migración

| Hecho observado | Consecuencia |
| --- | --- |
| Excel: 39 hojas, dos ocultas y 59.049 celdas con fórmula. Las principales tablas transaccionales `C_*` no tienen fórmulas físicas. | Las reglas de AppSheet no se deducen sólo de las fórmulas del Excel; hace falta validar acciones y cálculos virtuales del editor. |
| `Pre_Venta`/`Pre_Detalle_Fact` y `C_Facturacion`/`C_Detalle_Fact` son fuentes distintas. | No convertir borradores en ventas confirmadas ni duplicar sus líneas. |
| 600 líneas sin precio/total, 117 diferencias entre cantidad × precio y total de línea, cuatro facturas huérfanas. | Conservar excepciones para revisión; no completar precios o enlaces inventados. Los conjuntos no se suman como registros distintos. |
| `C_Moto.Entrega_completada`: 1.244 TRUE, ningún FALSE y una celda vacía; nueve claves de ruta frente a una fila en `O_Ruta`, sin uniones exactas. | El flag no permite reconstruir todos los pendientes ni prueba entrega real. No asignar automáticamente rutas históricas. |
| Los 274 movimientos de `Movimiento` están incluidos en `Movimiento_Nueva`, que tiene 3.693 filas con contenido. | No importar ambas tablas como hechos adicionales. Usar la clave candidata `ID_Movimiento_Unique`, no `Origen_ID` ni el contador oculto, que no son únicos. |
| Un monto de `Movimiento_Nueva` es texto; hay seis pares lote/código con stock negativo y 48 diferencias de cambio mayores que centavos. | Mantener errores tipados y diferencias explícitas; no convertir texto a cero ni ajustar FX o stock silenciosamente. |
| Fecha de factura y fecha de cobro son distintas; `Fecha_Cobro` del libro no figura en el esquema de factura del PBIX revisado. | Migrar ambas fechas sin presentar facturación como dinero cobrado. |
| El PBIX suma montos en distintas bases y ciertas medidas no filtran moneda ni convierten ARS/USD. | Definir métricas por moneda, período y hecho; comparar cada resultado aceptado con la fuente. Copiar una fórmula histórica no certifica su interpretación financiera. |

### Corrección del inventario de Power BI

Se recuperaron 208 medidas, 63 columnas calculadas y 17 tablas calculadas, además de 12 consultas M, 13 páginas y 29 tablas en el inventario público. El inventario público de pbixray filtra tablas con `SystemFlags` distinto de cero y no representa todos los objetos internos.

La propiedad pública `PBIXRay.relationships` devuelve seis relaciones porque exige `SystemFlags=0` en ambos extremos. Una lectura fresca de la tabla interna `Relationship` del mismo hash devuelve 18, todas activas: seis uniones de negocio, seis hacia `DimFecha[Date]` y seis que involucran tablas de fecha automática. Las notas anteriores que describen `DimFecha` como desconectada quedan corregidas: tiene seis conexiones activas. La [documentación primaria de Microsoft](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-auto-date-time) explica la creación de tablas de fecha ocultas y sus relaciones. Esta revisión no comprueba unicidad efectiva, continuidad de fechas ni resultados ejecutados del modelo.

## Cobertura local y límites del reemplazo

| Circuito | Cobertura inspeccionada | Aceptación pendiente |
| --- | --- | --- |
| Compras y recepción | API canónica con recepciones parciales y límite de cantidad; compra, deuda y pago son hechos separados. Interfaz de deuda vinculada a una compra. | Órdenes abiertas y costos reales aceptados; confirmar el vínculo de las fuentes históricas. |
| Cuentas y FX | Seis cuentas del club: tres ARS y tres USD; verificación y apertura separadas. FX conserva ambos importes y exige explicar diferencias. | Nombres/titulares/correspondencias y aperturas reales, revisión independiente de esos saldos y conciliación. |
| Pedidos y reparto | Cotización, confirmación, preparación, asignación, entrega parcial e incidentes; PWA cifrada, lease y cola con recibos. | Android real, restauración, recuperación de pendientes y entrega física aceptadas. |
| Cobros y rendición | Reporte, verificación, custodia y transferencia al club separados; comandos idempotentes. | Cuentas reales y saldos de custodia conciliados. |
| Historia | Lotes, chunks, hash, replay, cuarentena y revisión; procedencia histórica separada de eventos nuevos. | Mapeo aprobado de todas las fuentes, exportación final y delta sin duplicación. |
| Informes | Once áreas canónicas con contratos y pruebas sintéticas; declaran consulta implementada sin equivalencia certificada. | Comparación independiente de métricas aceptadas con libros y resultados del PBIX, por moneda y período. |
| Corte | Catorce gates y guard existente `LEGACY_WRITER_RETIRED`: tras autoridad activa rechaza escrituras de compatibilidad con HTTP 410. | Inventario de writers, colas drenadas, siete días sombra, saldos y objetos abiertos, analítica, profesional, restauración y entrega aceptadas. |

Una aprobación de gate registrada durante ensayo no prueba migración real. Ni una compilación, un fixture ni un HTTP 200 reemplazan la aceptación de los responsables. Los comandos existentes `CutoverGateReviewed` y la guía de preparación permiten revisar evidencia; esta entrega no activa `AuthorityActivated`.

## Cambios y verificación de esta iteración

Cambios integrados en el checkout aislado `/Users/gigi/.codex/worktrees/bombo-ui-feedback/bombo`, sobre `a916ed9104a56314020e8c47bbe4ba2251c7396d`:

- **Deudas de compra:** selección por referencia, proveedor, fecha, importe y moneda. El envío toma `purchaseId`, proveedor y moneda de la compra; el importe de la obligación se documenta por separado. La tabla muestra el vínculo. Las deudas históricas sin compra tienen una acción explícita y evidencia obligatoria.
- **Cuentas:** formulario de seis cuentas, tres ARS y tres USD, con nombres, tipos, titulares y usos. El servidor sólo habilita el inicio cuando no existen cuentas del club, incluidas las inactivas, y el perfil tiene alcance global y permiso. Crear las cuentas no verifica titulares, aprueba aperturas ni crea movimientos. Un resultado incierto conserva los datos, las identidades y la clave para recuperar el comprobante. Si el reintento recibe el rechazo exacto HTTP 409 `ACCOUNTS_ALREADY_INITIALIZED`, muestra el mensaje del servidor y permite cancelar para volver a las cuentas actualizadas; otros resultados ambiguos conservan la recuperación pendiente.
- **Rutas:** los turnos vacíos permanecen visibles; se pueden ordenar las paradas con botones y una vista previa humana. Abrir, mover o cancelar el borrador no envía comandos. La confirmación exige evidencia, todas las paradas no canceladas y la versión actual. Si cambia la versión o el orden mientras se edita, se bloquea la propuesta anterior hasta cancelar y reabrir. El servidor rechaza asignar o reordenar rutas cerradas antes de escribir o auditar.
- **Reparto:** el manifiesto informa la ruta del repartidor, fecha, número de parada y ETA estimada cuando corresponde. La pantalla distingue solicitado, preparado, entregado y remanente exacto del último manifiesto. Capturas pendientes, conflictos y confirmaciones posteriores al manifiesto dejan visible que hace falta actualizarlo; una versión antigua sin remanente conserva el dato como desconocido.
- **Preparación del reemplazo:** las catorce revisiones canónicas se agrupan en cuatro pasos, con enlaces limitados por permisos. Los estados ausentes, duplicados, desactualizados o de ensayo no se presentan como reemplazo concluido. La guía es de lectura; el registro técnico se conserva en un desplegable.

La evidencia anterior de navegación, formularios, perfil y diseño se conserva en [ui-feedback-2026-10-05.md](ui-feedback-2026-10-05.md). Las pruebas de esa iteración no se atribuyen automáticamente a estos cambios.

### Verificación local

Entorno: Node 24.19.0, PostgreSQL 18 en loopback y bases dedicadas `bombo_ui_*`. Las pruebas utilizan datos sintéticos y esquemas que se eliminan al terminar. No se consultaron ni mutaron registros operativos reales.

| Control ejecutado | Resultado y alcance |
| --- | --- |
| `npm run check` | Typecheck, 264 pruebas de backend/unidad sin fallos ni skips y build correctos. Incluye los nuevos contratos de cuentas y rutas, y el recorrido de entrega parcial. |
| Recorrido API y DB de reparto | 26/26: solicitado/preparado 5, entregado 2 y remanente 3; estado parcial durable, replay sin segundo descuento, entrega sin cobro en ledger y resultado financiero separado. |
| API y DB de cuentas | 1/1: permisos y alcance, lista vacía global, cuentas inactivas, rechazo atómico, seis cuentas sin verificación/apertura ni ledger y elegibilidad retirada tras el alta. |
| API y DB de rutas | 5/5: cierre bloquea reordenamiento y asignación sin efectos; conjunto completo, duplicados, alcance y éxito durable en ruta programada. |
| Regresión de navegador | 10/10 en `operations.spec.ts`, `operations-artifacts.spec.ts` y `operations-readiness.spec.ts`. |
| Rutas y guía en navegador | 3/3 en `replacement.spec.ts`: alta y visibilidad de ruta vacía, edición sin POST hasta confirmar, reordenamiento concurrente real que invalida el borrador y persistencia tras reabrir. La guía se comprueba con respuestas GET de contrato 13/14 y 14/14; no certifica los gates reales. |
| Formularios financieros en navegador | 2/2 en `finance-setup.spec.ts`: deuda persistida y vinculada a la compra mediante API/DB reales. En cuentas, pérdida de la primera respuesta y reintento idéntico con rechazo 409 real, mensaje accesible, cancelación sin tercer POST y seis cuentas del fixture conservadas. Sólo la lectura inicial de elegibilidad se simuló para abrir el formulario; la creación inicial correcta se acredita en la prueba API de cuentas. |
| PWA offline compilada | 11/11 en `offline-pwa.spec.ts`: remanente y contexto de ruta, compatibilidad con manifiesto antiguo, cola pendiente/conflicto, almacenamiento, lease, copia cifrada/restauración, errores accesibles y confirmaciones parciales. Preview loopback, sin Android físico. |
| Build final tras las correcciones de concurrencia y recuperación de cuentas | Correcto, incluidos ambos proyectos TypeScript. Huella de fuentes y distribución coincidente: `971f5f60d36e65cd8b9a5096733519dd81f0ba19e273abeb18d6a0265cf2fa97`. Se conserva el aviso existente de un chunk de Excel mayor de 500 kB. |
| Inspección visual CUA | Guía y formulario de deuda en 320/390 px sin desborde de página; guía de escritorio a 1280 px. Consola sin errores observados en ese recorrido. Capturas locales en `.local/ui-qa/after/`. |

La revisión independiente del código de esta iteración no encontró defectos pendientes en su alcance tras corregir la concurrencia del editor, el estado desactualizado por conflictos de reparto y la salida del rechazo terminal de cuentas. El autor de cada cambio no aprobó su propia implementación. Resultado agregado: 264 pruebas de backend/unidad y 26 casos únicos de navegador/PWA sin fallos ni skips; las filas API anteriores están incluidas en las 264, no se suman otra vez.

### Lo que falta para el uso real

Quedan la conciliación de excepciones históricas y saldos, la aceptación de métricas frente a resultados ejecutados del PBIX, una jornada y recuperación en Android físico, siete días de operación en sombra y la aprobación del traspaso. Los catorce controles de la guía conservan su evidencia individual. Esta entrega es local: no acredita CI, publicación, importación real, activación de autoridad ni retiro efectivo de AppSheet/Power BI.

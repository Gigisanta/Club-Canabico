# Preparación financiera para Tiziano

Actualizado el 9 de octubre de 2026 con la verificación pública post-promoción de las 15:41:00.216 UTC y la lectura `READ ONLY` de las 15:41:02.270 UTC. Tiziano avisó que quiere conversar sobre estado de resultados, proyecciones tipo cash flow y otros temas financieros. El commit `e977c6c540c29996f2d3178aa23c83aea5f4487e` está promovido a producción; sus CI del PR y push pasaron.

## Qué hay disponible con datos reales

La base de producción conserva dos fuentes técnicas independientes:

- Excel financiero: 3.693 movimientos observados; 3.629 elegibles y 64 excluidos. Sus 22 controles mensuales por moneda coinciden exactamente con el cálculo independiente. No se mezclan ARS y USD. La última fecha elegible es el 30 de septiembre de 2026; esta fuente no contiene movimientos elegibles del 1 al 8 de octubre.
- Archivo empresarial AppSheet: 17.695 filas de 32 tablas y 4.395 excepciones. Es un archivo preservado con trazabilidad, no una migración de ventas, catálogo o stock activos. Hay otras seis hojas sólo registradas como cobertura de coordenadas, sin extracción de sus filas.

La lectura post-promoción `READ ONLY` del 9 de octubre a las 15:41:02.270 UTC confirmó, con dos comparaciones independientes exactas, 17.695 registros empresariales, 4.395 excepciones y 3.693 observaciones financieras; los 22 controles mensuales por moneda también coinciden. Catálogo, proveedores, ubicaciones, cuentas, aperturas, conciliaciones, stock, libro, hechos/publicaciones históricos y cobertura aprobada siguen en cero. La lectura de base de datos informó modo de autoridad `shadow`; por separado, la configuración canónica informó el flag `false`. No hubo contexto de autenticación en vivo. La migración de payables de las 15:26:20.176 UTC no cambió los conteos: fuentes 21.388, excepciones 4.459, constancias 0, cuentas 0, libro 0, stock 0 y recibos de comandos (`commandReceipt`) 0 antes y después; se verificaron manifiesto de integridad, checksums y ambas constraints usando el mismo respaldo cifrado verificado a las 14:46:06.260 UTC. Bombo aún no tiene evidencia canónica suficiente para declarar utilidad completa, caja disponible, flujo de efectivo completo ni stock histórico activo. No equivale a afirmar que el negocio no tuvo esas operaciones.

La fuente financiera permite consultar lo que contiene el Excel y sus controles. Importar ese archivo no genera asientos, saldos de apertura, obligaciones, hechos históricos publicados ni una aprobación. Una proyección de trece semanas sólo muestra obligaciones y supuestos registrados: no proyecta ingresos ni un saldo final. El commit `e977c6c` incorpora el registro manual de una constancia de cobertura de obligaciones por pagar con UUID y reintento idéntico; no crea obligaciones, cuya carga pertenece al circuito manual existente. El formulario/API ya están en producción. Una constancia parcial más reciente invalida la cobertura anterior; la constancia tampoco certifica que todas las obligaciones estén incluidas. No se registraron constancias ni se crearon obligaciones o asientos durante este trabajo.

## Recorrido preparado en la interfaz

La nueva navegación está publicada en producción:

1. **[Datos cargados](https://bombo.maat.work/app/operations?section=sources)**: buscar las dos fuentes técnicas, abrir tablas y filas, filtrar excepciones y registrar un seguimiento auditable por separado.
2. **[Finanzas](https://bombo.maat.work/app/finanzas)**: consultar estado de resultados operativo, flujo de caja canónico, cobertura, vencimientos de trece semanas y supuestos disponibles.
3. Desde la conciliación, abrir directamente el snapshot en Datos cargados y revisar sus filas/excepciones.

El deployment productivo promovido es `dpl_3cxsEMxsiKuQpoS7LSj8AiRNXYQJ`, con runtime commit `e977c6c540c29996f2d3178aa23c83aea5f4487e`; la inspección del dominio resolvió `bombo.maat.work` a ese mismo ID en estado `READY`. El seguimiento de una fuente técnica conserva la evidencia original y agrega un registro auditable independiente; no aprueba la fuente, resuelve sus excepciones, publica hechos ni activa la contabilidad canónica.

## Qué significan los reportes

- El estado de resultados operativo usa entregas, costos de lote y gastos canónicos. El Excel de observaciones no se cuenta como ventas.
- El flujo de caja se calcula desde el libro canónico y requiere aperturas de cuenta y cierres conciliados. Como esos registros aún son cero, no hay saldo de caja utilizable ni un flujo completo.
- Las trece semanas muestran vencimientos y supuestos cargados. No incluyen ingresos proyectados ni un cierre proyectado.
- El formulario/API de payables ya están desplegados en producción, pero registran sólo constancias de cobertura; la carga de obligaciones sigue en su circuito existente. No se registraron constancias durante este trabajo. La cobertura total y los movimientos canónicos continúan pendientes de datos y conciliación.

El commit `e977c6c` pasó `npm run check` local con 296 pruebas aprobadas, cero fallos y una omisión de restore por opt-in; fingerprint `ef88f73d65eb0455d03b9762933512f4a498a0539e7003661bb97a9f3b15daae`. Pasaron ocho recorridos focalizados de navegador de Finanzas, configuración y habilitación, y la revisión independiente no encontró bloqueantes. Tras la promoción, la inspección pública de `https://bombo.maat.work` a las 15:41:00.216 UTC encontró 291 archivos, 290 idénticos byte por byte; la única diferencia fue `vercel.json`, con `name` y `version` agregados por la CLI de Vercel y verificados por un comparador JavaScript de hash por campo. Huella local `ef88f73d65eb0455d03b9762933512f4a498a0539e7003661bb97a9f3b15daae`, remota `bf4eb2e951849960414103eb642102646def58e2b6e83b27738e05f64a23d807`, Node 24.21, `demo: false` y siete rutas privadas con `401`/`no-store`. El CI del [PR 37951713399](https://github.com/Gigisanta/Club-Canabico/actions/runs/37951713399) y el [push 37951706865](https://github.com/Gigisanta/Club-Canabico/actions/runs/37951706865) pasaron para el SHA exacto `e977c6c`: cada uno completó 299 pruebas de backend sin fallos ni omisiones, 59 recorridos de navegador, 13 controles offline, restauración PostgreSQL (1.676 ms en PR y 1.739 ms en push) y ejercicios de contingencia/configuración de backup. El navegador real de producción abrió `/app/finanzas` en una pantalla de acceso vacía; no hubo sesión humana ni aceptación autenticada.

La UI de Habilitación ofrece `AuthorityActivated` sólo si el servidor lo permite y se cumplen los 14 gates reales. No se activó autoridad ni se aprobaron gates. La lectura post-promoción de las 15:41:02.270 UTC informó modo de autoridad `shadow` en base de datos; por separado, la configuración canónica informó el flag `false`. No hubo contexto de autenticación en vivo. La habilitación depende de datos y respaldos reales, no de la aparición del control en pantalla.

## Controles manuales ya recuperados

La versión desplegada incluye pantallas y comandos para alta/edición de catálogo, proveedores y ubicaciones; preventas y facturas/ventas; recepción y traslado; preparación, entrega y devolución; apertura de stock por lote; compras y obligaciones; gastos, movimientos, rendición y controles de caja. El formulario de apertura de stock exige cantidad, costo y moneda explícitos, ubicación, responsable, evidencia y un preparador activo distinto del aprobador. Los formularios no adivinan costos ni productos.

Hay una distinción entre ver los controles y tener autoridad operativa para ejecutar movimientos reales: la última lectura post-promoción informó modo de autoridad `shadow` en base de datos; la configuración canónica informó el flag `false` y las áreas canónicas indicadas siguen en cero. Los comandos que requieren activación dependen del corte, las aperturas/costos respaldados y la autoridad correspondiente. No se cargaron hechos ficticios ni registros de negocio para que los paneles muestren actividad. El respaldo cifrado verificado a las 14:46:06.260 UTC se reutilizó para la migración de esquema de las 15:26:20.176 UTC; no se creó otro. Los detalles sensibles de ubicación y claves no se documentan aquí.

## Pedidos anteriores que conviene tener a mano

El recorrido y los pedidos históricos de Tiziano están documentados en [AppSheet: recorrido del 29/09](appsheet-walkthrough-2026-09-29.md), [observación de formularios](appsheet-paridad-observada-2026-10-06.md) e [implementación del flujo](appsheet-implementacion-2026-10-06.md). Entre los temas que pueden reaparecer:

- caja por cuenta y detalle de movimientos para explicar diferencias;
- pagos próximos y total semanal, gastos mensuales, compras a plazo y obligaciones;
- barra de equilibrio, gastos fijos, faltante diario, meta de ventas y ritmo del mes;
- stock mínimo y alertas por categoría, stock disponible para venta y margen por categoría;
- promociones y packs medidos, además del margen por producto;
- pagos mixtos, tres cajas ARS, tres USD y operaciones de cambio;
- separar factura/envío de cobro confirmado, y distinguir compra/recepción de pago.

Son necesidades e historial, no evidencia de que todas las reglas estén activas o de que los datos estén conciliados. Stock por categoría y márgenes necesitan catálogo, costos y movimientos respaldados. Cajas y flujo necesitan las cuentas, aperturas, movimientos y conciliación del corte. Packs, tarifas y totales automáticos requieren cotejar las expresiones y automatizaciones actuales de AppSheet.

## Acceso a la definición de AppSheet

El 9 de octubre a las 13:19 UTC, el editor oficial [`/home/apps`](https://www.appsheet.com/home/apps) mostró **“No apps shared with you”** para la cuenta disponible. La app runtime [`Adm_TB`](https://www.appsheet.com/start/5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0) pidió usuario y contraseña internos. No se ingresaron credenciales ni se hicieron cambios en AppSheet; por eso la definición y sus expresiones, acciones, vistas, bots, permisos y filtros siguen sin estar disponibles en esta sesión. El permiso indicado por AppSheet para verla es [View/copy app](https://support.google.com/appsheet/answer/10104983?hl=en).

## Cómo responder mañana con precisión

Se pueden mostrar los controles del Excel y su cobertura, las pantallas manuales y los bloqueos visibles. Se puede explicar el diseño de estado de resultados y flujo, indicando qué campos dependen de aperturas, costos, obligaciones y movimientos faltantes. No presentar los 3.693 renglones como ventas verificadas ni como asientos, ni sumar el archivo empresarial encima del financiero: hay movimientos solapados. La revisión completa de AppSheet, el corte del negocio y una migración contable completa continúan pendientes.

Para el detalle de origen, exclusiones, snapshots, despliegue y controles, ver [Carga y conciliación de fuentes](finance-sources-2026-10-09.md).

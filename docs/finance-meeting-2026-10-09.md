# Preparación financiera para Tiziano

Actualizado el 9 de octubre de 2026 con la consulta de producción de las 13:06:59 UTC y la comprobación de acceso a AppSheet de las 13:19 UTC. Tiziano avisó que quiere conversar sobre estado de resultados, proyecciones tipo cash flow y otros temas financieros. Este documento separa qué se puede mostrar con evidencia, qué está implementado a mano y qué sigue bloqueado por falta de datos o revisión.

## Qué hay disponible con datos reales

La base de producción conserva dos fuentes técnicas independientes:

- Excel financiero: 3.693 movimientos observados; 3.629 elegibles y 64 excluidos. Sus 22 controles mensuales por moneda coinciden exactamente con el cálculo independiente. No se mezclan ARS y USD. La última fecha elegible es el 30 de septiembre de 2026; esta fuente no contiene movimientos elegibles del 1 al 8 de octubre.
- Archivo empresarial AppSheet: 17.695 filas de 32 tablas y 4.395 excepciones. Es un archivo preservado con trazabilidad, no una migración de ventas, catálogo o stock activos. Hay otras seis hojas sólo registradas como cobertura de coordenadas, sin extracción de sus filas.

La lectura `READ ONLY` de producción del 9 de octubre a las 13:06:59 UTC encontró cero catálogo, proveedores, ubicaciones, cuentas canónicas, aperturas de saldo, stock, movimientos de libro, hechos históricos, publicaciones históricas y coberturas aprobadas. Esto significa que Bombo aún no tiene evidencia canónica suficiente para declarar utilidad completa, caja disponible, flujo de efectivo completo ni stock histórico activo. No equivale a afirmar que el negocio no tuvo esas operaciones.

La fuente financiera sí deja consultar lo que contiene el Excel y sus controles. No genera asientos, saldos de apertura, obligaciones, hechos históricos publicados ni una aprobación. Una proyección de trece semanas sólo puede representar obligaciones y supuestos que estén cargados y respaldados; un total vacío no demuestra que no haya pagos futuros.

## Recorrido preparado en la interfaz

En el código del worktree está preparada esta navegación para hacer visibles las fuentes y finanzas:

1. **Datos cargados** (`/app/operations?section=sources`): buscar las dos fuentes técnicas, abrir tablas y filas, filtrar excepciones y registrar un seguimiento auditable por separado.
2. **Finanzas** (`/app/operations?section=finance`): consultar estado de resultados, flujo, cobertura, vencimientos de trece semanas y supuestos disponibles.
3. Desde la conciliación, abrir directamente el snapshot en Datos cargados y revisar sus filas/excepciones.

Estos nuevos recorridos todavía están pendientes de QA, publicación y comprobación en producción. El release vivo comprobado sigue siendo `dpl_BY98m5SQNsPRqGvrKFdiDsZ3yKvn` (`cf6124e`); no se debe presentar la nueva navegación como ya disponible en el dominio. El seguimiento de una fuente técnica conserva la evidencia original y no significa aprobarla, resolver sus excepciones, publicar hechos ni activar la contabilidad canónica.

## Controles manuales ya recuperados

La versión desplegada incluye pantallas y comandos para alta/edición de catálogo, proveedores y ubicaciones; preventas y facturas/ventas; recepción y traslado; preparación, entrega y devolución; apertura de stock por lote; compras y obligaciones; gastos, movimientos, rendición y controles de caja. El formulario de apertura de stock exige cantidad, costo y moneda explícitos, ubicación, responsable, evidencia y un preparador activo distinto del aprobador. Los formularios no adivinan costos ni productos.

Hay una distinción entre poder ver/preparar los controles y tener autoridad operativa para ejecutar movimientos reales: el contexto de producción observado continúa en `shadow`, con la aprobación operativa desactivada y sin saldo/catálogo canónico. Los comandos que requieren activación se rechazan hasta completar el corte, respaldar aperturas/costos y habilitar la autoridad correspondiente. No se cargaron hechos ficticios para que los paneles muestren actividad.

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

Para el detalle de origen, exclusiones, snapshots y controles, ver [Carga y conciliación de fuentes](finance-sources-2026-10-09.md).

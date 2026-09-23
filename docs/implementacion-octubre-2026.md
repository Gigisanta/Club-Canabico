# Apertura del club: trabajo y criterios de aceptación

Fecha de trabajo: 23 de septiembre de 2026. Fecha de planificación del MVP: 30 de octubre de 2026, a confirmar con la apertura real.

## 1. Diagnóstico, hasta el 2 de octubre

Reunir con Tiziano y Camila exportaciones de AppSheet (delivery), Sheets, Power BI, formulario de socios, comprobantes y movimientos de efectivo/banco. Período mínimo deseable: los últimos 12 meses y saldos iniciales del período. Registrar dueño, formato, período y fecha de corte de cada fuente. No ingresar documentos de salud ni números completos de permisos en la app; solo estado, vencimiento y fecha de verificación.

| Conciliación | Cruce necesario | Diferencia a explicar |
| --- | --- | --- |
| Ingresos | AppSheet/Sheets ↔ comprobantes ↔ banco/efectivo | Devengado, cobrado, anulado y pendiente |
| Gastos | Registro ↔ comprobante ↔ fecha de pago | Gasto operativo vs compra de stock vs inversión local |
| Stock | Lote y proveedor ↔ compra ↔ movimientos ↔ conteo físico | Cantidad, costo unitario y merma |
| Dueño | Transferencias de Tiziano ↔ caja/banco | Aporte de capital vs retiro personal |
| Socios | Formulario ↔ registros actuales | Duplicados y verificación vigente |

Definir quién autoriza cada verificación, quién registra caja, cómo se atiende en el local y qué sigue operando en delivery. Cerrar una lista de funciones para octubre con responsables y criterios de aceptación. Los datos externos aún no están disponibles en este repositorio: ningún importe del club está conciliado a la fecha de este documento.

## 2. Base financiera, hasta el 9 de octubre

Resultado de gestión mensual = ingresos netos − costo histórico de unidades entregadas − gastos operativos devengados. Compras de stock aumentan inventario y reducen caja cuando se pagan; no son gasto operativo por segunda vez. Inversiones del local, aportes y retiros se muestran fuera del resultado. Valuación de stock = suma por lote de cantidad actual × costo unitario cargado. Un costo sin factura o con diferencia de unidad queda pendiente de validación.

El libro de caja registra hechos pagados/cobrados por cuenta, categoría, fecha e identificador de origen. Antes de usar el saldo, cargar y conciliar saldo inicial de efectivo y banco. Una venta local crea su movimiento automáticamente; el gasto del módulo Gastos no se considera pagado hasta crear su salida de caja. La proyección de 13 semanas parte del saldo registrado y agrega partidas planificadas por fecha y escenario. Cada fila sin partida o sin saldo inicial indica falta de información, no caja cero confirmada.

Preparar tres escenarios para diciembre de 2026 y un plan mensual de enero a diciembre de 2027. Para cada uno, explicitar volumen de atención, precio, costo de stock, gastos del local, inversiones y fecha e importe de posible contratación. Cargar cada supuesto como partida de proyección; **cada escenario es autónomo**, así que sus costos comunes se cargan también en ese escenario. Revisar mensualmente desvío real vs plan, causa, decisión, responsable y fecha de seguimiento. Las recomendaciones sobre activos de inversión específicos requieren profesional habilitado.

| Mes | Real | Plan | Desvío | Causa | Decisión | Responsable | Fecha de seguimiento |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| Por completar con datos del club | — | — | — | — | — | — | — |

## 3. App interna mínima, hasta el 23 de octubre

La app local es fuente del **local**. AppSheet permanece fuente del **delivery**. Cada registro importado desde una fuente externa debe tener `sourceSystem` y `sourceId`; las ventas nuevas de la app llevan canal `local` e identificador de solicitud. Los cobros del delivery pueden importarse al libro de caja con categoría propia, pero no son ventas locales ni descuentan stock. Antes de confirmar CSV, revisar vista previa, omitidos y conflictos. Repetir una importación debe omitir los mismos registros sin duplicarlos. Un conflicto de mismo ID y datos distintos detiene la importación completa para conciliación.

La ficha de socio guarda solo estado y vigencia del permiso; dueño/gerente pueden cambiarlo, cajero puede verlo, otros roles no reciben detalle de verificación. En bases reales, el endpoint de operaciones con cannabis está deshabilitado por defecto. Activar `CLUB_OPERATIONS_APPROVED=true` solo tras validación documentada por el profesional del club de la figura jurídica, permisos, roles y alcance del flujo. Incluso entonces cada operación exige socio con verificación vigente. El estado global no reemplaza controles documentales externos. No habilitar mensajería ni autogestión en esta etapa.

Los indicadores de caja y resultado se rotulan preliminares hasta conciliar fuentes. El resultado mostrado en la app cubre solo ventas locales, costo vendido en la app y gastos registrados; el consolidado con delivery se elabora a partir de AppSheet y comprobantes. El panel existente de gastos ya no se presenta como flujo de caja. Stock a costo depende de costos por lote confirmados.

## 4. Uso gradual, última semana de octubre

Capacitar por rol con una base de prueba. Durante siete días, comparar cada día caja contada, ingresos y salidas de caja, stock por lote y cambios de socios contra los registros actuales. Guardar una tabla de diferencias con explicación y corrección autorizada. Activar primero administración interna y después el flujo del local permitido por la revisión legal. AppSheet continúa como respaldo y como fuente del delivery hasta conformidad expresa de Tiziano sobre la conciliación. Si faltan permisos o datos, mantener deshabilitado el flujo afectado.

Pendientes de etapa posterior: autogestión, promociones, mensajes automáticos, balanza y reemplazo completo del delivery.

## Propuesta comercial para revisión

Referencia: aproximadamente **ARS 500.000 por mes** por desarrollo y acompañamiento financiero, con seguimiento semanal del producto y una reunión mensual de resultados y decisiones. La propuesta formal debe precisar alcance, dedicación, forma de pago, impuestos y costos externos de infraestructura o servicios. Esta referencia no constituye aceptación ni factura.

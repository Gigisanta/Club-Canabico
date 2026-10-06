# Apertura del club: trabajo y criterios de aceptación

Fecha inicial de trabajo: 23 de septiembre de 2026. Alcance actualizado el 5 de octubre: reemplazo integral del sistema anterior, según la reunión del 29/9 y los archivos existentes de Tiziano. Fecha objetivo de planificación: 30 de octubre de 2026, a confirmar con la apertura real y la aceptación del corte. La revisión actual y sus límites están en [tiziano-parity-2026-10-05.md](tiziano-parity-2026-10-05.md).

## 1. Diagnóstico, hasta el 2 de octubre

Reunir con Tiziano y Camila exportaciones de AppSheet (delivery), Sheets, Power BI, formulario de socios, comprobantes y movimientos de efectivo/banco. Período mínimo deseable: los últimos 12 meses y saldos iniciales del período. Registrar dueño, formato, período y fecha de corte de cada fuente. No ingresar documentos de salud ni números completos de permisos en la app; solo estado, vencimiento y fecha de verificación.

| Conciliación | Cruce necesario | Diferencia a explicar |
| --- | --- | --- |
| Ingresos | AppSheet/Sheets ↔ comprobantes ↔ banco/efectivo | Devengado, cobrado, anulado y pendiente |
| Gastos | Registro ↔ comprobante ↔ fecha de pago | Gasto operativo vs compra de stock vs inversión local |
| Stock | Lote y proveedor ↔ compra ↔ movimientos ↔ conteo físico | Cantidad, costo unitario y merma |
| Dueño | Transferencias de Tiziano ↔ caja/banco | Aporte de capital vs retiro personal |
| Socios | Formulario ↔ registros actuales | Duplicados y verificación vigente |

Definir quién autoriza cada verificación, quién registra caja y cómo se atiende en el local y en reparto. Cerrar una lista de funciones con responsables y criterios de aceptación. El Excel y el PBIX enviados ya se analizaron como fuentes externas; sus archivos privados no se incorporan al repositorio. Ese análisis no concilia importes ni aprueba saldos del club.

## 2. Base financiera, hasta el 9 de octubre

Resultado de gestión mensual = ingresos netos − costo histórico de unidades entregadas − gastos operativos devengados. Compras de stock aumentan inventario y reducen caja cuando se pagan; no son gasto operativo por segunda vez. Inversiones del local, aportes y retiros se muestran fuera del resultado. Valuación de stock = suma por lote de cantidad actual × costo unitario cargado. Un costo sin factura o con diferencia de unidad queda pendiente de validación.

El libro de caja registra hechos pagados/cobrados por cuenta, categoría, fecha e identificador de origen. Antes de usar el saldo, cargar y conciliar efectivo y banco por cuenta y fecha. En el circuito canónico, confirmar o entregar un pedido no acredita por sí solo dinero recibido: el cobro reportado necesita verificación y la obligación necesita un pago registrado. Los endpoints de venta del flujo anterior son compatibilidad y se retiran como writers al activar el corte integral. La proyección verificable de 13 semanas usa un saldo conciliado del día y partidas fechadas en los tres escenarios; exige confirmar la cobertura completa del período. El plan de caja anterior de la app sirve de referencia operativa, pero no habilita por sí solo una proyección certificada. Cada fila sin partida o sin saldo indica falta de información, no caja cero confirmada.

Preparar tres escenarios para diciembre de 2026 y un plan mensual de enero a diciembre de 2027. Para cada uno, explicitar volumen de atención, precio, costo de stock, gastos del local, inversiones y fecha e importe de posible contratación. Cargar cada supuesto como partida de proyección; **cada escenario es autónomo**, así que sus costos comunes se cargan también en ese escenario. Revisar mensualmente desvío real vs plan, causa, decisión, responsable y fecha de seguimiento. Las recomendaciones sobre activos de inversión específicos requieren profesional habilitado.

| Mes | Real | Plan | Desvío | Causa | Decisión | Responsable | Fecha de seguimiento |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| Por completar con datos del club | — | — | — | — | — | — | — |

## 3. Circuito integral, objetivo hasta el 23 de octubre

El objetivo vigente incluye administración, local y reparto en Bombo, y el reemplazo de AppSheet y Power BI. Hasta un corte autorizado y aceptado, la autoridad real de cada circuito sigue su configuración vigente; una mejora local no la cambia. Compras, stock, pedidos, entregas, cobros y caja comparten hechos y deben pasar juntos al sistema canónico. Cada registro histórico conserva `sourceSystem` y `sourceId`; los comandos nuevos conservan su identificador de solicitud. Importar historia no vuelve a ejecutar ventas, descontar stock ni generar cobros. Antes de confirmar una importación, revisar vista previa, omitidos y conflictos. Repetirla no duplica registros; mismo ID con datos distintos exige conciliación. Los objetos abiertos y los saldos iniciales se aprueban por separado de la historia.

La ficha de socio guarda solo estado y vigencia del permiso; dueño/gerente pueden cambiarlo, cajero puede verlo, otros roles no reciben detalle de verificación. En bases reales, el endpoint de operaciones con cannabis está deshabilitado por defecto. Activar `CLUB_OPERATIONS_APPROVED=true` solo tras validación documentada por el profesional del club de la figura jurídica, permisos, roles y alcance del flujo. Incluso entonces cada operación exige socio con verificación vigente. El estado global no reemplaza controles documentales externos. No habilitar mensajería ni autogestión en esta etapa.

Los indicadores de caja y resultado se rotulan preliminares hasta conciliar fuentes y verificar cobertura, moneda y período. Los informes canónicos abarcan los canales local y reparto según los hechos efectivamente registrados; los informes de compatibilidad conservan su alcance anterior. La historia importada no certifica equivalencia con los resultados del PBIX. El panel de gastos no se presenta como flujo de caja. Stock a costo depende de costos por lote confirmados.

En octubre también se calculan y comparan **precios, promociones y segmentos** para revisión humana. Camila revisa la propuesta y Tiziano aprueba cualquier decisión comercial; la app no envía mensajes ni aplica campañas automáticamente. La simulación muestra contribución y volumen adicional de equilibrio, sin atribuir causalidad a comparaciones históricas.

## 4. Uso gradual, última semana de octubre

Capacitar por rol con una base de prueba y validar el reparto en el Android real. Durante siete días de operación sombra, comparar caja contada, ingresos y salidas, stock por lote, pedidos, entregas y cambios de socios contra los registros actuales. Guardar diferencias, explicación y corrección autorizada. Aceptar restauración, exportación final, delta, objetos abiertos, aperturas, informes y permisos profesionales; drenar colas y deshabilitar writers anteriores antes del corte conjunto. AppSheet y sus exportaciones se conservan para consulta y respaldo después del corte, sin seguir escribiendo el mismo circuito. La configuración y los gates actuales están descritos en [operacion-canonica.md](operacion-canonica.md) e [instalacion-operativa.md](instalacion-operativa.md). Esta planificación no autoriza activar producción.

Fuera de esta entrega: autogestión y balanza. Tiziano rechazó WhatsApp API y mensajes automáticos en la reunión; conservar su historia no autoriza reactivar campañas. El reemplazo completo del reparto forma parte del objetivo vigente y depende de su aceptación real, no de una etapa indefinida posterior.

## Propuesta comercial para revisión

Referencia: aproximadamente **ARS 500.000 por mes** por desarrollo y acompañamiento financiero, con seguimiento semanal del producto y una reunión mensual de resultados y decisiones. La propuesta formal debe precisar alcance, dedicación, forma de pago, impuestos y costos externos de infraestructura o servicios. Esta referencia no constituye aceptación ni factura.

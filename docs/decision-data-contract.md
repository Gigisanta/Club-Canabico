# Contrato de decisiones, fuentes y aceptación

Este documento fija el significado operativo de los indicadores antes de recibir archivos reales. Tiziano, Camila y Gio deberán revisar las definiciones con un caso real y dejar constancia de cualquier cambio. La versión inicial del motor es `decision-v1`.

## Autoridad de cada dato

| Dato | Fuente inicial | Regla |
| --- | --- | --- |
| Venta del local | Bombo | Descuenta el lote y crea el asiento local una sola vez. |
| Venta histórica de delivery | Exportación AppSheet | Hecho analítico separado. No modifica stock ni caja local. |
| Cobro de delivery | Caja/banco conciliado | Movimiento financiero con ID de origen. No crea otra venta. |
| Existencia por lote | Conteo físico o movimiento documentado | Nunca sumar delivery y local hasta confirmar si comparten depósito. |
| Costo histórico | Comprobante del lote | Se aplica a las unidades vendidas de ese lote. |
| Costo de reposición | Cotización fechada del proveedor | Sirve para simular compras y precios; no sustituye el costo histórico. |
| Saldo disponible | Apertura conciliada + cobros − pagos | Mostrar por cuenta y fecha; resultado e inventario se muestran aparte. |

Todo hecho importado debe llevar sistema, ID único de origen, archivo/lote, fecha de corte y estado de conciliación. La repetición exacta se omite; igual ID con datos distintos bloquea la transacción completa. Una conciliación registrada exige un revisor distinto de quien importó, cantidad de hechos según el reporte de origen, total monetario externo cuando corresponde, diferencia cero, referencia y notas. El servidor coteja cantidad e importe contra el lote. La cobertura completa además exige fechas de inicio y fin, y ninguna fila rechazada. Sigue siendo una atestación humana: la app no puede probar por sí sola que el reporte externo sea completo o auténtico. Los hechos de delivery entran al pronóstico solo si su origen está en lotes conciliados con cobertura completa; un hecho conocido sin esa evidencia deja el pronóstico indisponible. Las anulaciones se rechazan para revisión manual hasta incorporar una reversión vinculada; nunca se borra una venta confirmada. Si falta un dato indispensable, el resultado es `null` y la interfaz explica cuál falta. `0` solo significa cero comprobado.

## Cálculos

- **Ingreso neto:** en ventas importadas, `total` representa el bruto antes del descuento y `discount` el descuento no negativo; el pronóstico usa `total - discount`. El control monetario del archivo compara el bruto registrado con el reporte de origen. La suma de líneas después de descuentos es el ingreso neto; envío cobrado, envío pagado y obsequios se exponen por separado. El margen de contribución de una línea es ingreso neto menos costo histórico y costos variables asignables. El gasto fijo se resta para obtener resultado de gestión, no se asigna arbitrariamente a cada artículo.
- **Valuación de stock:** cantidad disponible en su unidad explícita multiplicada por costo histórico de cada lote. Las transferencias de ubicación no alteran valor total.
- **Reposición:** demanda para el plazo de entrega más cobertura objetivo, menos stock utilizable y pedidos ya confirmados, respetando múltiplos y mínimos del proveedor. Sin historia de disponibilidad y plazos verificables, mostrar cobertura descriptiva y riesgo cualitativo; no ofrecer una probabilidad numérica de quiebre.
- **Promoción:** contribución por unidad antes y después, costo de regalos/envío, pérdida por descuento y unidades adicionales necesarias para empatar la contribución anterior. La comparación observacional no demuestra que la promoción causó ventas adicionales. El resultado es una propuesta para revisión humana.
- **Caja de 13 semanas:** saldo inicial conciliado más cobros y pagos fechados por semana y escenario. Una compra aumenta inventario; el pago afecta caja; el costo afecta resultado al venderse la unidad. Aportes y retiros se separan del resultado operativo. Un gasto devengado sin pago reduce resultado, pero no caja todavía.
- **Contratación:** costo laboral completo ingresado y revisado, dividido por contribución incremental unitaria; también exigir saldo mínimo de caja parametrizado. Sin esos insumos, no emitir recomendación de contratar.
- **Pronóstico:** referencias de patrón semanal y mediana reciente. Evaluar errores mediante cortes temporales sucesivos y publicar sesgo, error absoluto, tamaño de muestra y cobertura del intervalo por horizonte. Mostrar el modelo complejo solo si supera la referencia en datos fuera de muestra. Diciembre de 2026 y 2027 son escenarios con supuestos visibles hasta contar con historia suficiente; no presentar probabilidades medidas.

Todos los importes nuevos del motor usan centavos enteros firmados de 64 bits y se serializan a JSON como cadenas decimales. Las cantidades se almacenan en milésimas junto con su unidad. Las vistas anteriores con `Int` son de compatibilidad y no autorizan convertir importes grandes a `Number`.

## Insumos configurables antes de recibir archivos reales

En **Preparar decisiones** se registra la definición de ubicaciones compartidas o separadas, reglas de plazo y mínimo por producto, cotizaciones fechadas, entregas pendientes, saldos de caja por cuenta, partidas futuras por escenario y atestaciones de cobertura. Cada entrada conserva responsable, fecha y referencia. Hasta que Tiziano confirme el uso físico del stock, el motor bloquea la propuesta de compra conjunta. Para una caja de 13 semanas calculada se requieren el saldo conciliado del día y una atestación de cobertura continua de 91 días por escenario. Para pronosticar delivery se requiere un lote de ventas conciliado con cobertura completa y período suficiente; los días sin ventas dentro de ese período se consideran cero comprobado. Una cotización de reposición no modifica el costo histórico del lote.

Las revisiones mensuales manuales pueden registrar real, plan, causa y decisión, pero no se autodeclaran `reconciled`: ese estado requiere enlace y recálculo desde fuentes conciliadas. La app no dispone de contactos habilitados para envíos comerciales.

## Estados visibles

`demo` identifica datos ficticios; `imported` significa recibido sin conciliar; `reconciled` exige respaldo y comparación; `estimated` es un cálculo a partir de entradas identificadas; `scenario` depende de supuestos explícitos; `missing` significa que faltan insumos. Cada tarjeta y detalle debe mostrar fecha, fuente y versión. Una cifra mezclada con entradas importadas sin conciliar no puede rotularse conciliada.

## Aceptación previa al uso real

1. Con archivos sintéticos: importar dos veces sin duplicar; modificar un monto con el mismo ID y verificar rechazo completo; ensayar anulación, paquete mixto, entrega en dos fechas y stock agotado.
2. Comparar al centavo ingreso, costo, valor de stock, pagos y caja con un caso calculado manualmente. Probar al menos un importe mayor que `2_147_483_647` centavos.
3. Verificar acceso de owner/admin a finanzas y listas, rechazo para caja/visor y bitácora de accesos sensibles. Confirmar que ninguna lista salga automáticamente de la app.
4. Al recibir archivos reales: inventario de fuentes, mapeo firmado, saldos iniciales, conteo por lote, proveedores y plazos. Tiziano decidirá si el stock de delivery y local es compartido. Camila revisará segmentos y promociones; Gio, números y conciliación; Tiziano aprobará decisiones comerciales.
5. Hacer siete días de operación paralela con AppSheet como fuente de delivery. Cerrar cada jornada con cero diferencias sin explicación en ventas, stock y caja. Mantener la activación real bloqueada hasta la conformidad del club y su profesional.

## Registro de decisiones pendientes

- Figura jurídica, alcance de permisos y flujo autorizado en CABA.
- Stock físico compartido o separado; ubicaciones, lotes y transferencias.
- Política contable de costos, envíos, devoluciones, obsequios, impuestos y aportes.
- Saldos iniciales conciliados, cuentas y fechas de pago/cobro.
- Plazos y mínimos de proveedores, horizonte de cobertura y saldo mínimo de caja.
- Base legal y tratamiento de datos de contacto para listas comerciales.

Hasta cerrar cada punto, la app debe mostrar la limitación y evitar recomendaciones que dependan de esa definición.

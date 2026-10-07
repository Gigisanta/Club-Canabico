# Flujo de AppSheet para la paridad de BomboClub

La venta de AppSheet contiene productos y un viaje en moto como cargas separadas. Cada parte tiene su propia forma de pago. BomboClub debe conservar las tareas, campos, orden y confirmaciones que usa Tiziano, con la identidad visual de Bombo. Esta observación del 6 de octubre de 2026 amplía el [recorrido del 29 de septiembre](appsheet-walkthrough-2026-09-29.md); no adopta sus límites históricos del piloto como autorización vigente.

## Fuentes y alcance de la comprobación

| Fuente | Qué permite afirmar |
| --- | --- |
| [Adm_TB en AppSheet](https://www.appsheet.com/start/5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0) | Etiquetas, orden, controles editables y deshabilitados, formularios anidados y acciones visibles del acceso actual. |
| Recorrido de Tiziano del 29 de septiembre, confirmado vigente por el usuario | Relación entre factura, envío, confirmación de cobro, stock, compras y cajas. |
| Excel `2025_PP_Appsheet_TB (2).xlsx` y PBIX `2026.06.ADMTB_Reporte.pbix` entregados | Estructura y datos históricos de sus respectivos snapshots; no equivalen al estado vivo de AppSheet. |
| Código local de Bombo y candidato `a916ed9104a56314020e8c47bbe4ba2251c7396d` | Diferencias de formularios y comportamiento implementado. No acredita el estado de producción de BomboClub. |

La inspección abrió formularios vacíos y los canceló. No pulsó Guardar ni ejecutó entregas, cobros, mensajes, generación de cartas o cambios de stock. El documento no contiene datos de socios, direcciones, documentos, credenciales ni valores de operaciones reales.

## Venta y formularios anidados

El acceso actual muestra Ventas con tarjetas agrupadas por fecha, identificadores de factura y envío, e importe. Las tarjetas ofrecen Remito, View Ref (Cliente), Editar y Eliminar. La acción Agregar abre `C Facturacion Form`.

El formulario presenta este orden:

1. Nro Factura, Fecha, Cliente y Domicilio.
2. Agregar producto, con un botón Añadir que abre `C Detalle Fact Form`.
3. Cargar viaje en Moto, con otro Añadir que abre `C Moto Form`.
4. Servicio de moto, con NO y Sí.
5. Forma de pago, con ARS, Transferencia y Mercado Pago.
6. Gramos, Monto parcial, Transferencia y Total facturado, todos deshabilitados en el formulario vacío observado.
7. Aclaración. La cabecera ofrece Cancelar y Guardar.

Tiziano describió que seleccionar el cliente completa el domicilio. Ese autocompletado requiere cotejarse en una copia de prueba; no se seleccionó un socio real durante esta inspección.

| Formulario de producto | Control observado |
| --- | --- |
| Id_Detalle | Campo editable con identificador inicial. |
| ID. Factura | Referencia presentada a la factura del formulario padre. |
| Fecha | Fecha editable. |
| Variedad | Selector. |
| Escala_Tarifaria | Selector separado de Variedad. |
| Gramos pedidos | Cantidad editable. |
| Valor total | Importe editable por línea; no es solamente un total de lectura. |
| N_Factura_Virtual | Campo deshabilitado. |

En una segunda inspección del formulario vacío del 6 de octubre se abrió el selector `Escala_Tarifaria`, sin elegir variedad ni guardar. Sus opciones visibles fueron `Precio_5_Gramos`, `Precio_10_Gramos`, `Precio_15_Gramos`, `Precio_20_Gramos`, `Precio_25_Gramos`, `Precio_30_Gramos`, `Pack Premium`, `Pack Amigos` y `Promo_C`. Estos nombres no prueban cómo calculan precios.

| Formulario de moto | Control observado |
| --- | --- |
| Envio moto | Referencia presentada a la factura del formulario padre. |
| Fecha_Entrega | Fecha editable independiente de Fecha de la factura. |
| Forma de pago moto | ARS, Transferencia y Mercado Pago, independientemente del medio de la factura. |
| Tipo de Servicio | Selector; CABA aparece inicialmente en el formulario vacío observado. |
| Destino | Campo editable con nombre accesible Moto_Cliente_Destino. |
| Tarifa Cliente | Importe editable. |
| Transferencia moto y Subtotal cliente | Campos deshabilitados. |
| Tarifa Administracion | Importe editable separado de Tarifa Cliente. |
| Total Tarifa | Importe editable. |
| Aclaraciones | Texto editable. |
| Cantidad Transportada | Campo deshabilitado. |

La segunda inspección del selector `Tipo de Servicio` mostró `CABA`, `Zona Norte 1`, `Zona Norte 2`, `CABA - ENVIO GRATIS` y `PBA`. Se cancelaron el formulario de moto y la factura; no se ejecutó Guardar. Las tarifas iniciales de esa sesión tampoco se adoptan como tarifas universales.

Los valores iniciales observados no establecen tarifas universales. Tampoco el estado deshabilitado demuestra una fórmula concreta. Hay que revisar expresiones, reglas condicionales, validaciones y efectos de Guardar antes de copiar cálculos o automatizaciones.

## Envíos catálogo y preventa

En Envios se observó una tarjeta respaldada por `Pedido_Moto`. Su detalle ofrece las acciones ✅ Entrega realizada, Enviar ruta y ubicación, Crear Carta, Descargar Carta, WAP_tTempo_Envio y Credencial. También aparecen accesos a llamada, mapa y referencia de cliente. Estos nombres acreditan controles visibles; no acreditan los destinatarios, contenido o efectos de ejecutarlos.

Catalogo de productos presenta Tipo Variedad, Disponibilidad, Segmento Tarifario y columnas de cantidad. Agregar abre `D Catalogo Mercaderia Form`, con CatalogoID, Tipo Variedad, Descripcion, Disponibilidad NO/Sí, Segmento Tarifario Premium/Estandar, Precio_5_Gramos, 10 a 15 Gr., 15 a 20 Gr., 20 a 25 Gr., 25 a 30 Gr., Más 30 Gr., Promo A:, Promo B:, Promo C:, Tarifa_Cliente, Tarifa_Administración y Total. Los controles de precios por tramo, promociones y tarifas son editables. La relación entre estas entradas y Escala_Tarifaria sigue pendiente de definición; no se infiere a partir de la coincidencia de etiquetas.

Pre_Venta tiene Agregar y acciones por registro: Formulario Venta, Delete 2, Editar y View Ref (fw_Cliente). El formulario vacío `Pre Venta Form` muestra Fecha deshabilitada y Nombre del asociado como selector obligatorio. No se comprobaron campos condicionales posteriores a seleccionar un asociado. Control_Preventa aparece como sección separada; su criterio de inclusión no está comprobado.

## Reglas del circuito descrito por Tiziano

Estas reglas provienen del recorrido vigente del 29 de septiembre y requieren cotejo de la definición o ejecución en una copia de prueba. No son efectos ejecutados en la app viva durante esta inspección.

- Crear la factura da origen al envío. Los productos y el viaje están relacionados con la misma factura.
- Factura generada y dinero recibido son hechos distintos. Control de ventas confirma el cobro; recién entonces el dinero afecta cajas y movimientos. El efectivo puede recibirse al día siguiente.
- Compra, recepción física y pago tienen fechas y efectos distintos. Una compra recibida y pendiente de pago aumenta stock sin reducir caja por ese hecho.
- El stock se identifica por lote. La merma puede registrarse al terminar el lote; no se debe reinterpretar automáticamente como una medición diaria exacta.
- El arqueo compara dinero contado con registros de tres cajas ARS y tres USD. Movimientos sirve para investigar diferencias.
- Los gastos se cargan manualmente; el gasto de moto que antes estuvo automatizado también fue descrito como manual.
- Los informes de stock y resultados se consultan en Power BI. El PBIX y el Excel entregados representan snapshots diferentes; una comparación de cifras necesita el mismo período, filtros y población.

Estos son circuitos que se activan por distintos eventos. Las fuentes no establecen una secuencia fija de mañana a noche ni que Tiziano compre, reciba mercadería, registre merma o haga operaciones de cambio todos los días.

## Diferencias que BomboClub debe resolver

| Distinción de AppSheet | Bombo local y candidato |
| --- | --- |
| Factura, envío y cobro posterior | El formulario local Nueva venta confirma venta y cobro juntos; el backend fija el canal local. El candidato separa pedido, cotización, confirmación y verificación de cobro, pero agrega pasos y usa otros nombres. |
| Viaje de moto dentro de la venta | El formulario local no incluye domicilio ni tarifas de moto. En el candidato se observaron importes y recargos de entrega, sin equivalencia explícita de Tarifa Cliente, Tarifa Administracion y Total Tarifa. |
| Forma de pago independiente para producto y moto | El candidato contempla medios separados para producto y entrega. Falta confirmar la misma interacción y las mismas cuentas finales. |
| Mercado Pago como opción explícita | Local y candidato usan categorías como efectivo, transferencia y tarjeta. No se debe asumir que tarjeta equivale a Mercado Pago. |
| Valor total editable por línea | El candidato presenta precio unitario manual con motivo y total calculado. La interacción no es la del formulario observado. |
| Recepción con pago pendiente | El candidato distingue compras, recepción y obligaciones. El formulario de obligación no expone el vínculo opcional con la compra; no se acredita la misma secuencia de Tiziano. |
| Seis cajas y dos monedas | El local usa cash/bank. El candidato tiene cuentas separadas y FX; falta cotejar nombres, confirmaciones y arqueos por cuenta con AppSheet. |

El contraste local se apoya en [Sales.tsx](../src/Sales.tsx) y [server/app.ts](../server/app.ts), ambos con trabajo concurrente, y en `git show a916ed9:src/operations-ui/OperationalWorkspace.tsx`. El candidato es una referencia versionada; su antiguo directorio de worktree ya no estaba disponible durante el contraste del 6 de octubre.

## Comprobaciones pendientes para declarar paridad

El menú del acceso inspeccionado muestra Ventas, Envios, Campaña_WhatsAPP, Catalogo de productos, Control_Preventa, Destinatarios_Difusion, Pre_Venta e Iniciar Sesión. No permite afirmar que las secciones administrativas descritas por Tiziano hayan sido eliminadas: pueden depender del perfil o de vistas no presentes en este acceso.

Para cerrar la paridad falta ver el perfil que usa Tiziano y la definición compartida con permiso View/copy app. Deben cotejarse vistas y filtros, expresiones de importes y cantidades, acciones agrupadas, automatizaciones al guardar, permisos y sincronización. En particular: domicilio al elegir cliente; factura guardada y envío generado; cobro diferido sin caja anticipada; medios distintos para producto y moto; recepción pendiente de pago; y arqueo separado de cada una de las seis cajas.

La paridad no está certificada. El estado observado alcanza para fijar los campos y diferencias anteriores, sin atribuir reglas invisibles a la interfaz ni confundir código candidato con operación desplegada.

# AppSheet 29/09 vs piloto octubre

Club: Bombo. Reunión Gio–Tizi, 29/09/2026, ~113 min (`durationSec` 6783).
Entregable de inventario. No es plan de implementación. No reemplaza el deck `docs/reunion-tizi-2026-09-29.html`.

| Fuente | Qué es | Confianza |
| --- | --- | --- |
| Transcripción `recording-meet-1790701193-0ed40acd-9056-48bc-85ac-8a80bb64c14d.txt` | Fuente de verdad del paneo | alta |
| `docs/implementacion-octubre-2026.md`, `docs/decision-data-contract.md`, `README.md` | Locks del piloto | alta |
| `shared/types.ts`, `shared/data-import.ts`, `src/Finance.tsx` | Qué hace Bombo hoy | alta |
| Summary automático `meet-1790701193-….summary.json` | Recorta y mezcla deseos con hechos; no usar solo | baja |

El summary pone a Kami de asistente. En la sala estuvieron Gio y Tizi. Kami = Camila; se la nombra para una reunión posterior. Tizi ofreció Excel ahora y dijo que AppSheet se lo tiene que mostrar él para no pedirle acceso al otro.

---

## 1. Módulos AppSheet observados

Tizi dijo que “es un montón” y “tengo una, 6 nomás”. El walkthrough mostró más pantallas que seis. No hay export a la vista: esto es lo que se vio en UI, no el esquema de Sheets.

| # | Módulo (etiqueta oral) | Qué hace hoy | Acoplamiento | Líneas |
| --- | --- | --- | --- | --- |
| 1 | Ficha del cliente | Primera hoja. Datos del socio; contrato y credencial ReproCAN cargados como archivo. Tipo de cliente (ocasional vs mayor facturación). Domicilio nutre ventas. | Fuente de envíos y de carta de porte | 217–222, 41–42 |
| 2 | Ventas | Elige cliente → domicilio staff. Suma productos. Escala tarifaria / packs (15, 20). Promo. Medio de pago. Servicio de moto. Crear factura crea el envío. | Ventas + envíos + caja (cuando se confirma cobro) | 20, 228–242, 256–260 |
| 3 | Envíos | Vista del motoquero. Descarga credencial + carta de porte (patente, transportista, gramos, origen/destino). Lento. Tarifas: cliente / administración / motoquero. CABA: club pone siempre una parte. | Se nutre de factura + ficha | 18, 221–227, 235–241 |
| 4 | Carga de mercadería | Entradas de stock. Fecha de compra vs fecha de entrega. Compra a pagar: stock entra, caja no sale. Siempre ARS aunque se pague en USD. Costo/gramo. Lote para merma. | Stock AppSheet + caja + Power BI | 193–198, 242–248, 268–269 |
| 5 | Control de ventas | Factura generada ≠ cobro. Hasta confirmar el pago no entra a caja ni a movimientos. Pago en efectivo suele llegar al día siguiente. | Filtro previo a caja | 256–260 |
| 6 | Movimientos | Historial filtrable (ingresos, qué caja). Tizi lo usa cuando el arqueo no da. Dijo que el historial existe pero no está enganchado a la vista de caja. | Cajas | 190–192, 254–255, 265 |
| 7 | Cajas / arqueo | Contar y que dé. Tres cajas ARS + tres USD. | Movimientos, ventas confirmadas, gastos | 263–266 |
| 8 | Carga de gastos | Categorías orales: sueldos, operación, moto, extraordinario, impuestos. Gasto de moto estuvo automatizado y volvió a manual. | Cajas | 151–156, 261–262 |
| — | Power BI (afuera de AppSheet) | Stock y resultados financieros. Tizi cree que se nutre del Excel; no sabe si es live. Lo sacaron de AppSheet para que no pese. | Excel (?) | 26–27, 267–280 |
| — | Excel suelto | “No es el AppSheets”; Tizi lo puede pasar sin pedirle al otro. | Base de Power BI, según él | 188–189, 279 |

Fuera del walkthrough de hojas, Tizi describió: ruteo tipo Maps / “labships”, mensaje al socio con ETA, usuario del delivery, packs que Kami cargaría, catálogo web semanal a mano, WhatsApp API (le dijo que no al otro). Eso no se vio como hoja; queda en §4 y §6.

---

## 2. Campos / IDs vistos

Nombres de columna Excel: desconocidos hasta el export. Abajo, solo etiquetas que Tizi nombró.

| Etiqueta oral | Dónde | Uso | Columna Excel |
| --- | --- | --- | --- |
| Fecha de nacimiento | Ficha | Dato de socio | desconocido |
| CABA (domicilio / zona) | Ficha / ventas | Nutre staff y tarifa de envío | desconocido |
| Contrato | Ficha (archivo, reciente) | Descarga motoquero | no importar a Bombo |
| Credencial ReproCAN | Ficha (archivo, reciente) | Descarga motoquero | no importar a Bombo |
| Carta de porte | Envíos | Patente, transportista, gramos, origen, destino | no importar a Bombo |
| Tipo de cliente / ocasional / mayor facturación / alto volumen | Ficha → ventas | Envío gratis o no; “estrellita” | desconocido |
| Domicilio staff | Ventas, auto de ficha | Destino | desconocido |
| Variedad (ej. nombre comercial) | Ventas / mercadería | Ítem | desconocido |
| Escala tarifaria / pack 15 / pack 20 | Ventas | Precio por cantidad; Tizi lo trata como promo | desconocido |
| Promo / pack (cata interior, promo cata premium) | Ventas | Kami lo cargaría; 5 de cada categoría premium | desconocido |
| Medio de pago: efectivo / transferencia / Mercado Pago | Ventas | MP = caja que redirige a Galicia (cuenta del hermano, oral) | desconocido |
| Servicio de moto sí/no | Ventas | Tizi: paso al pedo si ya hay viaje | desconocido |
| Tarifa cliente / administración / motoquero | Ventas–envíos | CABA: club cubre una parte fija | desconocido |
| Zona norte | Ventas | Tarifa preestablecida | desconocido |
| Confirmar cobro | Control de ventas | Recién ahí pega caja y movimientos | desconocido |
| Fecha de compra | Mercadería | Compra | `orderDate` candidato en import compras, si el Excel lo trae |
| Fecha de entrega | Mercadería | Ingreso físico; “a pagar” = stock sí, caja no | `date` candidato en import compras |
| Cantidad ingresada (gramos) | Mercadería | Stock | desconocido |
| Valor total (siempre pesos) | Mercadería | Costo; FX se aplica a mano | desconocido |
| Costo por gramo / ganancia estimada | Mercadería | Tizi: la ganancia “no importa mucho” | desconocido |
| Código de lote | Mercadería | Análisis de merma | `lot` ya existe en Bombo; ID de origen AppSheet desconocido |
| Merma | Oral; a veces al cierre del lote | Sobrante vs “dar de más” en balanza | desconocido |
| ARG efectivo / Galicia / Mercado Pago | Cajas ARS | Tres cuentas en pesos | Bombo solo `cash` \| `bank` |
| Tres cajas USD | Cajas | Nombres no dichos | no hay cuenta USD en Bombo |
| Tipo de cambio / compra en dólares / nro. de factura | Movimiento FX | Plata entra en ARS, después compra USD | desconocido |
| Gasto moto / extraordinario / impuestos / sueldos / operación | Gastos | Ver § mapeo; no ampliar enum | desconocido |

`sourceSystem` / `sourceId` no se vieron en AppSheet. En Bombo son obligatorios al importar. Hasta el Excel, no hay mapa fila a fila.

---

## 3. Qué ya cubre Bombo

| AppSheet / deseo | Bombo hoy | Nota |
| --- | --- | --- |
| Ficha de socio | Alta/edición, notas, puntos, nivel, historial, frecuencia, segmentos | Permiso: solo `permitStatus`, `permitValidUntil`, `permitCheckedAt`. Sin contratos, credenciales, carta de porte ni número completo. Segundo lote: la lectura automática muestra la categoría preferida, en cuántas compras aparece y su variedad más elegida (L203: “dirá indoor, outdoor premium”) |
| Ventas con carrito y medio de pago | Ventas locales: efectivo / tarjeta / transferencia; descuentos; comprobante imprimible | No es factura fiscal. No crea envío. Primer lote (30/09): pago mixto efectivo + transferencia o tarjeta, con un asiento por cuenta |
| Historial de caja | `/list/cash-entries`; venta local crea movimiento; cierre con esperado / contado / diferencia | Ya está. No reconstruir. Tizi pidió “ver por qué subió”: el primer lote suma Efectivo/Banco con saldo según registros, saldo después de cada movimiento y filtros |
| Cuentas | `cash` \| `bank` | AppSheet tiene 6 cajas. Importar MP+Galicia → `bank` salvo que el Excel distinga efectivo |
| Categorías de movimiento | Enum cerrado: `opening_balance`, `operating_expense`, `stock_purchase`, `local_investment`, `capital_contribution`, `owner_draw`, `delivery_receipt`, `other_income`, `other_outflow`, `adjustment` (+ `sale` en el libro local de una venta) | No ampliar. Gastos de Tizi se mapean, no se crean |
| Stock por lote + mínimo | Lotes, mínimo, alertas por lote, entradas/salidas/ajustes/traspasos, proveedor, vencimiento | Sigue el mínimo por lote. Primer lote: categorías con mínimo de variedades (ej. Interior Premium: 3 de 5) |
| Compra a pagar (stock ≠ caja) | Compra de stock y salida de caja son hechos distintos; import compras admite `orderDate` vs fecha de recepción | No hay cuentas por pagar como módulo |
| Delivery | Import `/app/importar`: ventas/líneas delivery, cobros `delivery_receipt` | No descuenta stock local. No es la app del motoquero |
| Packs / promos | Import de promociones + simulación en `/app/decisiones/comercial` | Revisión humana. Camila revisa; Tizi aprueba. No se aplican solos |
| Roles | dueño, gerente, responsable, cajero, solo lectura | Camila y Gio ya reservados gerente. No hay rol delivery |
| Base | PostgreSQL, no Sheets. App instalable no aplica: es web | AppSheet: Android instalable + link en compu; datos tipo Sheets; se rompe |

Moneda de Bombo: ARS. Cambiar moneda con ventas existentes está bloqueado. Las tres cajas USD no entran como cuentas en octubre.

---

## 4. Qué entra en octubre vs backlog

Criterio: locks del orchestrator + `implementacion-octubre-2026.md`. El deseo de Tizi (“todo AppSheet emigrado acá, más cashflow”) no mueve el corte.

Actualización 30/09: se adelantan a octubre cuatro pedidos de la reunión como **primer lote** en la app: barra de equilibrio, caja por cuenta, variedades por categoría y pago mixto. Un **segundo lote** suma próximos pagos (L36: “el mes que viene se cumple el plazo de la compra… avisame, va a salir esta plata… semanal”) el stock y el margen por categoría comercial (L271: “más organizado por categoría”) y la categoría preferida de cada socio (L203). Ninguno toca delivery, que sigue en AppSheet.

| Tema | Octubre | Backlog / etapa posterior | Humano |
| --- | --- | --- | --- |
| Fuente de delivery | AppSheet sigue | Corte expreso de Tizi después de conciliar | Tizi |
| Fuente de local | Bombo | — | — |
| Import AppSheet/Excel/caja | Sí, con `sourceSystem`+`sourceId`, vista previa, idempotencia, conflictos | Sync continuo | Falta el Excel |
| Ficha permiso | Estado, vencimiento, fecha de verificación | Contratos, ReproCAN, carta de porte, descarga motoquero | Revisión legal |
| Factura “cuota social” mensual, no MP, transferencia + cruce banco | Documentar la regla | Facturación fiscal, API Galicia, alta IGJ | Contador / gestoría |
| Historial de caja | Usar el que hay. Primer lote: Efectivo/Banco, saldo por movimiento y filtros | USD y las 6 cajas | Conciliar saldos iniciales |
| Barra de equilibrio (“llenar la barrita”) | Primer lote: margen del mes contra gastos fijos, faltante por día, hitos por gasto y meta diaria de ventas. El ritmo del mes se proyecta desde el día 7 | — | Cargar los gastos fijos reales (Fijo + Mensual) |
| Alertas stock | Por lote / mínimo. Primer lote: mínimo de variedades por categoría (ej. 5 en Interior Premium) | — | Tizi define categorías y mínimos |
| Próximos pagos (“avisame que va a salir esta plata”, semanal) | Segundo lote: Finanzas e Inicio listan los vencimientos de 30 días (gastos mensuales o semanales, gastos con fecha futura, pagos previstos y obligaciones) con el total de la semana; «Agendar un pago» carga una compra a plazo | Aviso por mensaje; vincular la compra a plazo con el alta del lote | Cargar alquiler, sueldos y compras a pagar con fecha |
| Stock y margen por categoría comercial | Segundo lote: Inventario muestra el stock para vender de cada categoría; Decisiones → Comercial, el margen del mes por categoría comercial con su porcentaje | Días de cobertura por categoría (requiere demanda sin quiebres) | Asignar categoría a cada lote |
| Power BI | Recibir share si llega; no diseñar conector | Live / realtime | Tizi comparte |
| Kami | Usuario gerente ya reservado | — | Agendar propuesta |
| Packs que se aplican solos | No. Lista + simulación | Auto-aplicación al cargar venta | Camila carga; Tizi aprueba |
| Dashboard delivery (ruteo, cobro, merma) | No | Sí | — |
| Usuario motoquero | Sigue en AppSheet | Rol nuevo, no inventar en octubre | — |
| Merma / balanza “dar de más” | No | Procesos + medición | — |
| Autogestión de pedidos / rango horario | No | Sí | — |
| WhatsApp API | No (Tizi ya lo frenó) | — | — |
| Pago mixto auto (100 en una caja → ajuste 50/50) | Primer lote: efectivo + transferencia o tarjeta en la venta local; dos asientos automáticos, el cierre espera solo el efectivo | Más de dos medios, vueltos, recargo o descuento por medio de pago | Tizi decide recargo o descuento |
| FX ARS→USD y 3 cajas dólares | No | Multicurrency | Cómo importar USD sin cuenta |
| `CLUB_OPERATIONS_APPROVED` | Sigue false | Tras validación del profesional | — |
| Paralelo 7 días + capacitación | Última semana de octubre | — | Conteo físico |

---

## 5. Huecos humanos

| Hueco | Quién | Para qué | Bloquea octubre si no llega |
| --- | --- | --- | --- |
| Excel (no AppSheet) | Tizi, lo ofreció en la reunión | Diagnóstico, mapeo de columnas, import | Sí, para conciliar. La app local puede arrancar vacía |
| Share Power BI | Tizi; no sabe si es live | Ver resultados y stock histórico; no para conector | No. Útil, no requisito de código |
| Catálogo de precios de venta | Tizi: “si no están, te los paso aparte” | Costo vs precio por categoría (dijo que 6 de 8 kg pueden ser más baratos) | No para el código; sí para no leer mal el stock a costo |
| Fecha reunión Kami | Gio / Tizi / Camila | Propuesta, packs semanales, roles | No de producto; sí comercial |
| Acceso AppSheet del otro | Tizi no quiere pedirlo | Walkthrough extra / export nativo | No, si el Excel alcanza |
| Conteos físicos + corte | Club | Paralelo 7 días | Sí, para certificar stock |
| Corte expreso delivery | Tizi | Apagar AppSheet | Fuera de octubre salvo que él lo diga |
| Saldos de las 6 cajas al día de corte | Tizi | Abrir `cash`/`bank` | Sí, para usar saldo (si no, el pronóstico no muestra utilizable) |
| Cómo tratar USD | Tizi | Tres cajas dólares vs Bombo ARS | Sí para importar esos movimientos; no inventar cuenta |
| Alta gestoría / mes de plazo | Tizi, oral | Contexto legal; no es dato de app | No |

Needs_input: nombres reales de hojas y columnas; IDs estables de cliente/lote/factura; si Mercado Pago y Galicia son la misma plata; nombres de las tres cajas USD; si “6 nomás” son seis hojas.

---

## 6. Riesgos de duplicar delivery ahora

Si Bombo implementara envíos/ficha-documentos/caja de moto en paralelo a AppSheet:

1. **Doble envío.** En AppSheet crear la factura ya crea el envío. Una venta local en Bombo más la misma en AppSheet = dos viajes.
2. **Doble stock.** Delivery en Bombo descontaría lote local. El contrato de octubre importa delivery sin tocar stock. Romperlo deja el inventario local mentiroso.
3. **Doble caja.** Cobro delivery importado es `delivery_receipt`. Si además se registra como venta local, el resultado preliminar suma dos veces y el arqueo no cierra.
4. **Documentos de transporte / ReproCAN en la app.** Lock legal. Ficha Bombo no guarda archivos ni números completos. Bajarlos al motoquero desde Bombo es etapa posterior + abogado.
5. **Seis cajas vs dos.** Mixto y FX en AppSheet son ajustes manuales (retiro/aporte). Copiar esa UI en Bombo crea cuentas que el enum no tiene y ensucia `owner_draw` / `capital_contribution` como ya hace Tizi. En la venta local, el pago mixto ya se registra en `cash` y `bank` sin cuentas nuevas; FX y las seis cajas siguen fuera.
6. **Rol que no existe.** El de la moto ve destinos y cobra. En Bombo no hay rol delivery. Inventarlo ahora choca con permisos y con AppSheet vivo.
7. **Ruteo + mensaje.** Tizi ya tiene Maps/ETA frágil (un socio que se va a las 18:30 rompe el tour). Rehacerlo en Bombo no arregla el dato físico y pisa WhatsApp, que él no quiere.
8. **Confirmar cobro.** AppSheet separa factura y caja. Bombo, en local, cobra y mueve caja en la misma transacción. Mezclar el modelo de delivery (cobro al día siguiente) con el local rompe cierres.

Octubre: AppSheet opera delivery; Bombo opera local e importa hechos con origen. Cualquier feature de moto/ruteo/carta de porte ahora es duplicar, no migrar.

---

## Clasificación del summary automático

Cada ítem: `octubre` | `backlog` | `ya está` | `humano` | `descartado`.

### action_items

| Texto del summary | Clase | Por qué |
| --- | --- | --- |
| Migrar datos AppSheet y Excel a la nueva app, integridad histórica | octubre (import) + backlog (AppSheet deja de ser fuente) | Import con origen es el diagnóstico. Reemplazar AppSheet no |
| Ficha: contratos y credenciales ReproCAN para transportistas | backlog + legal | Bombo: estado/vencimiento/verificación nomas |
| Historial de movimientos de caja | ya está | Libro paginado; no reconstruir |
| Dashboard delivery: ruteo, cobro, merma | backlog | Plan octubre: pendiente de etapa posterior |
| Alertas de stock por categoría (no por cepa) | octubre (primer lote) | Mínimo de variedades por categoría; Inicio avisa. El mínimo por lote sigue |
| Estructura Gastos extraordinarios y sueldos | octubre (mapear) | No hay enum nuevo. Ver tabla de mapeo |
| Coordinar con Kami propuesta y roles (delivery vs admin) | humano | Camila ya es gerente. Agendar es de personas. Usuario delivery sigue en AppSheet |
| Compartir Power BI y verificar sync realtime con Bombo | humano + descartado (el sync) | Share sí; conector/live no en octubre |

### decisiones

| Texto del summary | Clase | Por qué |
| --- | --- | --- |
| Integrar ventas, stock y envíos; la factura genera el envío | backlog | Así está AppSheet. Octubre no unifica el delivery |
| Facturar el mes como una cuota social | documentar; fuera de octubre | Regla de negocio. Bombo no factura en el piloto |
| Alertas = cantidad de variedades por categoría (mín. 5 Premium Interior) | octubre (primer lote) | Variedad = nombre de producto distinto con stock y sin vencer |
| Merma/balanza con margen (dar de más) | backlog | Procesos físicos; no código de octubre |
| Actualización financiera y de stock en tiempo real | descartado para octubre | Tizi preguntó realtime vs update mensual (segmentos). Power BI: no sabe si es live. No hay sync continuo |

El resumen del summary (“reemplazar AppSheet”, “migrar un año”, “Power BI en tiempo real”, “Kami presente”) no es un acuerdo de octubre.

---

## Mapeo de cajas y gastos (locks 10–11)

No se crea categoría nueva.

| Lo que Tizi nombró | Cuenta Bombo | Categoría | Confianza |
| --- | --- | --- | --- |
| ARG efectivo | `cash` | según el hecho | alta |
| Galicia | `bank` | según el hecho | alta |
| Mercado Pago (redirige a Galicia, oral) | `bank` | según el hecho | media — confirmar si es la misma plata |
| Tres cajas USD | no hay | no mapear a `cash`/`bank` sin regla | needs_input |
| Sueldos | — | `operating_expense` | alta |
| Gastos de operación | — | `operating_expense` | alta |
| Gasto moto | — | `operating_expense` | alta |
| Impuestos | — | `operating_expense` | alta |
| Extraordinario por auto personal / “no me podía sacar un sueldo de 6.000 dólares” | — | `owner_draw` | alta (él mismo dijo que debía haber usado ahorros) |
| Compra de mercadería | — | `stock_purchase` (cuando paga) | alta |
| Aporte de Tizi / ahorros al negocio | — | `capital_contribution` | alta |
| Pago mixto: registrar 100 y mover 50 a otra caja | — | `adjustment` (dos asientos), no retiro/aporte | alta como regla; el Excel dirá si ya salió así |
| Compra de USD (entra ARS, después dólares) | — | no forzar; needs_input | — |
| Cobro delivery confirmado | — | `delivery_receipt` | alta |
| Inversión local / local físico | — | `local_investment` | si aparece |

Gastos del módulo Gastos no se consideran pagados hasta la salida de caja. No mezclar “categoría de gasto” libre con el enum de caja.

---

## Cifras orales (no conciliadas)

Ningún importe del club está conciliado en el repo. No usar estas filas para proyección.

| Fuente | Valor | Moneda | Fecha | Confidence |
| --- | --- | --- | --- | --- |
| Transcripción L239–240, tarifa CABA | 10.000 total; 5.000 cliente + 5.000 club | ARS | 29/09/2026, oral | media (regla dicha, sin comprobante) |
| Transcripción L212, recargo transferencia | 5 % adicional | % sobre cobro | 29/09/2026, oral | media; Tizi piensa pasar a descuento en efectivo |
| Transcripción L273, objetivo diario | 1.000.000 por día | ARS | objetivo vigente, oral | media como meta, no como real |
| Transcripción L274, agosto | ~3.000 de resultado; dijo “no sé” | USD | agosto 2026, oral | baja |
| Transcripción L77–78, próximo lote interior premium | 18.000 a juntar (lote + casa) | USD | oral, “se me viene” | baja |
| Transcripción L154–155, sueldo vs auto | sueldo 3.000; auto lo cargó como extraordinario ~6.000 | USD | pasado, oral | baja; sirve para clasificar el gasto, no para el P&L |
| `implementacion-octubre-2026.md` | ~500.000 / mes desarrollo + acompañamiento | ARS | referencia de propuesta, no aceptación | alta como referencia publicada |

Pack 15 / pack 20 y “mínimo 5 en interior premium” son reglas de producto, no importes.

---

## Qué no está en el deck y sí acá

El deck cubre fases, AppSheet como fuente de delivery, import con origen, y que no se reemplaza el delivery en el piloto. Este archivo agrega el paneo que Tizi mostró: ficha+archivos, factura=envío, carta de porte, escala/packs, seis cajas, confirmar cobro, compra a pagar, FX manual, gastos nombrados, Power BI con stock afuera de AppSheet.

Fin del inventario. El 29/09 no se escribió código; lo que entró en octubre está en §4 (primer y segundo lote).

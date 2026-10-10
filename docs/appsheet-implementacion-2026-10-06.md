# Implementación del flujo de Tiziano

Fecha: 6 de octubre de 2026. Checkout: `codex/bombo-appsheet-exact`, basado en `bf457c0`. El trabajo concurrente de `/Users/gigi/HerMaatOS/work/bombo` se conserva separado.

## Resultado implementado

La pantalla Pedidos incorpora **Nueva factura** y **Nueva preventa**. El formulario de factura conserva los campos y subformularios observados, dentro de la interfaz de Bombo.

- La factura captura número, fecha, socio, domicilio y aclaración. Elegir socio consulta su domicilio; una edición manual reemplaza la dirección anterior, incluidas sus coordenadas. Cambiar de socio limpia ese domicilio y consulta el del nuevo asociado; elegir el mismo socio conserva la edición manual.
- Cada producto conserva identidad del renglón, fecha, variedad en gramos, escala, cantidad de hasta tres decimales y valor total explícito. El valor por línea no se reconstruye multiplicando un precio unitario redondeado.
- Las nueve escalas y los cinco tipos de servicio provienen de los selectores observados el 6 de octubre. Su selección no aplica fórmulas no comprobadas.
- El viaje mantiene fecha de entrega, destino, tipo de servicio, aclaraciones y tres tarifas independientes: Cliente, Administración y Total Tarifa.
- Producto y moto conservan formas de pago separadas. Mercado Pago es una categoría propia; las tarjetas heredadas conservan su identidad.
- Cancelar un subformulario descarta su edición local. Guardar la factura ejecuta una única transacción: factura, líneas, reserva de stock y una entrega cuando hay moto. No registra cobro ni asiento por ese hecho.
- La preventa inicial captura fecha civil del club y socio. No reserva stock ni crea envío. **Formulario de venta → Guardar** completa y confirma la preventa en una transacción.
- El borrador sobrevive a un rechazo de permisos. Un guardado de resultado incierto congela los campos y reenvía la misma solicitud para recuperar su respuesta sin duplicar efectos.
- La ficha de catálogo conserva disponibilidad, segmento, descripción, precios por tramo, promociones y tarifas. La paginación cancela las respuestas de un filtro anterior para que no se mezclen productos. Un conflicto de versión conserva el borrador y exige resolver el conflicto; una actualización de la lista no sustituye los valores que se estaban editando.
- La cobranza offline conserva Mercado Pago en la cola cifrada y lo sincroniza con su identidad propia.
- **Confirmar total facturado** permite transcribir los importes finales de productos y moto desde la factura o aceptación del cliente. La moneda se conserva y el total resulta de sumar ambos importes explícitos. Se registran responsable, instante, evidencia, versión y hash del snapshot original con estado `staff_confirmed`. Esta acción no reserva stock, crea entregas ni acredita un cobro. La factura puede continuar por reparto y cobranza después de esa confirmación.

La base conserva los circuitos existentes de recepción física, compras pendientes de pago, preparación por lote, merma, obligaciones, rendición y arqueo por cuenta. Estos circuitos no se activaron sobre datos reales durante este trabajo.

## Límites que conserva la app

La interfaz viva permitió observar campos y opciones, pero no las expresiones, acciones agrupadas ni automatizaciones de AppSheet. No alcanza para certificar sus cálculos.

Las fórmulas automáticas de **Monto parcial, Transferencia, Transferencia moto y Total facturado** siguen pendientes de definición. La app muestra por separado la suma de valores explícitos de líneas y un importe de referencia capturado, que reúne esos valores y Tarifa Cliente. Esa referencia no equivale a una fórmula de facturación validada. El total final puede confirmarse explícitamente por el personal con evidencia; ese origen permanece diferenciado de un cálculo por regla.

Por compatibilidad del esquema SQL, los campos históricos no nulos conservan inicialmente la referencia capturada; las consultas proyectan `subtotalMinor` y `totalMinor` como nulos mientras el total siga pendiente. Las verificaciones de cobro, aplicaciones de crédito y reintegros rechazan esas facturas hasta disponer de un total definido o confirmado. Informar manualmente una recepción de dinero pendiente conserva sólo el testimonio, sin asiento. La confirmación posterior del total no convierte ese testimonio en dinero verificado.

Las facturas pendientes se excluyen del manifiesto de cobranza del repartidor. Un dispositivo que conserve un lease anterior también recibe rechazo al intentar informar su cobro. Una vez confirmado el total, la factura puede incluirse y cobrarse con medios separados. Los informes distinguen confirmaciones del personal y sus diferencias con los valores de líneas: esas diferencias no se atribuyen a productos sin una regla observada. La exportación conserva las líneas originales y la procedencia del total. La segmentación marca como datos insuficientes a los socios afectados por facturas pendientes o diferencias de productos aún sin asignación a líneas, incluso si tienen compras previas, y expone su cobertura parcial.

Los precios y promociones de catálogo no se aplican automáticamente a las escalas de la factura: esa relación requiere la definición de AppSheet. No se asumieron tarifas universales a partir de los valores iniciales de una sesión.

## Evidencia y validación

Las fuentes son [la observación de AppSheet](appsheet-paridad-observada-2026-10-06.md), [el recorrido de Tiziano](appsheet-walkthrough-2026-09-29.md), el Excel y el PBIX entregados. Son evidencia del circuito, no instrucciones para operar servicios o modificar registros reales.

La validación usa Node 24.19 y PostgreSQL 18 local independiente con datos sintéticos, esquemas desechables y puertos loopback. La revisión inicial `dabb410` pasó los siguientes controles; la validación posterior del cierre explícito y la publicación se registran en el documento de release:

- `bin/gate.sh` del contrato HerMaatOS: tipos, **270 pruebas aprobadas, 0 fallidas y 1 omitida**, y compilación. La omitida es la prueba existente `restore CLI rejects unsafe roots before database changes and stores objects locally`; su resultado no se presenta como aprobado.
- **18 recorridos de navegador aprobados** contra API y base reales de prueba. Cubren cancelación de subformularios, importes explícitos, fechas y medios de pago independientes, respuesta de guardado perdida sin duplicación, rechazo de permisos con corrección de socio y domicilio, preventa vacía que se completa y confirma, respuesta tardía del catálogo, además de recepción física, caja, compras y rendiciones existentes.
- **1 recorrido offline aprobado**: Mercado Pago persiste cifrado al bloquear y recargar y conserva su identidad al sincronizar. El transporte de este caso se simula; no acredita una operación real del proveedor.
- Revisión independiente de dominio, proyección de importes pendientes, informes, exportaciones, catálogo, formulario y offline. Los hallazgos corregidos se revisaron nuevamente; no quedaron hallazgos P1/P2 identificados. Esta revisión es de código, no certifica paridad financiera con AppSheet.
- `git diff --check` aprobado. La compilación informa una advertencia de tamaño en algunos paquetes; no impide compilar.

La huella de fuentes de la revisión inicial compilada es `459ff2d998e25b9bed49e94c48ac11f52762c2c12ea98668e539b3ff1720b8b4`.

Para reproducir los recorridos de navegador, definir `TEST_DATABASE_URL` para una base PostgreSQL de prueba desechable y ejecutar con Node 24:

```sh
node scripts/e2e-isolated.mjs tests/browser/appsheet-invoice.spec.ts tests/browser/operations.spec.ts tests/browser/operations-audit-regressions.spec.ts tests/browser/operations-artifacts.spec.ts tests/browser/finance-setup.spec.ts tests/browser/member-lookup.spec.ts
```

El caso offline se reproduce con:

```sh
node node_modules/@playwright/test/cli.js test --config=playwright.offline.config.ts tests/offline-browser/offline-pwa.spec.ts --grep 'conserva Mercado Pago cifrado'
```

La inspección visual comprobó formularios de producto, moto y catálogo, además del resumen y las acciones de factura en escritorio y móvil. Las capturas usan exclusivamente datos ficticios: [escritorio](evidence/appsheet-factura-desktop-2026-10-06.jpg) y [móvil](evidence/appsheet-factura-mobile-2026-10-06.jpg).

La revisión inicial fue local. La autorización posterior de producción, el respaldo, la migración y la publicación se registran en [el documento de release](appsheet-production-release-2026-10-06.md). No se ejecutaron acciones de negocio en AppSheet. La paridad de fórmulas automáticas sigue pendiente de cotejar sus expresiones y automatizaciones o validarlas con Tiziano en una copia de prueba.

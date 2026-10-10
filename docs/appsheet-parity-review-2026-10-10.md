# AppSheet → Bombo: revisión de paridad del 10 de octubre

El objetivo sigue siendo conservar el recorrido diario de Tiziano y Camila con datos reales. La definición del sistema legado y sus registros son evidencia de origen; Bombo aplica las correcciones seguras aprobadas para operaciones nuevas sin reescribir los importes históricos ni modificar AppSheet. Esta revisión no certifica el corte, la carga de cuentas reales ni equivalencia completa en producción.

## Correcciones preparadas

| Problema comprobado | Comportamiento del cambio local |
| --- | --- |
| Un SKU migrado podía recibir mercadería nueva, pero la factura sólo ofrecía lotes históricos. | El mismo selector Artículo distingue el lote histórico (`sourceLotId`) del lote recibido en Bombo (`stockLotId`). Son identidades excluyentes. El catálogo y la reserva comprueban recepción, hecho de stock, recibo, auditoría, SKU, unidad, alcance y disponibilidad; no inventan una clave AppSheet. |
| Editar SKU, escala o cantidad de una preventa podía volver a adjuntar su precio anterior. | Sólo conserva el precio histórico cuando esos tres valores siguen siendo equivalentes. El total manual permanece independiente y no se agrega un campo obligatorio. |
| Dos facturas fuente podían apuntar al mismo pedido. | La revisión de identidad rechaza el segundo vínculo y el plan identifica las colisiones persistidas como bloqueantes. |
| La fecha declarada por el cliente del comando podía convertirse en el sello oficial de revisión. | La evidencia conserva la declaración; el lote y la liquidación usan la hora del servidor. |
| Una liquidación histórica de otra captura podía usarse en el saldo de la autoridad activa. | En reemplazo activo se exige la misma captura. Un desajuste deja el saldo sin verificar y conserva el registro histórico. |
| Una revisión registrada con respuesta perdida quedaba sin reintento cuando la siguiente vista previa devolvía 423. | El panel conserva el envío validado y permite recuperar su recibo con exactamente el mismo UUID y contenido. Un error posterior de permisos tampoco borra ese envío: ocurre antes de consultar el recibo y no demuestra que el primer intento falló. Mientras el resultado siga incierto, bloquea otro plan y el envío simultáneo. El primer envío conserva sus controles de permiso y vista previa. |
| El CLI transportaba una fecha de respaldo como objeto Date a un contrato ISO. | Normaliza únicamente esa fecha en los dos comandos que la requieren y preserva el hash del reintento. |
| La exportación Moto dependía de la versión actual de la regla. | Lee la versión persistida: v1 conserva el total anterior; v2 usa el subtotal calculado sin fallback. La ausencia histórica de marcador conserva el campo almacenado; un marcador explícito desconocido deja el dato ausente. |

Las regresiones tienen como entradas comandos y consultas HTTP con PostgreSQL aislado, formulario de factura y panel administrativo. El catálogo sintético del navegador comprueba transporte y rehidratación del lote; la recepción y reserva reales se comprueban en la prueba HTTP propietaria. Una fixture de autoridad habilitada permite comprobar los consumidores, pero no prueba que el comando de corte pueda pasar con la captura real. Su ejecución y la revisión posterior deben vincularse al SHA congelado y a su manifiesto; un resultado anterior no certifica estos cambios.

## Evidencia separada

El candidato anterior `2be93b91d231a2116171ad8859be350e519c1fd3` pasó typecheck, build, 424 pruebas con una omisión opt-in, 72 pruebas ordinarias de navegador y una aislada, 13 offline y 5 de respaldo/restauración sin omisiones. Son resultados locales de ese candidato, previos a las correcciones de esta tabla. Los dos gates de imagen no se ejecutaron localmente por falta de Docker/Podman.

Las cuatro llamadas autorizadas a Claude Code usaron `claude-opus-5-5` y revisaron ese mismo candidato sobre un paquete sanitizado de 75 rutas de código, ocho extractos acotados y cuatro diffs de pruebas. El costo total informado por el proveedor fue USD 7,8232344. Todas solicitaron cambios; ninguna aprobó el corte. Dos salidas no respetaron completamente el protocolo JSON solicitado, por lo que sus afirmaciones se contrastaron individualmente contra el código. No se ejecutaron instrucciones contenidas en esas salidas. Esta revisión de Opus no cubre automáticamente los arreglos posteriores ni las 356 rutas del PR completo.

Los expedientes privados conservan hashes, salidas, cobertura, errores y cleanup de los ensayos. CI, Preview, despliegue, producción y aceptación autenticada de las dos cuentas son comprobaciones distintas. Una página pública o un manifiesto de release no demuestra la carga real de un socio, su saldo o sus permisos.

## Brechas que siguen bloqueando la certificación

- AppSheet sigue recibiendo uso manual. La captura está marcada inestable y registra cambios de origen; falta la pausa y el delta final conciliado.
- La preventa específica `Pre_Venta` aún no es el agregado genérico de factura de Bombo. Sus cabeceras manuales, dos decimales del detalle y fases de App formula deben preservarse. `TODAY()` y `NOW()` son fórmulas de aplicación, sin Initial value; no se congelan como valores iniciales. La [nota de diseño](reference/appsheet-preventa-source-workflow-internal.md) registra moneda, precisión, zona horaria y comportamiento runtime aún pendientes.
- La habilitación conserva bloqueos de checkpoint de pendientes y de apertura de caja. No se reemplazan por una atestación ni por sumar indiscriminadamente Movimiento y Movimiento_Nueva. Falta stock físico y caja del mismo corte.
- Suspender preserva operaciones y aumenta el epoch, pero una nueva activación con la misma captura necesita una rama de reanudación que valide la activación previa y su cadena posterior; no debe volver a activar SKU ni exigir sólo la línea base anterior al corte. Este camino sigue sin implementarse.
- La desactivación de un revisor actualmente invalida la elegibilidad de su revisión. La política sobre conservar una aprobación histórica tras desactivar la cuenta sigue sin resolver; no se retiró esa guarda.
- La captura del inventario no equivale a verificar todas las reglas, automatizaciones y resultados guardados. Sigue faltando código Apps Script inaccesible y cobertura completa de bots, tareas externas y plantillas.
- Los archivos entregados se inspeccionaron sin modificar sus originales. De 3.019 referencias, 1.174 tuvieron coincidencia exacta, una quedó ambigua y 1.844 faltantes o sin vínculo. No se sustituyeron con documentos ficticios. La comparación de plantillas tampoco certifica un render de la automatización real.
- La numeración nueva tiene reserva transaccional, pero la moneda, los resultados reales y el redondeo de cada regla financiera deben conciliar antes de certificarla. La mejora de código no aprueba importes históricos discrepantes.

No se ejecutó merge, despliegue manual ni activación operativa en esta revisión. AppSheet se investigó en lectura; no se guardó su configuración, no se ejecutaron bots ni se modificaron sus datos.

# Ajustes de la consola Bombo

Revisión del 5 de octubre de 2026, sobre el release `a916ed9`, en un worktree aislado. Responde a los tres comentarios de la interfaz de `bombo.maat.work/app`.

## Comparación con las fuentes del sistema existente

Se revisaron los encabezados del Excel oficial `2025_PP_Appsheet_TB (2).xlsx`, el layout del reporte `2026.06.ADMTB_Reporte.pbix`, el recorrido documentado de AppSheet y las guías oficiales de marca. El Excel contiene 39 hojas; el PBIX contiene 13 páginas, dos vacías. Esta inspección no leyó registros privados ni el modelo binario del PBIX: no certifica relaciones, consultas, DAX ni conciliación de importes.

| Referencia | Hallazgo relevante | Ajuste en esta revisión |
| --- | --- | --- |
| Guía práctica de marca, `docs/brand/guia-practica.md` | Usar el logotipo exportado, sin redibujar el símbolo. | Logo oficial blanco sobre oliva; se retira el símbolo construido con texto. |
| Sistema visual, `docs/brand/ui-system.md` | Lienzo crema, navegación oliva, foco visible y texto operativo legible. | Sidebar sin trama diagonal, tipografía más legible y tarjetas/vacíos más compactos. |
| Recorrido AppSheet, `docs/appsheet-walkthrough-2026-09-29.md` del checkout principal | Los módulos representan tareas; las 39 hojas no son un inventario de pantallas. | Se conservan los grupos y opciones permitidas por rol; se elimina el selector decorativo “Espacio activo”. |
| Excel: catálogo de mercadería y compras | Productos/stock y precios comerciales son conceptos distintos. | Los vacíos explican si faltan productos o precios/promociones; los pedidos conservan el motivo para cada precio manual. |
| Recorrido AppSheet e implementación de octubre | Venta, cobro y envío tienen estados distintos. Compra, recepción y pago también. | Se conserva esa separación; se simplifica el texto de Pedidos, stock y devoluciones. |
| Sesión autenticada de la app | `owner` es un rol, no el nombre de la cuenta. | El pie muestra `user.name` de la sesión y el rol traducido; tiene un retrato ficticio estable por cuenta. |

El recorrido AppSheet es una referencia histórica de septiembre. El contrato de `docs/implementacion-octubre-2026.md` mantiene AppSheet como fuente del delivery hasta conformidad expresa sobre la conciliación. Esta revisión visual no reemplaza ese sistema ni cambia su alcance.

## Comportamiento

- La navegación sigue desplazándose con rueda, táctil y teclado; se oculta únicamente su barra nativa.
- En móvil, el menú cerrado queda fuera del recorrido accesible; al abrirlo recibe el foco. Tab permanece dentro del menú, Escape lo cierra y devuelve el foco al disparador.
- “Solo consulta” describe el modo de escritura deshabilitada. El ensayo conserva su aviso explícito de datos sintéticos.
- Los retratos se generaron como ilustraciones de personas ficticias. Se sirven desde el propio sitio, sin enviar información de las cuentas a un servicio de avatares. La selección se mantiene estable al recargar. Para Tiziano se eligió expresamente el retrato masculino, en lugar de asignarlo al azar.
- El botón del pie describe su acción real: cerrar sesión o volver al panel, según el flujo existente.
- Se conserva la lógica de permisos, precios, reservas, cobros, recepciones y habilitación operativa.

## Verificación de la primera iteración

Entorno local: Node.js 24.19.0, PostgreSQL 18 en un cluster temporal propio limitado a loopback y bases descartables `bombo_ui_*`. La vista de ensayo usa datos sintéticos; no se consultaron ni modificaron registros de negocio de producción para estas pruebas.

| Control | Resultado |
| --- | --- |
| Regresión sobre el release previo, en una copia temporal de `a916ed9` | La prueba de identidad falló por el motivo esperado: el pie mostraba `owner` y la sesión devolvía `Tiziano`. |
| `npm run check` | Typecheck, 258/258 pruebas sin omisiones y build aprobados. |
| `npm run test:e2e -- tests/browser/operations-artifacts.spec.ts tests/browser/operations.spec.ts tests/browser/auth.spec.ts` | 4/4 recorridos aprobados con API, PostgreSQL y fixtures sintéticos. Verifican identidad, sesión, acciones operativas y menú móvil con teclado. |
| Revisión visual en navegador integrado | 1440, 975, 768, 390 y 320 px sin desbordamiento horizontal de página. Las tablas mantienen su desplazamiento dentro del contenedor. |
| Navegación lateral | Desplazamiento real verificado hasta los últimos grupos; scrollbar oculto, perfil visible y altura ajustada a la ventana. |
| Ampliación y movimiento reducido | Reflujo emulado a 2× en 488×376 px CSS: pie visible, menú desplazable y sin desbordamiento. `prefers-reduced-motion` reduce la transición a 0,01 ms. No se utilizó un control de zoom nativo del navegador. |
| Revisión independiente | Revisores separados del escritor verificaron el diff, los permisos y el comportamiento ARIA/foco; se corrigió el hallazgo de precisión del texto de cuentas. |
| `git diff --check` | Aprobado. |

En este checkout limpio, dos pruebas de backup requerían un módulo de `dist-server` antes de ejecutar `check`. Se ejecutó `npm run build` como preparación y luego se repitió `check` completo; no se omitieron pruebas ni se modificó su contrato. El build muestra un aviso de chunk mayor a 500 kB.

Capturas locales: `.local/ui-qa/after/operations-desktop.jpg` y `.local/ui-qa/after/operations-mobile-menu.jpg`. La vista de revisión está en `http://127.0.0.1:49262/app/operations`, mientras permanezcan activos los procesos locales de ensayo.

No se ejecutó CI remoto ni se creó un despliegue público. Ninguna comprobación local demuestra por sí sola que el dominio público haya recibido estos cambios.

## Segunda iteración: interacción y experiencia de uso

El pedido posterior amplía la mejora a los componentes compartidos y los recorridos de la app, sobre el mismo checkout aislado:

- La sección operativa y sus filtros quedan en la URL. Recargar conserva la sección; Atrás y Adelante recuperan el recorrido. Los parámetros ajenos se conservan.
- Las listas permiten buscar en las columnas que se muestran. Socios conserva su búsqueda remota por nombre, correo y teléfono, dentro del alcance del perfil. Las acciones secundarias se agrupan en “Más acciones”; las tablas se pueden desplazar con teclado y mantienen las acciones visibles en escritorio ancho.
- En un pedido ya cotizado, “Confirmar pedido” pasa a ser la acción principal cuando el perfil tiene ese permiso. Volver a cotizar queda como acción secundaria; un pedido sin cotización conserva “Cotizar” como primer paso.
- El resumen enlaza a sus secciones y muestra accesos según capabilities. Los perfiles sin lectura financiera ni de stock reciben accesos a sus tareas permitidas.
- Al actualizar, las fichas conservan sus últimos datos con un aviso de actualización o error y una opción de reintento. Ese aviso aclara cuándo los datos podrían estar desactualizados.
- Los formularios compartidos bloquean envíos duplicados, anuncian la espera, conservan los datos ante un rechazo y enfocan el error. El login permite mostrar u ocultar la contraseña.
- Los comandos muestran errores junto al campo, enfocan el primer inválido y aplican los límites numéricos ya declarados, también en filas repetidas. Una selección remota pendiente de validación no permite enviar el comando.
- Reparto distingue la espera, el error y la confirmación de captura cifrada. Las cantidades y los importes siguen las reglas existentes; los errores conservan el borrador y enfocan el campo. El bloqueo síncrono impide capturas duplicadas antes del siguiente render.

No se cambiaron las reglas de negocio, la autorización, el protocolo offline ni la clave del intento para reintentos de comandos inciertos. El límite de AppSheet como fuente del delivery sigue vigente.

Verificación visual de esta iteración: Pedidos y Resumen a 1280, 390 y 320 px sin desbordamiento horizontal de página. Las tablas desplazan sus columnas dentro del contenedor. El formulario de pedido a 390×844 mantiene los botones visibles y devuelve el foco al cancelar. Una carga completa final no produjo nuevos mensajes de warning/error; durante las ediciones hubo errores transitorios de recarga de Vite en el historial.

Capturas de esta iteración: `.local/ui-qa/after/ux-orders-desktop.png` y `.local/ui-qa/after/ux-order-form-mobile.png`. La revisión visual usa un navegador de escritorio con viewport móvil; no prueba reparto offline en un teléfono físico ni certifica dispositivos de operación.

La validación final de esta iteración se ejecutó después de congelar los cambios de producción:

| Control | Resultado |
| --- | --- |
| Regresión del historial sobre una copia temporal de `a916ed9` | Falló por el motivo esperado: abrir Cuentas cambiaba la pantalla, pero la URL conservaba `section=orders`. |
| `npm run check` final | Typecheck, 258/258 pruebas, cero fallos y cero omisiones; build aprobado. Persiste el aviso de bundle mayor a 500 kB. |
| E2E `operations-artifacts.spec.ts` | 5/5: identidad y menú móvil, URL/historial/filtros, borrador y foco al cerrar, máximo 120→110→90 y precisión monetaria en filas repetidas. |
| E2E `auth.spec.ts` | 1/1: sesión privada persistente y estado pendiente del formulario de ingreso. |
| E2E `club.spec.ts`, `member-lookup.spec.ts`, `navigation.spec.ts`, `operations-readiness.spec.ts` | 20/20: club 13, búsqueda de socios 1, navegación 3 e importación/habilitación 3. |
| E2E final `operations.spec.ts` y `operations-audit-regressions.spec.ts` | 5/5: cotización, confirmación, preparación y retiros; cobros y rendición con reintento sin duplicación; búsqueda paginada y recuperación de errores. |
| Revisión independiente del código y los tests | Sin defectos pendientes. Se verificaron permisos, conservación del borrador, foco, incertidumbre de comandos y las aserciones de persistencia/idempotencia. El último ajuste de prioridad de “Confirmar pedido” recibió una revisión focal separada. |
| `git diff --check` final | Aprobado. |

Total: 31 casos E2E únicos aprobados en corridas focales. Una corrida ampliada previa quedó 21/22 porque “Confirmar pedido” estaba dentro de “Más acciones”; la cotización sí se había guardado. Se priorizó la confirmación como siguiente acción visible y se repitieron los cinco casos operativos afectados, que pasaron.

Los runners usaron API local, fixtures sintéticos y schemas descartables en el cluster PostgreSQL propio limitado a loopback; cada uno confirmó la eliminación de su schema temporal. `check` usó las bases dedicadas `bombo_ui_test_app`, `bombo_ui_test_local` y `bombo_ui_restore_local`, con `NODE_ENV=test`, `DOTENV_CONFIG_PATH=/dev/null`, `OPERATIONS_BACKUP_RESTORE_E2E=true` y almacenamiento privado temporal. El rechazo HTTP 422 del caso de foco fue una respuesta controlada del navegador para verificar la recuperación visual; no equivale a una prueba de escritura del backend. Los recorridos de pedidos y cobros sí verificaron la API y la persistencia local.

No se ejecutó un recorrido E2E dedicado del repartidor real ni del perfil clínico. Sus cambios se revisaron en código, permisos y typecheck; la captura offline en un dispositivo físico sigue pendiente. No se ejecutó CI remoto ni se publicaron estos cambios: la evidencia corresponde al checkout local de revisión.

## Ampliación posterior del alcance

Gigi pidió revisar la reunión del 29/9 y los archivos existentes de Tiziano para reemplazar todo el sistema anterior. El objetivo actual incluye el reparto y los informes; el límite del piloto citado en las iteraciones anteriores describe su alcance histórico. La nueva matriz de requisitos, las correcciones del inventario PBIX y la aceptación pendiente están en [tiziano-parity-2026-10-05.md](tiziano-parity-2026-10-05.md). La autoridad de producción sólo cambia mediante un corte autorizado y aceptado.

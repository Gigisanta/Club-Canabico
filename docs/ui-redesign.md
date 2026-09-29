# Rediseño de la UI operativa

## Dirección
"Libro de caja": papel crema, tinta oliva, Bricolage. La jerarquía sale de la tipografía, las líneas finas y las filas, no de tarjetas. Un único bloque oliva por pantalla como máximo (en Finanzas, el resultado del mes). Los estados se comunican con texto y forma, nunca solo con color: Registrado, Incompleto, Sin conciliar y Datos de demostración.

## Dónde vive
- `src/bombo-ui.css`: capa transversal, cargada al final de `main.tsx`. Los estilos operativos se acotan a `.app-shell` y los de formularios superpuestos a `.modal`. Cubre shell, avisos, encabezados, superficies, tablas, controles, badges, vacíos, pestañas y movimiento reducido.
- `src/finance.css`: reescrito sobre el mismo sistema.
- Las hojas por módulo suben el tamaño mínimo de texto a 12–13 px (antes 9–12 px). `public-site.css` no se tocó.

## Reglas que se conservan
- Delivery/AppSheet nunca se cuenta como venta local; el resultado local lo dice y lo repite en la nota de método.
- La existencia de registros locales no se presenta como cobertura completa. La conciliación bancaria nunca se infiere: "Caja y banco" queda "Sin conciliar".
- Rutas, roles y `canVisit` no cambiaron. Hoy solo muestra accesos que el rol puede visitar.

## Procedencia de las referencias
- Referencias inspeccionadas por Codex en navegador, con interacción real (no por esta sesión de Claude Code):
  - https://uselayouts.com/docs/components/discrete-tabs
  - https://uselayouts.com/docs/components/vertical-tabs
- Principio adoptado: el cambio de vista tiene un estado seleccionado inequívoco y el contenido asociado cambia con él.
- Cómo se adaptó en Bombo (`src/bombo-ui.css`, sección "One tab pattern"):
  - Un solo patrón de pestañas subrayadas para Finanzas, Centro de decisiones, Preparar decisiones, Importación, Panorama y Análisis de decisión. El seleccionado se marca con subrayado naranja y color de tinta, y se expone con `aria-pressed` o `aria-selected` según el componente.
  - Todas las pestañas llevan etiqueta de texto visible; no se usan íconos sin etiqueta.
  - Sin animación ornamental añadida a las pestañas: no hay indicador deslizante ni transición de contenido. `prefers-reduced-motion` reduce el movimiento de la app.
  - En móvil la fila se desplaza horizontalmente sin barra visible y cada pestaña mide al menos 44 px de alto.
  - No se adoptó el layout vertical: la barra lateral de la app ya cumple ese rol y una segunda columna de pestañas dejaría ~500 px de contenido a 768 px.
- Esta sesión no abrió esas páginas; solo aplica el principio descrito arriba.

## Skills aplicadas (por Claude Code)
- `ui-inspiration` (criterios): dirección visual antes de componentes, estados (vacío, error, pendiente), tabs como patrón único, touch/teclado/movimiento reducido.
- `react-best-practices` (Vercel): rutas lazy, sin dependencias nuevas, valores derivados en render, sin componentes definidos dentro de componentes (`StateTag` es de módulo).
- `frontend-design`: se evitaron los tics genéricos (etiquetas en mayúsculas, numeración decorativa, tarjetas idénticas). La numeración de "Próximos pasos" se mantiene porque es una secuencia real.

## Finanzas: qué afirma y qué no
- "Resultado local" = ventas locales netas − costo vendido − gastos registrados. Costo vendido y gastos son componentes del resultado, no egresos de caja.
- No hay porcentaje ni fracción de "cobertura": Bombo sabe si existen registros locales, no si están completos ni conciliados. Un mes con 0 ventas o 0 gastos puede ser legítimo y se muestra como "Sin registros".
- Estados: Registrado (hay registros locales), Sin registros, A revisar (lotes actuales con stock y costo cero), Sin conciliar (caja, banco, costo vendido, inventario).

## Contraste y tipografía
- Las tarjetas `.metric` conservan sus variantes temáticas (oliva, lima, lila). La capa global no fuerza fondo claro sobre superficies temáticas.
- Los kickers y eyebrows quedan en tipo oración, con color de contraste ≥ 4.5:1.
- Los tamaños de módulo se subieron solo en hojas operativas. Donde una tabla o una tarjeta se rompe, se ajusta por pantalla y no de forma mecánica.

## Verificación local · 28 de septiembre de 2026
- Claude Code CLI: sesión `3381070D-9E4E-4CA3-858B-0BFF7CDAADE6`, dos pasadas con modelo canónico `claude-sonnet-5-5`, ambas terminadas con estado `success` y sin denegaciones de permisos.
- `npm run check`: tipado y build correctos; 66 pruebas, 62 aprobadas, 4 omitidas y ninguna fallida.
- `npm run test:e2e`: 20/20 recorridos aprobados contra un esquema PostgreSQL de pruebas desechable, eliminado al terminar. Se corrigió un dato de prueba que usaba la fecha UTC de mañana para el club en Argentina.
- `UI_AUDIT_OUTPUT=.local/ui-qa/finance-redesign-final node scripts/ui-audit.mjs` sobre `127.0.0.1:5173`: 125 comprobaciones, 0 errores, cinco anchos (desktop, tablet, equivalente a zoom 200 %, móvil y móvil pequeño). Informe: `.local/ui-qa/finance-redesign-final/audit.json`.
- Codex inspeccionó en la app real Finanzas, Inicio, Panorama, Gastos y las pestañas de Caja y Planificación en desktop y móvil. El modal móvil se abrió y cerró sin guardar datos.
- Alcance de esta pasada: código y vista local de demostración en `127.0.0.1:5173`. La preparación posterior del club real se documenta en `docs/club-real-accesos.md`.

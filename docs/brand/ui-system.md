# Sistema visual de la vista previa Bombo

Este contrato rige la landing y el panel local. La marca y los derechos de uso siguen sujetos a la revisión indicada en `salida-vista-previa.md`.

## Lenguaje

- Tipografía: Bricolage Grotesque Light (cuerpo) y SemiBold (títulos y acciones). Titulares compactos y expresivos; texto operativo legible y sin condensar.
- Colores oficiales: oliva `#3E402E`, crema `#F6EFDD`, lima `#C4E780`, naranja `#FF7B1C` y lila `#B4AAFF`. El naranja señala atención o foco; el lila aporta una categoría visual, no un significado de estado. Errores y advertencias conservan su semántica propia.
- Tokens compartidos en `src/brand-system.css`. Los módulos pueden tener CSS propio y usar esos tokens; el shell, los componentes de `src/ui.tsx` y la escala común tienen un solo responsable de edición.
- Escala de espacio: 4, 8, 12, 16, 24, 32, 48 y 72 px (`--space-1` a `--space-8`). Radios de 10, 14 y 20 px para controles, tarjetas y diálogos. Tipos base: display fluido 44–66 px, títulos de sección 21–28 px, cuerpo 15 px y etiquetas 13 px. Los módulos pueden reducir el display en móvil sin bajar el cuerpo de lectura.
- Composición: landing en capítulos con contrastes de escala y fotografía real; panel con lienzo crema, navegación oliva, tarjetas sobrias y datos con jerarquía. El énfasis gráfico no debe aumentar pasos para ventas, stock o socios.

## Contratos de interacción

- Todas las acciones por teclado mantienen foco visible: aro naranja oscuro `#A84E0D` sobre crema (contraste 4,87:1) y lima sobre oliva. Los controles móviles indican si están abiertos y devuelven el foco al disparador al cerrar. Los diálogos conservan título, descripción, foco inicial, cierre con Escape y retorno del foco.
- Estados de carga, vacío y error explican qué ocurre y ofrecen una acción posible. Nunca muestran información operacional en la API pública.
- Transiciones de color y elevación son breves. `prefers-reduced-motion` desactiva animaciones y desplazamientos suaves.
- Navegación móvil: Resumen, Ventas, Inventario, Socios y Más según el rol. El resto de rutas permanece en el menú lateral. No se modifican permisos ni rutas profundas.
- Las métricas registradas se distinguen expresamente de proyecciones o estimaciones. En la web pública se excluyen precios, inventario y reservas.

## Puntos de revisión

Comprobar 1440, 768, 390 y 320 px, zoom al 200 %, teclado y foco, contraste, impresión, movimiento reducido, errores, vacíos, gráficos y tablas extensas. Comparar las capturas de `.local/ui-qa/baseline/` y `.local/ui-qa/after/` y ejecutar las pruebas con una base descartable antes de aceptar el resultado. Las variantes WebP para móvil y WOFF2 son derivados locales de los assets seleccionados; las fuentes TTF originales quedan como respaldo.

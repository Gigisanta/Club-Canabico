# Instalación operativa de Bombo

La aplicación privada usa `bombo.maat.work` y la landing estática separada usa `bomboclub.maat.work`. El local necesita una computadora con internet; el reparto usa la PWA instalada en el Android que se certificará. La publicación del código conserva el sistema anterior como autoridad hasta el corte aprobado.

## Entornos y publicación

Desarrollo y CI usan Node 24.14.1 y PostgreSQL 18. Vercel administra el parche de Node 24.x. Utilizar conexión pooled en el runtime y conexión directa para migraciones y respaldo. Mantener producción separada de los ensayos, archivos privados, HTTPS, cookies seguras y orígenes exactos.

Antes de promover un candidato: typecheck, build, batería con base aislada, recorridos de navegador, pruebas offline, CI y revisión independiente. Comprobar el `sourceHash` de `/release.json` contra el código revisado y verificar el deployment al que apunta el alias. No sembrar fixtures ni registrar aprobaciones sintéticas en producción.

Los recursos nuevos pagos requieren presupuesto autorizado. El respaldo independiente se prepara con [el worker y las plantillas](backups-and-recovery.md); su instalación y restauración remota son gates propios.

La continuidad fuera de Vercel se prepara con [la contingencia en AWS](contingencia-aws.md). Su imagen, proxy, destinos y cambio de dominio requieren ensayo y autorización operativa antes de utilizarlos.

## Preparación del negocio

1. Inventariar acciones, bots, filtros, validaciones, plantillas, escritores y colas de AppSheet. La lectura del Excel no aporta todas esas definiciones.
2. Preparar usuarios reales por función y alcance. Entregar accesos manualmente. Comprobar búsquedas, descargas, documentos y objetos ajenos desde cada perfil.
3. Leer el original sólo en el equipo administrativo con `npm run ops:import -- --file /ruta/privada/original.xlsx --preview`. La carga filtra material de autenticación antes del transporte; el XLSX original permanece fuera del servidor y Git. Importar mediante bloques, hashes y checkpoint privado.
4. Un revisor distinto comprueba conteos, excepciones y correspondencias. El propietario aprueba una interpretación explícita por tabla. Proyectar y publicar la historia completa; conservar desconocidos y correcciones. Publicar historia no crea stock, caja ni deudas de apertura.
5. Aprobar tarifas, packs, promociones, remuneración del cadete, plantillas, documentación y vigencias. Los precios confirmados se congelan; los permisos clínicos son explícitos.
6. Conciliar cuentas, custodias, obligaciones, créditos, pedidos parciales y compras pendientes. Contar stock por lote, unidad, ubicación y custodia. Aprobar cada apertura y cada ajuste con evidencia independiente.
7. Completar una jornada por rol con [la guía de los circuitos](operacion-canonica.md). La factura, el cobro reportado, el cobro verificado y la rendición conservan efectos diferentes.
8. Certificar el Android real: almacenamiento, reinicio, desconexión, documentos, parciales, conflicto, revocación, cola cifrada, respaldo, exportación y recuperación. Chromium con fixtures no acredita este gate.
9. Ejecutar referencias de Power BI con la misma foto, filtros y fecha. Comparar definiciones históricas y operativas; un dato desconocido no equivale a cero. La documentación privada conserva el catálogo completo de medidas y la investigación del origen.
10. Restaurar base y documentos en destinos nuevos, vacíos y permitidos. Comparar migraciones, huellas financieras, reservas, custodias, recibos y checksums. Medir programación y copia junto con restauración para demostrar RPO/RTO.

## Corte y recuperación

Completar siete días de sombra y conciliación diaria. Revisar colas, exportación final, delta, objetos abiertos y saldos. Retirar escrituras y automatizaciones antiguas, registrar el instante y época de autoridad y activar conjuntamente compra, recepción, stock, pedido, entrega, cobro y caja. Comprobar el destino por rol antes de la primera operación real nueva.

Después de esa primera operación, recuperar hacia adelante conservando todos los hechos posteriores. No restaurar una base anterior sobre cobros o entregas nuevos. Consultar [recuperación operativa](recuperacion-operativa.md) y registrar cada incidente.

El retiro completo del sistema anterior exige evidencia de todos esos gates y conformidad de los responsables. Las notas y controles del negocio son privados; no se publican en el repositorio de código.

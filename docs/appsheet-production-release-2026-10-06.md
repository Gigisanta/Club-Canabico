# Publicación del flujo AppSheet en Bombo

Fecha de trabajo: 6 de octubre de 2026. Gigi autorizó explícitamente publicar y dejar la app funcionando en producción. Este documento distingue la versión desplegada, su validación técnica y el corte del negocio.

## Circuito

La implementación reproduce los campos y subformularios observados de factura, producto, moto y preventa. **Confirmar total facturado** recibe los importes finales de productos y moto con evidencia. Conserva las capturas originales, registra responsable, fecha y hash/version del snapshot y habilita la continuación por reparto/cobranza. El detalle **Ver confirmación del total** muestra esos importes y la evidencia registrada sin nuevas llamadas de red. Confirmar el total no acredita recepción de dinero ni vuelve a reservar stock.

Los informes reconocen la confirmación del personal con procedencia explícita y requieren una versión positiva que coincida con la versión de la factura. Una diferencia entre el total final de productos y las líneas queda sin asignar a SKU; no se interpreta automáticamente como precio, recargo, descuento o rentabilidad. La segmentación marca como insuficientes esos datos aunque no haya otras facturas pendientes. El CSV de ventas conserva los valores de línea y expone el total y su procedencia una sola vez por factura, incluso con paginación.

El inventario existente de 208 medidas DAX sí contiene agregaciones de Power BI sobre los importes guardados. No contiene las expresiones actuales que generan esos campos en AppSheet. Las hojas transaccionales de factura, detalle, moto y preventa del Excel no tienen fórmulas de celda. La cuenta indicada tiene acceso al runtime de AppSheet, pero su listado de aplicaciones compartidas en el editor está vacío. La confirmación del importe final es una acción explícita, no una fórmula automática declarada como equivalente.

## Base y respaldo

Proyecto comprobado: `giolivos-projects/bombo`, ID `prj_jU57qNW6FRIEqcDuNHv9GOPKoGLA`. La función existente corre en São Paulo (`gru1`). Antes del cambio, el dominio apuntaba a `dpl_D7ET2FmCiPXDrPivzdQhy5BrfEFq` con fingerprint `7f842b7d8f2da30301c4ae79128b83515c15a23a09f7ebc7619e71770653ecae`.

Se cotejaron los checksums de las 32 migraciones aplicadas. La única pendiente era `202610060002_appsheet_catalogue`, que agrega `CatalogSku.appSheet` JSONB nullable sin backfill. Se tomó un dump cifrado AES-256-GCM de 238.149 bytes con clave nueva en el almacén privado canónico y se restauró en PostgreSQL 18 aislado. La comprobación comparó hashes SHA-256 de doce tablas financieras, además de identidades/permisos y conteos; la base desechable se eliminó después de verificarla.

La migración se aplicó y comprobó: 33 migraciones terminadas y columna nullable JSONB. Los hashes financieros y de acceso permanecieron iguales. Había cero documentos operativos registrados, por lo que este cambio no necesitó copiar objetos. Este respaldo local no se presenta como prueba de recuperación remota.

Los artefactos privados están en `.local/appsheet-production-release/`, excluidos de Git y de la publicación. La revisión independiente corrigió el pin del destino, agregó comparación de contenido financiero y vinculó la prueba de restore al checksum del respaldo utilizado. No se expusieron credenciales, registros privados ni claves.

## Validación y despliegue

- Gate global local: tipos, compilación y 274 pruebas aprobadas, cero fallos y cero omisiones.
- Navegador con PostgreSQL 18 aislado: 50/50 recorridos aprobados; el esquema temporal se eliminó al finalizar. Incluye factura/preventa, confirmación del total, trazabilidad, pagos independientes de productos y moto, verificación e idempotencia, permisos, stock, rendición y sesión revocada.
- PWA sin conexión: 13/13 controles aprobados. Son pruebas locales con datos sintéticos; no certifican operaciones financieras reales ni el Android del club.
- Revisión independiente: sin P1/P2 en los cambios finales de factura, corte, reportes y aserciones del navegador.
- Fingerprint de las fuentes locales: `166fcc969396889a21e506e2ba35fc18c04b6114fe53a9e7a77bc6ed686383f9` (263 archivos).

Los controles del proveedor vincularán el commit final con el deployment de producción, la configuración efectiva, el manifiesto servido y el alias del dominio. Se exige CI aprobada para ese commit antes de promover el candidato; no se omiten controles de Vercel. La evidencia de publicación se completará después de comprobar el dominio.

## Autoridad operativa

La base observada no tiene apertura de caja ni hechos de stock operativos; no se fabricaron esos datos. La publicación no registra por sí misma aceptación de Tiziano, conciliación, controles profesionales ni jornadas en el Android real. La app conserva los controles de activación del circuito y la separación entre informar y verificar dinero. La revisión de corte rechaza autores inactivos; activar exige que autores y revisores de todos los controles sigan activos.

El deployment anterior permite volver al código publicado antes de este cambio. La nueva columna es compatible con ese código y no necesita borrarse para esa vuelta.

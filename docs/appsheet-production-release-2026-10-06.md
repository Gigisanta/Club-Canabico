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

Se publicó el commit de aplicación `8a7cc7bed50d10c2f5bacd659cc3cc23275347cc` en el deployment `dpl_8guYTZGf7mWby59ABPuRnDNxSVCh`, región `gru1`. El candidato fue [bombo-6a24r53fh-giolivos-projects.vercel.app](https://bombo-6a24r53fh-giolivos-projects.vercel.app); luego de verificarlo y aprobar CI se promovió mediante el flujo normal de Vercel, sin forzar ni omitir controles. [Bombo en producción](https://bombo.maat.work/app) sirve ese mismo deployment, comprobado por el alias del proveedor y por los manifiestos públicos.

[CI del commit publicado](https://github.com/Gigisanta/Club-Canabico/actions/runs/37556104404) terminó en `success`, incluidos tipos, compilación, pruebas, navegador, modo sin conexión, imagen de contingencia y configuración de la imagen independiente de respaldo. La comprobación pública del dominio, sin bypass ni sesión, verificó salud y configuración reales (200, sin demo), APIs privadas protegidas (401 y `no-store`), HTML de operaciones y service worker (200).

El fingerprint servido es `6bcbeccfdde44183458645c9d852e701feb8003c07d9ce3019f30d199777f5aa`, con 263 fuentes. Coincide con el hash recalculado de su manifiesto. La única diferencia de fuente frente al fingerprint local es `vercel.json`: Vercel normaliza el JSON e incorpora `name` y `version`; se reprodujo ese hash y se cotejaron todos los campos funcionales. Una segunda revisión independiente confirmó el alias, ambos manifiestos y su hash desde el dominio público.

Después de la promoción se repitió la comparación de la base real: los hashes completos de las doce tablas financieras, usuarios, accesos, autoridades y los conteos operativos permanecieron idénticos al respaldo previo. No se crearon movimientos de negocio para probar la publicación. El navegador real carga la pantalla de acceso publicada; no había una sesión iniciada, por lo que el recorrido autenticado en producción queda sin verificar. Los recorridos autenticados aprobados corresponden al entorno aislado indicado arriba.

## Autoridad operativa

La base observada no tiene autoridad canónica activa, apertura de caja ni hechos de stock operativos; no se fabricaron esos datos. El corte al negocio real requiere registrar y conciliar esas aperturas y la aceptación de Tiziano. La publicación no acredita por sí misma controles profesionales ni jornadas en el Android real. La app conserva los controles de activación del circuito y la separación entre informar y verificar dinero. La revisión de corte rechaza autores inactivos; activar exige que autores y revisores de todos los controles sigan activos.

El deployment anterior permite volver al código publicado antes de este cambio. La nueva columna es compatible con ese código y no necesita borrarse para esa vuelta.

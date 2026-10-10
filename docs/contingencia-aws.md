# Contingencia de Bombo fuera de Vercel

Esta guía prepara la recuperación del servicio persistente. No crea infraestructura, contrata recursos ni autoriza un cambio de DNS. Antes de la apertura deben quedar registrados presupuesto, recursos, operador de emergencia y responsable que autoriza el cambio de dominio.

## Preparación y ensayo

1. Construir `Dockerfile` desde el mismo checkout público revisado del release, con Node 24.14.1. Publicar la imagen en el repositorio ECR autorizado con etiqueta del commit y conservar su digest. Comprobar `/release.json` contra la huella del release y ejecutar el contenedor con datos sintéticos antes de aceptar la imagen. La compilación local sin contenedor no acredita este ensayo.
2. Preparar ECS Fargate en la región de la base, con identidad de tarea, secretos privados, HTTPS y balanceador. La tarea no tendrá acceso público directo; el security group del balanceador será el único que pueda acceder al puerto 3001. Usar un dominio de ensayo autorizado para verificar sesión, cookies, origen y límites de solicitudes. La configuración del proxy y la identificación del cliente deben revisarse para ese balanceador antes de habilitarlo: la configuración de Vercel no se presume equivalente.
3. Conservar `DEMO_MODE=false`, `OPERATIONAL_REHEARSAL=false` y la configuración real aprobada de autoridad. Las credenciales de la demo nunca se utilizarán como acceso del negocio. Usar `DATABASE_URL` pooled para runtime, límite de conexiones acotado y acceso directo únicamente para mantenimiento aprobado.
4. Si la base y los objetos existentes siguen disponibles y consistentes, mantenerlos. Si hay que recuperar, utilizar el worker de restauración sobre una base nueva y un bucket de objetos nuevo, vacíos y autorizados por allowlist. Comprobar el manifiesto, versiones de objetos, migraciones, recibos, cuentas, obligaciones, stock, reservas y custodias. Configurar el servicio para esos destinos sólo después del resultado durable de la restauración.
5. Mantener claves de sesión y recuperación en su almacén de secretos independiente. El contenedor no contiene credenciales ni investigación privada. Registrar el manifiesto del respaldo utilizado, el instante de snapshot, las operaciones posteriores y la resolución de sus diferencias.
6. Configurar y verificar mantenimiento de la outbox y respaldos independientes para el destino de contingencia. No habilitar dos instancias con autoridad distinta ni dos programaciones que modifiquen el mismo circuito sin coordinación.
7. Practicar la recuperación completa y medir los tiempos. RPO 15 minutos y RTO cuatro horas permanecen como objetivos hasta comprobarlos, incluyendo detección, copia, restauración, controles y cambio del destino. Conservar evidencia y revisión independiente.

## Activación de emergencia

El responsable del incidente identifica el último hecho confirmado y conserva los eventos pendientes de los dispositivos. Antes de apuntar `bombo.maat.work` a la contingencia, retira los escritores anteriores o comprueba que operarán sobre la misma autoridad y base. El operador verifica la imagen por digest y huella, los destinos de datos, TLS, origen exacto y el funcionamiento por rol. Registra la autorización de emergencia y el cambio de DNS.

Después del cambio se verifican el dominio y su identidad de release, salud, sesión, consultas y un recorrido acordado. Las colas offline conservan sus UUID; recuperarlas no autoriza aceptar eventos revocados ni vencidos. Las diferencias se resuelven con comandos nuevos y trazables.

Volver a Vercel exige reconciliar los hechos creados durante la contingencia. Después de una escritura real, la recuperación será hacia adelante; nunca se restaura una foto anterior sobre cobros o entregas posteriores. El dominio no vuelve al destino anterior hasta verificar que utilizará la misma base, objetos y autoridad aprobados.

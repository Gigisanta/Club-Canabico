# Respaldo cloud y recuperación operativa

Este procedimiento prepara una copia cifrada fuera del entorno de Bombo y un camino acotado para restaurarla. El worker es de una sola corrida: ECS recibe `backup` o `restore`, procesa y termina. No se desplegó infraestructura como parte de esta entrega.

## Qué produce cada corrida

El worker toma la instantánea transaccional PostgreSQL 18 mediante el CLI existente, incluye los objetos privados de Vercel Blob, cifra el paquete con `BACKUP_ENCRYPTION_KEY`, comprueba el paquete local y lo publica en un bucket S3 versionado de otra cuenta AWS. Cada snapshot tiene un dump completo de la base. Los objetos Blob cifrados se referencian por hash y se reutilizan entre snapshots del mismo día (frequent/daily) o mes (monthly), de modo que un objeto viejo no venza mientras una corrida nueva sigue creando commits que lo referencian. El commit HMAC y el manifiesto durable se escriben al final, sólo después de subir cada archivo y capturar su `VersionId`.

S3 agrega cifrado SSE-KMS y versionado. La retención configurada es frequent 2 días, daily 30 días y monthly 365 días; S3 aplica el ciclo de vida de forma eventual, y las versiones no corrientes se eliminan un día después de que dejan de ser actuales. Esto describe configuración de retención, no un RPO/RTO medido ni una alerta de ejecución. EventBridge conserva los fallos de invocación en una cola DLQ de 14 días.

El restaurador exige una URL PostgreSQL remota incluida exactamente en `RESTORE_DATABASE_ALLOWLIST` y `sslmode=verify-full`; rechaza comodines, `sslmode=require` y destinos loopback. Valida el commit firmado, descarga las versiones S3 exactas, verifica checksums y el paquete cifrado, y delega en el CLI, que comprueba PostgreSQL 18 y exige un destino vacío. `RESTORE_OBJECT_BUCKET` es un bucket destino nuevo, versionado, vacío y distinto del bucket fuente; su nombre debe aparecer exactamente en `RESTORE_OBJECT_BUCKET_ALLOWLIST`. El task restore lee las versiones exactas del bucket fuente y escribe objetos privados versionados en el destino con SSE-KMS mediante `RESTORE_OBJECT_KMS_KEY_ARN`, de la misma región que `RESTORE_OBJECT_REGION`; requiere permisos de lectura en el origen y escritura/cifrado en el destino, sin permiso de borrado del destino. Seleccionar el commit, preparar una base vacía aislada, revisar el `auditId` durable `restore.coordinated` y cambiar tráfico siguen siendo decisiones operativas separadas. El JSON `committed=true` sólo se emite después de validar ese acuse. La limpieza al final elimina el staging local cifrado, nunca el objeto de destino.

## Estado antes de habilitar la automatización

El responsable informó una copia pre-release consistente, cifrada y tomada con PostgreSQL 18; en el esquema `public` anterior no había documentos disponibles y se informaron cero checksums de objetos verificados. La clave local de recuperación permanece fuera del checkout. Este dato es un handoff humano y no una validación reproducida por esta entrega.

El secret `BACKUP_ENCRYPTION_KEY` que existe actualmente en Vercel fue reportado como inválido para este CLI. El worker lo rechazará antes de conectarse a PostgreSQL o S3. No se lee, copia ni modifica ese valor desde esta tarea, y no se modifica Vercel. Antes de habilitar schedules, emitir una clave válida de 32 bytes (64 caracteres hexadecimales) por el proceso de secretos autorizado, guardarla como secret JSON `BACKUP_ENCRYPTION_KEY` en Secrets Manager y conservar una copia de recuperación independiente del bucket, AWS workload account, Vercel y este checkout. Rotar la clave requiere planificar qué claves pueden descifrar todos los backups retenidos.

La URL `DATABASE_URL_UNPOOLED` debe guardarse directamente en el secret JSON como clave `DATABASE_URL_UNPOOLED`. No se deriva cambiando el host de otra URL: el worker rechaza hosts con etiqueta `-pooler` y requiere `sslmode=require` o `sslmode=verify-full`. Crear además un secret JSON `BLOB_READ_WRITE_TOKEN` con el token de Vercel Blob autorizado. Para restore, usar un secret JSON `RESTORE_DATABASE_URL` con la URL TLS del destino PostgreSQL 18, y permitir exactamente `host:puerto/base` en `RESTORE_DATABASE_ALLOWLIST`.

El backup CLI valida las tablas y migraciones esperadas para el esquema actual de Bombo. La copia pre-release del esquema anterior no hace que el worker nuevo sea compatible retroactivamente con ese esquema; primero hay que completar y verificar la migración/reconciliación que corresponde al release. Mantener esa copia pre-release hasta validar el primer backup cloud y un ensayo de restore aislado.

## Preparar la imagen

Desde la raíz de este repositorio, construir una imagen Linux x86_64 con Node 24 y `pg_dump`/`pg_restore` PostgreSQL 18:

```sh
docker build -f infra/backups/Containerfile -t bombo-operations-backup:review .
```

Publicar esa imagen en un repositorio ECR del workload account es un paso de despliegue separado. La imagen ejecuta `scripts/operations-backup-cloud-worker.mjs` como usuario sin privilegios; no contiene URLs ni claves.

## Despliegue en tres stacks, sin circularidad entre cuentas

1. En el workload account, desplegar `infra/backups/workload-task-roles.template.yaml`. Guarda los outputs de ARN y nombre de ambos roles; sólo confían en ECS Tasks y todavía no tienen permisos S3/KMS.
2. En un account AWS independiente, desplegar `infra/backups/independent-s3.template.yaml` con el bucket fuente globalmente único, prefijo y los ARNs exactos de esos dos task roles. Guardar los outputs del bucket, prefijo y clave KMS. Ese bucket contiene los commits/backups; no se usa como destino del restore.
3. En el workload account, preparar el cluster ECS, subredes privadas con egress controlado hacia PostgreSQL/Blob y AWS APIs, security group sin ingreso, imagen ECR y secrets JSON. Desplegar `infra/backups/ecs-scheduler.template.yaml` con esos ARNs/outputs y `ScheduleState=DISABLED`. Revisar IAM, red, secret ARNs, capacidad efímera y logs antes de considerar activar los schedules.

Antes de correr un restore, provisionar por separado `RESTORE_OBJECT_BUCKET` como bucket de objetos destino nuevo, versionado y vacío (también sin versiones previas ni delete markers), con su política de acceso y cifrado SSE-KMS. Debe diferir del bucket fuente de backups. Configurar `RESTORE_OBJECT_BUCKET_ALLOWLIST` con ese único nombre, `RESTORE_OBJECT_REGION` y el ARN regional `RESTORE_OBJECT_KMS_KEY_ARN`; la plantilla del task restore limita escritura al destino y lectura al bucket fuente. No se requiere permiso de borrado en el destino.

Las plantillas sólo describen recursos; esta entrega no creó buckets, claves KMS, roles, secretos, tareas, logs, colas ni schedules. El bucket cross-account y la clave KMS son recursos con costo cuando se aprovisionen; el almacenamiento efímero Fargate sobre el mínimo incluido también puede generar cargo durante las tareas. Definir presupuesto y aprobación operativa por separado.

Secrets Manager debe contener secretos JSON con las claves exactas indicadas arriba. La ejecución usa la URL directa desde la clave `DATABASE_URL_UNPOOLED`; ECS no registra su valor en CloudFormation outputs. La execution role sólo lee los ARNs provistos y descifra con la clave de secretos elegida. Si un secret usa otro KMS key, ajustar la plantilla al ARN exacto de esa clave antes de desplegar.

`RESTORE_DATABASE_ALLOWLIST` acepta entradas exactas `host:puerto/base`, separadas por coma, sin esquema, usuario, contraseña, comodines ni rutas. Configurar `RESTORE_DATABASE_URL`, `RESTORE_OBJECT_BUCKET`, `RESTORE_OBJECT_BUCKET_ALLOWLIST`, `RESTORE_OBJECT_REGION` y `RESTORE_OBJECT_KMS_KEY_ARN`; en ECS, correr manualmente `bombo-operations-restore` con overrides `BACKUP_RESTORE_COMMIT_KEY` y `BACKUP_RESTORE_COMMIT_VERSION_ID` para el key y `VersionId` seleccionados. Ejecutar la tarea sólo contra una base vacía PostgreSQL 18 aislada. El registro `operationAudit` con acción `restore.coordinated` es el acuse durable; el JSON final incluye su `auditId` y `committed=true`. El staging local se elimina después de registrar y validar ese acuse; nunca se borra el objeto del bucket destino. Si la limpieza local falla, la salida conserva `committed=true`, expone `auditId`, informa `stagingCleaned=false` y termina con código distinto de cero para que el operador atienda el staging sin repetir a ciegas el restore.

Las tres schedules quedan creadas pero deshabilitadas por defecto para evitar invocaciones accidentales. Al habilitarlas, la frecuente corre cada 10 minutos; la diaria a las 02:00 UTC; la mensual el día 1 a las 03:00 UTC. El Scheduler usa Fargate en subredes privadas y reintentos acotados; los fallos de entrega van a DLQ. Eso no sustituye alarmas operativas ni demuestra puntualidad del backup.

## Reproducir la validación local

Con Node 24 y AWS SDK v3 instalados por el proyecto:

```sh
node --import tsx --test tests/backup-object-reuse.test.ts tests/operations-backup-cloud.test.ts tests/operations-object-store.test.ts
```

Para el backup y restore PostgreSQL completos, usar sólo bases loopback dedicadas `bombo_ui_*` y `bombo_ui_restore*`, y clientes PostgreSQL 18. La prueba de restore crea un esquema temporal en la base de ensayo autorizada, ejecuta el CLI real y lo elimina al terminar. No usar producción, túneles ni destinos de la allowlist remota. El tiempo que informa TAP corresponde a ese restore local y no predice duración cloud.

La validación PostgreSQL 18 de esta entrega comprueba consistencia estructural, checksum, migraciones, fingerprints financieros y objetos del fixture sintético. No verifica Vercel Blob real, AWS, la llave reportada, el release vivo, retención efectiva de S3 ni un restore en otra cuenta.

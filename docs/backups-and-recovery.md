# Respaldo y recuperación de operaciones

## Qué hace el worker

`scripts/operations-backup-worker.mjs` es un ejecutor de una sola corrida, programable con `systemd`, cron o Task Scheduler. Requiere Node 24, los clientes `pg_dump`/`pg_restore` de PostgreSQL 18, `DATABASE_URL`, una clave independiente de 32 bytes y rutas locales absolutas. Rechaza S3, AWS y Vercel Blob; los archivos se guardan cifrados en un directorio privado local. No crea recursos cloud ni borra respaldos antiguos.

Cada corrida toma un lock exclusivo, pide al CLI una instantánea, valida el manifiesto/cifrados, y recién entonces renombra el paquete incompleto a `backup-<UTC>-<id>`. Si falla antes de publicar, limpia sólo el directorio temporal que esa corrida creó. Si ya existe un lock, se detiene sin modificarlo; el operador debe comprobar si queda un proceso activo antes de retirarlo.

El worker guarda una copia local, no una copia fuera del host. Sirve para automatizar y ensayar el circuito, pero por sí solo no cubre pérdida del servidor o de su disco. La réplica off-host requiere elegir y autorizar almacenamiento independiente; este paquete no la configura.

## Preparación privada

Usá PostgreSQL 18 para `pg_dump` y `pg_restore`. El Compose operacional actual usa la ruta oficial de datos `/var/lib/postgresql`; el worker no monta ni modifica el volumen de la base. Mantené sus respaldos y objetos privados bajo un directorio de datos separado, por ejemplo `/var/lib/bombo/backups` y `/var/lib/bombo/private-objects`.

Instalá las unidades de `infra/backups/` después de revisar las rutas y el usuario del servicio. El ejemplo espera el checkout en `/opt/bombo/current`, Node 24 en `/usr/bin/node`, los binarios PostgreSQL 18 en `/usr/lib/postgresql/18/bin` y un usuario/grupo del sistema llamado `bombo`; ajustá sólo esos paths si la instalación usa otros.

Creá `/etc/bombo/backup-worker.env` desde `infra/backups/backup-worker.env.example`. Guardalo fuera del repositorio, propiedad de `root:root` y con modo `0600`. Cargá allí la URL privada de PostgreSQL y `BACKUP_ENCRYPTION_KEY` (64 caracteres hexadecimales). Generá la clave fuera de este repositorio y conservá una copia de recuperación en un gestor de secretos independiente del servidor y del volumen de backups. No la guardes junto al paquete cifrado.

El directorio de objetos debe ser el mismo directorio local que usa el servidor, estar separado del directorio de backups y ser legible por `bombo`. Ambos directorios existentes deben tener modo `0700`. El worker valida esas condiciones y falla cerrado ante enlaces simbólicos, solapamientos o configuración de almacenamiento remoto.

Antes de habilitar el timer, instalá las unidades y ejecutá `operations-backup-worker-check.service`. Ese servicio invoca `--dry-run` dentro de un namespace sin red: valida configuración y permisos, no conecta a PostgreSQL, no escribe archivos y no invoca almacenamiento externo. Para activar la programación diaria, habilitá `operations-backup-worker.timer`; instalar o habilitar unidades en un host es una acción operativa separada y no forma parte de esta entrega.

## Ensayo local PostgreSQL 18

El paquete de prueba `tests/operations-backup.test.ts` crea datos sintéticos en un esquema temporal de una base de pruebas loopback, ejecuta el worker real con cifrado, lee el paquete publicado, altera y rechaza un manifiesto de migraciones, y restaura en una base dedicada vacía `bombo_ui_restore...`. El restore compara migraciones, conteos, huellas financieras y objetos locales. La prueba no usa servicios pagos ni escribe a S3: el único endpoint S3 de la suite es un servidor falso loopback que comprueba que el restore lo evita.

Para reproducir, usá sólo bases locales descartables que cumplan `TEST_DATABASE_URL` y `RESTORE_TEST_DATABASE_URL`, activá `OPERATIONS_BACKUP_RESTORE_E2E=true` y apuntá `PG_BIN` a clientes PostgreSQL 18. La suite crea/elimina su esquema de prueba y, dentro del subcaso de restore, elimina el esquema restaurado para probar un destino vacío. No apuntes esas variables a producción, a un túnel remoto ni a bases con trabajo que quieras conservar.

## Copia y restauración cloud

`scripts/operations-backup-cloud-worker.mjs backup|restore` usa el rol de tarea ECS para S3/KMS; no admite claves AWS estáticas y no crea buckets, claves, roles ni alarmas. Variables del backup:

- `BACKUP_ENCRYPTION_KEY`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_KMS_KEY_ARN`.
- `DATABASE_URL` directa con TLS, `PRIVATE_OBJECT_PROVIDER=vercel-blob` y `BLOB_READ_WRITE_TOKEN`.
- `BACKUP_S3_PREFIX` es opcional (`bombo` por defecto); `BACKUP_TIER` admite `frequent`, `daily` o `monthly`.

La restauración cloud requiere `RESTORE_DATABASE_URL` y `RESTORE_DATABASE_ALLOWLIST` (pares exactos `host/base`), además de:

- `RESTORE_OBJECT_BUCKET`, `RESTORE_OBJECT_BUCKET_ALLOWLIST` (nombres exactos, sin comodines), `RESTORE_OBJECT_REGION` y `RESTORE_OBJECT_KMS_KEY_ARN` (ARN de clave en esa misma región).
- `BACKUP_RESTORE_COMMIT_KEY` y `BACKUP_RESTORE_COMMIT_VERSION_ID` para señalar la versión exacta del commit.

El worker fija `RESTORE_OBJECT_PROVIDER=s3` y `BACKUP_RESTORE_BACKUP_ID` en el proceso hijo del CLI. No son secretos ni requieren valores AWS estáticos.

El destino remoto debe estar explícitamente allowlisted. `RESTORE_OBJECT_BUCKET` debe ser un bucket S3 nuevo, distinto del bucket fuente de backups, con versionado habilitado y vacío, incluidas versiones y marcadores de borrado. El restore escribe las nuevas versiones privadas con SSE-KMS usando `RESTORE_OBJECT_KMS_KEY_ARN`; el rol requiere permiso de escritura en ese bucket destino y uso de esa clave, además de lectura de las versiones del bucket fuente. No necesita borrar objetos del destino. El CLI verifica cada versión/checksum y, en una transacción, actualiza las referencias de documentos y escribe el acuse durable `restore.coordinated` junto con auditorías por objeto. El worker emite `committed=true` con `auditId` sólo después de validar ese acuse. El `rm` final elimina únicamente el paquete cifrado temporal descargado localmente; no borra objetos S3. El restore local de ensayo mantiene `scope=verification-only`; sólo el camino cloud informa `coordinated-cloud`. Si una restauración cloud falla después de escribir objetos, no reutilices ese bucket parcial: prepará otro destino vacío para un nuevo intento.

## Alcance de la recuperación

`operations-backup.mjs restore` sin configuración cloud es únicamente un ensayo seguro: sólo acepta bases PostgreSQL loopback con nombre dedicado `bombo_restore*`, `bombo_test*` o `bombo_ui_*`; exige un destino de objetos local vacío, absoluto y separado del almacén normal y del paquete. Antes de cambiar el esquema comprueba tablas, funciones, namespaces de usuario y tipos PostgreSQL, y aborta ante cualquier objeto. No usa `CASCADE`. Un fallo durante `pg_restore` puede dejar parcial el esquema descartable; recreá esa base de ensayo vacía antes de repetir.

Para verificar un paquete sin tocar una base, ejecutá `node scripts/operations-backup.mjs verify <directorio-del-paquete>` con `BACKUP_ENCRYPTION_KEY` en el entorno privado. Para ensayar una restauración local, configurá `RESTORE_DATABASE_URL` hacia una base loopback nueva y dedicada, `RESTORE_PRIVATE_OBJECT_ROOT` hacia un directorio local vacío separado, y ejecutá `node scripts/operations-backup.mjs restore <directorio-del-paquete>`. El flujo cloud es un camino operativo separado: exige las allowlists y destinos nuevos anteriores, más revisar el incidente y obtener autorización para operar la restauración remota. El código local y las pruebas simuladas no acreditan IAM, AWS, CI ni un restore remoto real.

El worker no aplica retención automática. La capacidad libre, copia off-host y renovación/resguardo de claves necesitan un responsable y una política aprobada antes de depender de estos paquetes como única recuperación.

# Bombo cannabis club

## Identidad y web pública en vista previa

La marca oficial suministrada por el club se documenta en [docs/brand/guia-practica.md](docs/brand/guia-practica.md). [docs/brand/inventario.csv](docs/brand/inventario.csv) registra los 262 archivos originales con hashes y usos propuestos; [docs/brand/fuentes-contenido.md](docs/brand/fuentes-contenido.md) separa hechos y aprobaciones pendientes; [docs/brand/catalogo-historico.md](docs/brand/catalogo-historico.md) detalla nombres, descriptores y errores de piezas antiguas. Los originales siguen en `/Users/gigi/Downloads/BOMBO ID` y `public/brand` contiene únicamente exportaciones optimizadas para la vista previa.

`/` presenta la landing, `/productos` muestra las fichas curadas, `/productos/:slug` ofrece detalle y consulta, y `/app/*` contiene el panel. Los enlaces anteriores del panel redirigen a `/app/*` conservando búsqueda y fragmento. Las fichas se administran en `/app/vidriera` y las consultas en `/app/consultas`, ambos solo para dueño y gerente; los canales oficiales se configuran en **Configuración → Canales públicos**. La vidriera no consulta ni expone precios, stock o reservas del inventario. Las imágenes subidas se convierten a WebP y se guardan en PostgreSQL.

La web queda **sin despliegue público ni indexación** hasta la aprobación de Tiziano. La compilación de producción muestra una página de espera a menos que `VITE_PUBLIC_SITE_APPROVED=true`; la API pública requiere también `PUBLIC_SITE_APPROVED=true`. La lista editorial, derechos de fotografías, política de contacto, canales y cualquier texto sobre REPROCANN requieren la revisión descrita en [docs/brand/salida-vista-previa.md](docs/brand/salida-vista-previa.md). Los catálogos históricos no se importan a la operación.

**Apertura 2026:** el plan de diagnóstico, conciliación, base financiera y salida gradual está en [docs/implementacion-octubre-2026.md](docs/implementacion-octubre-2026.md). En bases reales las operaciones con cannabis están deshabilitadas por defecto; `CLUB_OPERATIONS_APPROVED=true` requiere validación documentada por el profesional del club. Los datos reales de AppSheet, Sheets y caja siguen pendientes de recibir y conciliar.

Aplicación full-stack de gestión de inventario, socios, fidelización, caja, gastos y responsables de stock. Interfaz en español, responsive, con persistencia real en PostgreSQL. No usa localStorage como base de datos ni respuestas simuladas de API.

La interfaz usa oliva y crema de la identidad oficial, Bricolage Grotesque y el logotipo suministrado. El inventario conserva tarjetas por lote, indicadores de stock mínimo, alertas de vencimiento, responsable visible, detalle expandible y vista de tabla. Los componentes Minimal Card y Expandable se adaptaron del código oficial de [Cult UI](https://www.cult-ui.com/docs/components/expandable) a CSS propio; su licencia figura en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

La configuración inicial utiliza **pesos argentinos (ARS)**, formato `es-AR` y zona horaria de Buenos Aires. La demo usa precios ilustrativos en pesos (por ejemplo, $10.000 por gramo), 1 punto cada $10.000, canje de $100 por punto y presupuesto mensual de $8.000.000. No representa una cotización cambiaria ni precios de mercado. Las bases existentes conservan su configuración; cambiar el valor predeterminado no convierte registros históricos.

## Stack

Se conservan las versiones solicitadas: React/React DOM **19.1.1**, TypeScript **5.9.2** estricto en frontend y backend, Vite **7.1.4**, plugin React **5.0.2**, React Router DOM **7.8.2**, Radix Dialog **1.1.15**, Phosphor **2.1.10**, Recharts **3.1.2**, Sonner **2.0.7**, Bricolage Grotesque suministrada por el club, CSS propio, Hooks/Context y `fetch` con `useResource`.

Backend: Node **22.12+** (validado con **24.14.1**), Express **5.1.0**, PostgreSQL **16**, Prisma/Client **6.19.0**, Zod **4.1.5**, JWT **9.0.2**, bcryptjs **3.0.2**, cookie-parser **1.4.7**, Helmet **8.1.0**, cors **2.8.5**, express-rate-limit **8.1.0**, dotenv **17.2.2**, PDFKit **0.17.2**, ExcelJS **4.4.0** y Sharp **0.34.x** para las imágenes de vidriera. Exportación CSV propia; importación con `csv-parse` **7.0.2**. Playwright y Node Test Runner para pruebas.

## Inicio local

```sh
npm ci
```

Copiar `.env.example` a `.env`. Configurar `DATABASE_URL`, un `JWT_SECRET` aleatorio de al menos 32 caracteres y los orígenes del frontend en `ALLOWED_ORIGIN`. Si se usa Docker Compose, configurar también `POSTGRES_PASSWORD` con una contraseña aleatoria y usarla en `DATABASE_URL` (`postgresql://raiz:<contraseña>@localhost:5432/raiz?schema=public`). Para generar un secreto:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Iniciar PostgreSQL 16 existente, o usar la base de Docker:

```sh
docker compose up -d db
npm run db:generate
npm run db:migrate
```

Elegir uno de los dos modos antes de ejecutar el seed:

- **Demo:** `DEMO_MODE=true` y `NODE_ENV=development`. El seed crea 7 usuarios, 24 socios, 12 lotes, 90 días de ventas y movimientos conciliados. El login muestra «Explorar club de demostración» y permite probar los roles. Todo cambio se persiste en la base de demostración.
- **Club real:** `DEMO_MODE=false`, definir `ADMIN_EMAIL`, `ADMIN_NAME` y `ADMIN_PASSWORD` (12 caracteres mínimo). El seed crea solamente el administrador. Usar una base distinta de la demo; cambiar el flag no elimina registros ni usuarios de ejemplo.

```sh
npm run db:seed
npm run dev
```

Frontend predeterminado: `http://127.0.0.1:5173`. API: `http://127.0.0.1:3001`. Los puertos se pueden cambiar con `VITE_PORT` y `PORT`; actualizar también `ALLOWED_ORIGIN`. El proxy de Vite sigue `PORT`.

El seed nunca borra datos: si ya existen usuarios, termina sin modificar la base. Los datos de ejemplo tienen fechas relativas al día de ejecución. Las credenciales demo (`owner@demo.bombo.local`, `Demo-Bombo-2026!`) son públicas y exclusivas de pruebas.

## Funcionalidad

- **Dashboard:** períodos día, últimos 7 días y mes; comparación con período anterior equivalente; ventas, stock a costo, clientes activos, margen, ticket medio, recompra, top 10 por importe/frecuencia, inactivos 30/60/90 días, vencimientos, gastos/presupuesto y ranking de responsables.
- **Inventario:** productos/lotes, cepa, tipo, gramos/unidades, precios, mínimos, ubicación, proveedor, responsable y vencimiento. El dueño guarda proveedores con contacto y notas, marca uno como predeterminado y puede archivarlos sin perder los lotes vinculados. Al crear un lote se elige un proveedor guardado; el inventario se puede filtrar por proveedor. Alta, edición de datos, entradas, salidas, ajustes por conteo y traspasos completos de lote. Historial completo paginado de 100 en 100.
- **Socios:** altas/edición, notas internas, puntos, nivel por gasto acumulado, historial, frecuencia, segmentos top/inactivos/en riesgo.
- **Ventas:** carrito con varios productos, socio, responsable derivado del lote, pago efectivo/tarjeta/transferencia, descuentos por nivel y puntos, comprobante imprimible. El servidor recalcula todos los importes.
- **Caja:** libro de movimientos reales por efectivo/banco y categoría, con aportes, retiros, compras de stock e inversiones separados. Venta local crea un movimiento automáticamente. El cierre suma saldo anterior y movimientos de efectivo desde el cierre previo; registra esperado, contado y diferencia. El saldo inicial debe cargarse y conciliarse.
- **Planificación:** partidas manuales por escenario, proyección semanal de 13 semanas y resumen mensual 2027. Sin partidas cargadas no se infieren ingresos ni gastos futuros.
- **Gastos:** fijos/variables, categorías, asignación opcional, recurrencia semanal/mensual, ingresos menos gastos y presupuesto. «Procesar recurrencias» materializa los vencimientos pendientes de forma idempotente; no se generan cargos bancarios ni se ejecutan pagos externos.
- **Responsables:** vista consolidada y por responsable, costos/margen por producto, ventas históricas atribuidas al responsable original, ranking y rotación.
- **Reportes:** ventas detalladas en CSV/XLSX y resumen de liquidación por responsable en PDF; filtros de fecha y ámbito aplicados en servidor.
- **Migración:** productos, socios y movimientos de caja/banco mediante CSV exportado de Sheets/AppSheet, identificadores de origen, validación por fila, omitidos y conflictos, vista previa y confirmación atómica. Los cobros del delivery importados no crean ventas ni descuentan stock local. No requiere acceso a la cuenta de Google.
- **Equipo:** creación de usuarios con rol desde la cuenta del dueño. Los permisos no dependen de ocultar botones.

## Permisos

| Rol          | Acceso                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Dueño        | Consolidado, todos los módulos, configuración y alta de usuarios                                                  |
| Gerente      | Operación global, configuración, importación y traspasos; sin alta de usuarios                                    |
| Responsable  | Solo sus lotes, sus líneas de venta, movimientos propios y gastos asignados; no puede traspasar ni cambiar reglas |
| Cajero       | Inventario sin costos, ventas, socios y cierre; sin gastos, reportes ni ajustes de stock                          |
| Solo lectura | Consulta y reportes, sin mutaciones                                                                               |

Un responsable no puede ampliar su ámbito cambiando `?owner=` ni enviando IDs ajenos. Los reportes siguen el mismo filtro. Las ventas mixtas se recortan a sus líneas. Los puntos y notas globales del socio se ocultan para este rol; el descuento real lo determina el servidor.

## Modelo y reglas

El esquema se encuentra en `prisma/schema.prisma`: usuarios, proveedores, productos/lotes, socios, ventas, líneas, movimientos de stock y caja, partidas proyectadas, gastos, reglas recurrentes, cierres y configuración.

- Dinero en **centavos enteros**. Stock/cantidades en **milésimas** de gramo o unidad; los artículos por unidad requieren cantidades enteras.
- Cada lote tiene un responsable actual. Cada línea de venta conserva responsable, nombre, precio y costo originales. Los traspasos no reescriben ventas anteriores.
- Las ventas ejecutan validación, descuento de stock, generación de movimiento y saldo de puntos dentro de una transacción `Serializable`. Se reintentan conflictos de serialización. `requestId` evita cobrar dos veces al reintentar una solicitud.
- El cierre y la venta usan transacciones serializables, para que no se inserte una venta incompatible con un cierre concurrente.
- Los precios del carrito son informativos: la API usa los precios vigentes de la base. El canje nunca puede producir un total negativo.
- Puntos: `floor(total neto / importe por punto)`. Niveles determinados por gasto neto acumulado previo a la compra. Descuento de nivel y luego canje de puntos.
- Margen bruto: ingresos netos menos costo histórico; no descuenta gastos operativos. El resultado de gestión preliminar también resta gastos operativos registrados. El libro de caja solo incluye cobros y pagos efectivamente registrados.
- Rotación mostrada: costo vendido en el mes dividido por valor del stock actual a costo; no usa inventario promedio histórico.
- Tasa de recompra: clientes con dos o más compras en el período / clientes con al menos una compra en el período.
- Inactivo: días desde última compra, o desde alta si no compró. En riesgo: entre la mitad del umbral y el umbral de inactividad.
- Cierres y agrupación por día usan la zona horaria configurada. La fecha de una venta histórica no cambia al modificar la zona horaria.
- Cambiar moneda con ventas existentes está bloqueado para evitar relabelar importes sin conversión.
- Los registros contables no tienen borrado ni devolución automática. Las correcciones de stock se registran mediante movimientos; un sistema de devoluciones contables sería una extensión específica.

## Importar desde Google Sheets

1. En Configuración → Importar desde Sheets, elegir productos o socios y descargar la plantilla.
2. Copiar las columnas de la planilla al formato de la plantilla. Exportar como CSV UTF-8.
3. Subir, revisar los errores y la vista previa, y confirmar.

Productos: `name,strain,type,unit,lot,supplier,stock,minimum,cost,price,location,ownerId,expires,sourceSystem,sourceId`.

`name` es el nombre completo con el que identificás el producto, por ejemplo `Lemon Haze` o `Aceite CBD 10%`. `strain` funciona como perfil opcional (`Sativa`, `Índica`, `Híbrida`, `CBD`) y puede quedar vacío cuando no corresponda. Al cargar stock desde la app, los nombres y perfiles de lotes guardados aparecen como sugerencias para reutilizarlos.

Socios: `name,email,phone,notes,sourceSystem,sourceId`. Los dos últimos campos son obligatorios para cada lote y socio importado. `sourceSystem` identifica la fuente (por ejemplo, `appsheet`) y `sourceId` el ID estable en esa fuente. La importación repetida omite registros iguales y bloquea los conflictivos para revisión.

Movimientos financieros: `date,account,category,amount,description,sourceSystem,sourceId`. `account` es `cash` o `bank`; importes con signo en ARS, decimal punto. Categorías: `opening_balance`, `operating_expense`, `stock_purchase`, `local_investment`, `capital_contribution`, `owner_draw`, `delivery_receipt`, `other_income`, `other_outflow`, `adjustment`. Un movimiento en efectivo previo a un cierre requiere conciliación antes de importar. Los movimientos del delivery no se suman a las ventas locales del resultado preliminar.

Los importes del CSV se expresan en moneda principal (por ejemplo `12.50`), no en centavos; las cantidades en gramos/unidades, no en milésimas. `ownerId` usa el identificador real del usuario; la plantilla incluye un ejemplo válido. Fechas `AAAA-MM-DD`, separador coma o punto y coma, decimal punto. Lotes conflictivos o responsables desconocidos bloquean la confirmación completa; filas idénticas de la misma fuente se omiten. Límite 2.000 filas. La importación actual no importa ventas históricas ni saldos de puntos: requieren un mapeo específico de la planilla original para evitar asignaciones y totales incorrectos.

## API

Todas las rutas de datos requieren JWT en cookie `HttpOnly`, `SameSite=Strict`; las mutaciones también requieren un `Origin` incluido en `ALLOWED_ORIGIN`.

| Método     | Ruta                                       | Uso                                        |
| ---------- | ------------------------------------------ | ------------------------------------------ |
| POST       | `/api/auth/login`, `/api/auth/logout`      | Sesión                                     |
| GET        | `/api/auth/me`, `/api/config`              | Sesión y disponibilidad de demo            |
| POST       | `/api/auth/demo`                           | Sesión demo, deshabilitada en producción   |
| GET        | `/api/views/:view?owner=`                 | Datos acotados de inicio, inventario, socios, ventas, gastos, finanzas, responsables, reportes o configuración |
| GET        | `/api/dashboard?range=&inactiveDays=&owner=` | Agregados del panel calculados en PostgreSQL |
| GET        | `/api/list/customers`, `/api/list/products`, `/api/list/sales` | Listados de hasta 50 filas con `items`, `total`, `nextCursor` y `summary` |
| GET        | `/api/list/expenses?month=`, `/api/list/cash-entries`, `/api/movements` | Historial paginado con cursor estable |
| GET        | `/api/customers/:id/history`, `/api/checkout/customers`, `/api/checkout/products` | Ficha del socio y selección acotada al registrar ventas |
| GET        | `/api/search?q=`                          | Búsqueda global acotada por permisos       |
| POST/PATCH | `/api/products`, `/api/products/:id`       | Alta/edición                               |
| POST       | `/api/products/:id/movements`              | Entrada/salida/ajuste/traspaso             |
| POST/PATCH | `/api/customers`, `/api/customers/:id`     | Socios                                     |
| POST       | `/api/sales`                               | Venta transaccional e idempotente          |
| POST       | `/api/closures`                            | Cierre diario                              |
| POST       | `/api/cash-entries`, `/api/cash-plans`     | Movimientos reales y partidas proyectadas; dueño/gerente |
| PATCH      | `/api/customers/:id/permit`               | Estado y vigencia del permiso; dueño/gerente |
| POST       | `/api/expenses`, `/api/expenses/recurring` | Gastos/recurrencias                        |
| PUT        | `/api/settings`                            | Configuración                              |
| POST       | `/api/users`                               | Alta de usuarios, solo dueño               |
| POST       | `/api/import`                              | Previsualización o confirmación CSV        |
| GET        | `/api/reports/:format?from=&to=&owner=`    | `csv`, `xlsx` o `pdf`                      |
| GET        | `/api/health`                              | Comprueba conexión a PostgreSQL            |

La API pública de vista previa agrega `GET /api/site`, `GET /api/site/showcase`, `GET /api/site/showcase/:slug`, `GET /api/site/showcase/:slug/image` y `POST /api/site/inquiries`. Las rutas `/api/site/admin/*` requieren sesión de dueño o gerente y gestionan canales, fichas, imágenes y consultas. Las consultas se paginan con `nextCursor` y no crean socios. En producción, las rutas públicas permanecen cerradas hasta establecer `PUBLIC_SITE_APPROVED=true`.

## Pruebas

`npm run check` valida tipos, pruebas unitarias e integración y compilación. Para no omitir las pruebas con PostgreSQL, configurá `TEST_DATABASE_URL` con una base local dedicada `bombo_ui_*`, distinta de `DATABASE_URL`. Las pruebas crean y eliminan esquemas temporales. `npm run test:e2e` inicia API y Vite en puertos locales efímeros con un esquema desechable, aplica migraciones y seed, y elimina el esquema al terminar. El runner rechaza hosts externos, la base principal y nombres que no empiecen por `bombo_ui_`; no uses un túnel local hacia otra base.

### Medición de carga

El fixture de rendimiento requiere una base **vacía y desechable** llamada `raiz_bench`: `BENCH_DATABASE_URL=.../raiz_bench npm run bench:seed`. Crea 5.000 socios, 500 lotes, 100.000 ventas con sus líneas y 100.000 asientos de caja. Aplicá las migraciones antes de sembrar y ejecutá `ANALYZE` (el script lo hace). `BENCH_BASELINE_URL` y `BENCH_OPTIMIZED_URL` deben apuntar a las versiones anterior y nueva del servidor con esa misma base; `npm run bench:measure` obtiene una sesión de prueba y mide la mediana de tres solicitudes por pantalla, tras una de calentamiento. `npm run bench:compare` concilia ingresos, costos, caja, stock, puntos y atribución contra la versión anterior. No apuntes estas variables a producción.

Medición local del 23 de septiembre de 2026, PostgreSQL de prueba y respuestas sin compresión HTTP:

| Ruta / pantalla | Antes (`/api/state`) | Después |
| --- | ---: | ---: |
| Respuesta inicial | 51,7 MB · 8,8 s | Inicio: 160 KB · 81 ms |
| Inventario | 51,7 MB · 8,8 s | 16 KB · 12 ms |
| Socios | 51,7 MB · 8,8 s | 18 KB · 95 ms |
| Ventas | 51,7 MB · 8,8 s | 27 KB · 28 ms |
| Finanzas | 51,7 MB · 8,8 s | 169 KB · 34 ms |

En el build de producción, la apertura de Inventario pasa de unos **287 KB a 126 KB de JavaScript comprimido** (56% menos): suma el script principal, sus preloads y el módulo de Inventario. Los gráficos ya no se precargan en esa ruta. Las fuentes y CSS no forman parte de esa cifra.

Son mediciones locales de una carga sintética; no representan tiempos de red ni datos reales del club. La paginación por cursor mantiene el orden de los registros al insertar otros nuevos. Los índices nuevos se aplican con `npm run db:migrate` antes de usar la versión actualizada.

```sh
npm run typecheck
npm test
npm run build
```

Las pruebas de dominio siempre se ejecutan. La suite API crea un esquema `test_<uuid>` en la base local de pruebas, aplica migraciones SQL, prepara fixtures y elimina solo ese esquema al terminar. No usa los datos de la demo. Sin `TEST_DATABASE_URL`, las pruebas API se marcan explícitamente como omitidas.

La suite cubre descuentos/puntos, zona horaria, recurrencias, CSV, autenticación/origen, aislamiento por responsable, lectura sin permisos de escritura, venta atómica, idempotencia, stock insuficiente, concurrencia, traspasos históricos, ocultación de costos al cajero, importación atómica, permisos de socios, movimientos de caja, bloqueo legal por defecto, formatos de exportación y cierre.

Con una base PostgreSQL local de pruebas dedicada:

```sh
TEST_DATABASE_URL='postgresql://usuario:clave@127.0.0.1:5432/bombo_ui_pruebas' npm run check
TEST_DATABASE_URL='postgresql://usuario:clave@127.0.0.1:5432/bombo_ui_pruebas' npm run test:e2e
```

`BROWSER_PATH` permite elegir otro Chromium instalado. `E2E_URL` no se usa: el runner elige puertos temporales y sólo acepta el origen que crea. La suite verifica ventas, stock, socios, permisos, navegación móvil, vista previa CSV, publicación de fichas y consultas; todos sus datos se eliminan con el esquema de pruebas.

## Producción y alcance

```sh
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run build
npm start
```

Express sirve el frontend compilado y la API desde el mismo origen. Configurar `NODE_ENV=production`, `DEMO_MODE=false`, `COOKIE_SECURE=true`, un secreto único y `ALLOWED_ORIGIN=https://tu-dominio`. Ejecutar detrás de HTTPS. En contenedores usar `HOST=0.0.0.0`; localmente se usa loopback. No establecer `trust proxy=true` indiscriminadamente. Configurar copias de seguridad de PostgreSQL fuera del proceso de la app.

El backend es stateless salvo el limitador de login en memoria. JWT expira a las 8 horas; logout elimina la cookie del navegador, sin lista de revocación central. Para varias réplicas se necesita un store compartido del limitador y, si se requiere revocación inmediata, una tabla de sesiones o versión de token. No se incluyen recuperación por email, MFA, multi-club/tenancy, facturación fiscal, sincronización continua con Sheets ni integraciones bancarias.

El endpoint de estado devuelve el histórico del ámbito para calcular dashboard y fichas. Para grandes volúmenes, la siguiente evolución es agregar métricas en SQL y paginar ventas/socios del servidor; el ledger de movimientos ya está paginado. El sistema está modularizado para esa evolución, pero no se ha ensayado carga masiva ni alta disponibilidad.

### Versiones fijadas y seguridad

La auditoría de dependencias detecta avisos en versiones obligatorias, especialmente React Router DOM 7.8.2 y express-rate-limit 8.1.0, además de dependencias transitivas de Prisma/ExcelJS y herramientas de desarrollo. Se conservaron las versiones requeridas; no se ejecutó `npm audit fix --force`. La app usa BrowserRouter sin SSR/RSC ni loaders remotos, navegación interna fija, validación de origen propia y escucha IPv4 por defecto, lo cual reduce algunas superficies, pero no equivale a corregir los paquetes. Antes de exposición pública, acordar una actualización del stack y repetir la auditoría y pruebas. El parser CSV adicional sí se actualizó a una versión corregida.

No contiene secretos en archivos versionables: `.env`, `.local`, resultados de pruebas y bases locales están ignorados por Git.

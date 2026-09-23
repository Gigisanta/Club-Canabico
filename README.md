# Raíz · Club Manager

Aplicación full-stack de gestión de inventario, socios, fidelización, caja, gastos y responsables de reprogram. Interfaz en español, responsive, con persistencia real en PostgreSQL. No usa localStorage como base de datos ni respuestas simuladas de API.

Paleta violeta y negra. Inventario visual con tarjetas por lote, indicadores de stock mínimo, alertas de vencimiento, responsable visible y detalle expandible; también dispone de vista de tabla. Componentes Minimal Card y Expandable adaptados del código oficial de [Cult UI](https://www.cult-ui.com/docs/components/expandable) a CSS propio y Motion, con licencia en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

La configuración inicial utiliza **pesos argentinos (ARS)**, formato `es-AR` y zona horaria de Buenos Aires. La demo usa precios ilustrativos en pesos (por ejemplo, $10.000 por gramo), 1 punto cada $10.000, canje de $100 por punto y presupuesto mensual de $8.000.000. No representa una cotización cambiaria ni precios de mercado. Las bases existentes conservan su configuración; cambiar el valor predeterminado no convierte registros históricos.

## Stack

Se conservan las versiones solicitadas: React/React DOM **19.1.1**, TypeScript **5.9.2** estricto en frontend y backend, Vite **7.1.4**, plugin React **5.0.2**, React Router DOM **7.8.2**, Motion **12.23.12**, Radix Dialog **1.1.15**, Phosphor **2.1.10**, Recharts **3.1.2**, Sonner **2.0.7**, Manrope Variable **5.2.8**, CSS propio, Hooks/Context y `fetch` con `useResource`.

Backend: Node **22.12+** (validado con **24.14.1**), Express **5.1.0**, PostgreSQL **16**, Prisma/Client **6.19.0**, Zod **4.1.5**, JWT **9.0.2**, bcryptjs **3.0.2**, cookie-parser **1.4.7**, Helmet **8.1.0**, cors **2.8.5**, express-rate-limit **8.1.0**, dotenv **17.2.2**, PDFKit **0.17.2** y ExcelJS **4.4.0**. Exportación CSV propia; importación con `csv-parse` **7.0.2**. Playwright y Node Test Runner para pruebas.

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

El seed nunca borra datos: si ya existen usuarios, termina sin modificar la base. Los datos de ejemplo tienen fechas relativas al día de ejecución. Las credenciales demo (`owner@demo.raiz.local`, `Demo-Raiz-2026!`) son públicas y exclusivas de pruebas.

## Funcionalidad

- **Dashboard:** períodos día, últimos 7 días y mes; comparación con período anterior equivalente; ventas, stock a costo, clientes activos, margen, ticket medio, recompra, top 10 por importe/frecuencia, inactivos 30/60/90 días, vencimientos, gastos/presupuesto y ranking de responsables.
- **Inventario:** productos/lotes, cepa, tipo, gramos/unidades, precios, mínimos, ubicación, responsable y vencimiento. Alta, edición de datos, entradas, salidas, ajustes por conteo y traspasos completos de lote. Historial completo paginado de 100 en 100.
- **Socios:** altas/edición, notas internas, puntos, nivel por gasto acumulado, historial, frecuencia, segmentos top/inactivos/en riesgo.
- **Ventas:** carrito con varios productos, socio, responsable derivado del lote, pago efectivo/tarjeta/transferencia, descuentos por nivel y puntos, comprobante imprimible. El servidor recalcula todos los importes.
- **Caja:** cierre diario global con efectivo esperado, contado, diferencia y observaciones. Una vez cerrado el día no admite nuevas ventas. No incluye fondos iniciales ni gastos pagados desde el cajón.
- **Gastos:** fijos/variables, categorías, asignación opcional, recurrencia semanal/mensual, ingresos menos gastos y presupuesto. «Procesar recurrencias» materializa los vencimientos pendientes de forma idempotente; no se generan cargos bancarios ni se ejecutan pagos externos.
- **Reprogram:** vista consolidada y por responsable, costos/margen por producto, ventas históricas atribuidas al responsable original, ranking y rotación.
- **Reportes:** ventas detalladas en CSV/XLSX y resumen de liquidación por responsable en PDF; filtros de fecha y ámbito aplicados en servidor.
- **Migración:** productos y socios mediante CSV exportado de Sheets, plantillas descargables, validación por fila, vista previa y confirmación atómica. No requiere acceso a la cuenta de Google.
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

El esquema se encuentra en `prisma/schema.prisma`: usuarios, productos/lotes, socios, ventas, líneas, movimientos, gastos, reglas recurrentes, cierres y configuración.

- Dinero en **centavos enteros**. Stock/cantidades en **milésimas** de gramo o unidad; los artículos por unidad requieren cantidades enteras.
- Cada lote tiene un responsable actual. Cada línea de venta conserva responsable, nombre, precio y costo originales. Los traspasos no reescriben ventas anteriores.
- Las ventas ejecutan validación, descuento de stock, generación de movimiento y saldo de puntos dentro de una transacción `Serializable`. Se reintentan conflictos de serialización. `requestId` evita cobrar dos veces al reintentar una solicitud.
- El cierre y la venta usan transacciones serializables, para que no se inserte una venta incompatible con un cierre concurrente.
- Los precios del carrito son informativos: la API usa los precios vigentes de la base. El canje nunca puede producir un total negativo.
- Puntos: `floor(total neto / importe por punto)`. Niveles determinados por gasto neto acumulado previo a la compra. Descuento de nivel y luego canje de puntos.
- Margen bruto: ingresos netos menos costo histórico; no descuenta gastos operativos. Flujo neto: ingresos menos gastos registrados.
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

Productos: `name,strain,type,unit,lot,stock,minimum,cost,price,location,ownerId,expires`.

Socios: `name,email,phone,notes`.

Los importes del CSV se expresan en moneda principal (por ejemplo `12.50`), no en centavos; las cantidades en gramos/unidades, no en milésimas. `ownerId` usa el identificador real del usuario; la plantilla incluye un ejemplo válido. Fechas `AAAA-MM-DD`, separador coma o punto y coma, decimal punto. Lotes duplicados o responsables desconocidos bloquean la confirmación completa. Límite 2.000 filas. La importación actual no importa ventas históricas ni saldos de puntos: requieren un mapeo específico de la planilla original para evitar asignaciones y totales incorrectos.

## API

Todas las rutas de datos requieren JWT en cookie `HttpOnly`, `SameSite=Strict`; las mutaciones también requieren un `Origin` incluido en `ALLOWED_ORIGIN`.

| Método     | Ruta                                       | Uso                                        |
| ---------- | ------------------------------------------ | ------------------------------------------ |
| POST       | `/api/auth/login`, `/api/auth/logout`      | Sesión                                     |
| GET        | `/api/auth/me`, `/api/config`              | Sesión y disponibilidad de demo            |
| POST       | `/api/auth/demo`                           | Sesión demo, deshabilitada en producción   |
| GET        | `/api/state?owner=`                        | Estado consolidado o filtrado por permisos |
| POST/PATCH | `/api/products`, `/api/products/:id`       | Alta/edición                               |
| POST       | `/api/products/:id/movements`              | Entrada/salida/ajuste/traspaso             |
| GET        | `/api/movements?page=&owner=`              | Historial paginado                         |
| POST/PATCH | `/api/customers`, `/api/customers/:id`     | Socios                                     |
| POST       | `/api/sales`                               | Venta transaccional e idempotente          |
| POST       | `/api/closures`                            | Cierre diario                              |
| POST       | `/api/expenses`, `/api/expenses/recurring` | Gastos/recurrencias                        |
| PUT        | `/api/settings`                            | Configuración                              |
| POST       | `/api/users`                               | Alta de usuarios, solo dueño               |
| POST       | `/api/import`                              | Previsualización o confirmación CSV        |
| GET        | `/api/reports/:format?from=&to=&owner=`    | `csv`, `xlsx` o `pdf`                      |
| GET        | `/api/health`                              | Comprueba conexión a PostgreSQL            |

## Pruebas

```sh
npm run typecheck
npm test
npm run build
```

Las pruebas de dominio siempre se ejecutan. Para ejecutar también la suite API, configurar `TEST_DATABASE_URL` contra una base **de pruebas**. La suite crea un esquema `test_<uuid>`, aplica el SQL inicial, prepara fixtures y elimina solo ese esquema al terminar. No usa los datos de la demo. Sin esta variable, la prueba API se marca explícitamente como omitida.

La suite cubre descuentos/puntos, zona horaria, recurrencias, CSV, autenticación/origen, aislamiento por responsable, lectura sin permisos de escritura, venta atómica, idempotencia, stock insuficiente, concurrencia, traspasos históricos, ocultación de costos al cajero, importación atómica, formatos de exportación y cierre.

Con una demo local en ejecución:

```sh
npx playwright install chromium
npm run test:e2e
```

Se puede configurar `E2E_URL` y `BROWSER_PATH` si se usa otro puerto o un Chromium instalado. La prueba de navegador crea productos y socios prefijados `QA`, registra una venta y verifica su persistencia. Ejecutarla solo sobre datos de demostración. También comprueba navegación móvil, alcance del responsable y vista previa CSV.

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

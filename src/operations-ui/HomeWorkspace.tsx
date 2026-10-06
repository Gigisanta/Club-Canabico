import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { hasCapability, recordValue, textValue } from "./api";
import { formatMinor } from "./money";
import { EmptyState, ErrorState, InfoBand, LoadingState, SectionHeading, StatusTag } from "./Primitives";
import { useRemote } from "./useRemote";
import type { WorkspaceProps } from "./WorkspaceProps";

type Row = Record<string, unknown>;
type MoneyBucket = { currency: string | null; minor: bigint };

const DECIMAL_FACTOR = 10n ** 12n;

function asRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function rowsOf(value: unknown, key = "items"): Row[] {
  const rows = recordValue(value, key);
  return Array.isArray(rows) ? rows.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
}

function rawMoney(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function moneyBuckets(value: unknown): MoneyBucket[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap(item => {
    const row = asRow(item);
    const minor = rawMoney(row.minor);
    if (minor === null) return [];
    return [{ currency: row.currency === "ARS" || row.currency === "USD" ? row.currency : null, minor }];
  });
}

function moneyLabel(minor: bigint | null, currency: unknown): string {
  if (minor === null) return "Importe no disponible";
  if (currency !== "ARS" && currency !== "USD") return "Moneda sin identificar";
  return formatMinor(minor, currency);
}

function todayInClub(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
}

function sectionTarget(searchParams: URLSearchParams, section: string) {
  const next = new URLSearchParams(searchParams);
  next.set("section", section);
  return { search: `?${next.toString()}` };
}

function shortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toLocaleDateString("es-AR", { day: "numeric", month: "short", timeZone: "UTC" });
}

function validToday(row: Row, today: string): boolean {
  return row.state === "approved" && typeof row.validFrom === "string" && row.validFrom <= today &&
    (typeof row.validUntil !== "string" || row.validUntil >= today);
}

function scaledDecimal(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const input = String(value);
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,12}))?$/.exec(input);
  if (!match) return null;
  const fraction = (match[3] ?? "").padEnd(12, "0");
  const result = BigInt(match[2]!) * DECIMAL_FACTOR + BigInt(fraction || "0");
  return match[1] === "-" ? -result : result;
}

function decimalLabel(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / DECIMAL_FACTOR;
  const fraction = (absolute % DECIMAL_FACTOR).toString().padStart(12, "0").replace(/0+$/, "");
  return `${negative ? "−" : ""}${whole.toString()}${fraction ? `,${fraction}` : ""}`;
}

function activeStockRules(configurations: Row[], today: string): Row[] {
  const configuration = configurations.find(row => row.kind === "stock_thresholds" && validToday(row, today));
  const definition = asRow(configuration?.definition);
  return Array.isArray(definition.categories) ? definition.categories.map(asRow) : [];
}

function stockShortages(catalog: Row[], rules: Row[]): Array<{ category: string; unit: string; detail: string }> | null {
  if (!rules.length) return null;
  const categoryTotals = new Map<string, { quantity: bigint; varieties: Set<string>; valid: boolean }>();
  for (const sku of catalog) {
    const category = textValue(sku.category, "");
    const unit = textValue(sku.unit, "");
    const key = `${category}\u0000${unit}`;
    const group = categoryTotals.get(key) ?? { quantity: 0n, varieties: new Set<string>(), valid: true };
    const lots = Array.isArray(sku.lots) ? sku.lots.map(asRow) : [];
    let available = 0n;
    for (const lot of lots) {
      const balances = Array.isArray(lot.balances) ? lot.balances.map(asRow) : [];
      for (const balance of balances) {
        const availableQuantity = scaledDecimal(balance.availableQuantity);
        if (availableQuantity === null || balance.availabilityState === "pending") {
          group.valid = false;
          continue;
        }
        available += availableQuantity;
      }
    }
    group.quantity += available;
    if (available > 0n) {
      const variety = textValue(sku.variety, "");
      if (variety) group.varieties.add(variety);
    }
    categoryTotals.set(key, group);
  }

  return rules.flatMap(rule => {
    const category = textValue(rule.category, "");
    const unit = textValue(rule.unit, "");
    const group = categoryTotals.get(`${category}\u0000${unit}`) ?? { quantity: 0n, varieties: new Set<string>(), valid: true };
    const minimumQuantity = scaledDecimal(rule.minimumQuantity);
    const minimumVarieties = typeof rule.minimumVarieties === "number" && Number.isSafeInteger(rule.minimumVarieties) && rule.minimumVarieties >= 0 ? rule.minimumVarieties : null;
    if (!group.valid || minimumQuantity === null || minimumVarieties === null) {
      return [{ category, unit, detail: "Revisar existencias visibles" }];
    }
    const quantityMissing = minimumQuantity > group.quantity ? minimumQuantity - group.quantity : 0n;
    const varietiesMissing = Math.max(0, minimumVarieties - group.varieties.size);
    if (quantityMissing === 0n && varietiesMissing === 0) return [];
    const parts = [
      ...(quantityMissing > 0n ? [`faltan ${decimalLabel(quantityMissing)} ${unit}`] : []),
      ...(varietiesMissing > 0 ? [`faltan ${varietiesMissing} variedades`] : []),
    ];
    return [{ category, unit, detail: parts.join(" · ") }];
  });
}

function percentage(actual: bigint, target: bigint): { label: string; width: number } | null {
  if (target <= 0n) return null;
  const basisPoints = actual * 10000n / target;
  const absolute = basisPoints < 0n ? -basisPoints : basisPoints;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  const label = `${basisPoints < 0n ? "−" : ""}${whole}${fraction ? `,${fraction}` : ""}%`;
  const bounded = basisPoints < 0n ? 0n : basisPoints > 10000n ? 10000n : basisPoints;
  return { label, width: Number(bounded) / 100 };
}

function BusinessCard({ title, subtitle, children, action, permitted, accessMessage, hasData, loading, error, retry }: {
  title: string;
  subtitle: string;
  children: ReactNode;
  action?: ReactNode;
  permitted: boolean;
  accessMessage: string;
  hasData: boolean;
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  return <section className="ops-sheet ops-home-card">
    <div className="ops-sheet-head"><div><span className="ops-kicker">{subtitle}</span><h3>{title}</h3></div>{action && <div className="ops-home-card-action">{action}</div>}</div>
    {!permitted ? <p className="ops-home-muted">{accessMessage}</p>
      : loading && !hasData ? <LoadingState label="Cargando esta sección…" />
        : error && !hasData ? <ErrorState message={`No se pudo cargar esta sección. ${error}`} retry={retry} />
          : <>
            {loading && <p className="ops-home-muted" role="status">Actualizando. Se mantienen visibles los últimos datos recibidos.</p>}
            {error && <ErrorState message={`${error} Se conservan los últimos datos recibidos; podrían no reflejar cambios posteriores.`} retry={retry} />}
            {children}
          </>}
  </section>;
}

function methodLabel(value: unknown): string {
  if (value === "cash") return "Efectivo";
  if (value === "transfer") return "Transferencia";
  if (value === "card") return "Tarjeta";
  return "Otro medio";
}

export function HomeWorkspace({ context, refreshKey, onRefresh }: WorkspaceProps) {
  const [searchParams] = useSearchParams();
  const today = todayInClub();
  const monthStart = `${today.slice(0, 7)}-01`;
  const canFinance = hasCapability(context, "finance.read");
  const canStock = hasCapability(context, "stock.read");
  const canReadContribution = canFinance && hasCapability(context, "reports.read");
  const hasOverviewAccess = canFinance || canStock;
  const taskShortcuts = [
    ...(hasCapability(context, "members.read") ? [{ section: "members", title: "Socios", detail: "Consultar socios dentro del alcance del perfil." }] : []),
    ...(["documents.read", "documents.write", "permissions.verify"].some(capability => hasCapability(context, capability))
      ? [{ section: "permissions", title: "Permisos y documentos", detail: "Revisar la documentación y los permisos disponibles." }]
      : []),
    ...(["operations.read", "tasks.write"].some(capability => hasCapability(context, capability))
      ? [{ section: "tasks", title: "Tareas", detail: "Consultar las tareas operativas habilitadas para el perfil." }]
      : []),
  ];
  const businessCardCount = (canFinance ? 3 : 0) + (canStock ? 1 : 0);
  const contribution = useRemote<Row>(canReadContribution
    ? `/api/reports/operations/summary?area=product-contribution&from=${monthStart}&to=${today}`
    : null, refreshKey);
  const configurations = useRemote<Row>(canFinance || canStock ? "/api/operations/configuration" : null, refreshKey);
  const collections = useRemote<Row>(canFinance ? "/api/operations/collections?status=reported" : null, refreshKey);
  const payables = useRemote<Row>(canFinance ? "/api/operations/payables?open=true&verified=true" : null, refreshKey);
  const accounts = useRemote<Row>(canFinance ? "/api/operations/accounts" : null, refreshKey);
  const catalog = useRemote<Row>(canStock ? "/api/operations/catalog" : null, refreshKey);

  const summary = asRow(recordValue(contribution.data, "summary"));
  const metrics = asRow(summary.metrics);
  const managementContribution = moneyBuckets(metrics.managementContributionBeforeFixedCostsByCurrency);
  const managementCoverage = asRow(metrics.managementCoverage);
  const managementArithmeticComplete = managementCoverage.arithmeticCompleteForObservedRecords === true;
  const sourcePeriodAttested = managementCoverage.sourcePeriodCompletenessAttested === true;
  const pendingCostCount = typeof managementCoverage.pendingCostCount === "number" ? managementCoverage.pendingCostCount : null;
  const classifiedCostCount = typeof managementCoverage.classifiedCostCount === "number" ? managementCoverage.classifiedCostCount : null;
  const costQueryComplete = managementCoverage.costQueryComplete === true;
  const unresolvedChargeOrderCount = typeof managementCoverage.unresolvedChargeOrderCount === "number" ? managementCoverage.unresolvedChargeOrderCount : null;
  const allocationCoverage = asRow(metrics.allocationCoverage);
  const soldLines = typeof allocationCoverage.soldLineCount === "number" ? allocationCoverage.soldLineCount : null;
  const allocatedLines = typeof allocationCoverage.linesWithSoldLotAllocation === "number" ? allocationCoverage.linesWithSoldLotAllocation : null;
  const missingAllocations = typeof allocationCoverage.missingAllocationLineCount === "number" ? allocationCoverage.missingAllocationLineCount : null;
  const allocationExceptions = typeof allocationCoverage.allocationExceptionCount === "number" ? allocationCoverage.allocationExceptionCount : null;
  const revenueExceptions = typeof allocationCoverage.revenueExceptionLineCount === "number" ? allocationCoverage.revenueExceptionLineCount : null;
  const reportCoverage = rowsOf(summary, "coverage");
  // The goal uses contribution BEFORE fixed costs. A partial monthly fixed-cost schedule
  // does not invalidate delivered-product arithmetic or its independent attestation.
  const reportHasPartial = reportCoverage.some(row => row.state === "partial" && row.source !== "approved-fixed-cost-configuration");
  const productCoverageReady = soldLines !== null && allocatedLines === soldLines && missingAllocations === 0 && allocationExceptions === 0 && revenueExceptions === 0;

  const configurationRows = rowsOf(configurations.data);
  const objectiveRows = configurationRows.filter(row => row.kind === "objectives" && validToday(row, today));
  const objectivesByCurrency = new Map<string, bigint>();
  for (const row of objectiveRows) {
    const definition = asRow(row.definition);
    const target = rawMoney(definition.monthlyContributionMinor);
    if ((definition.currency === "ARS" || definition.currency === "USD") && target !== null && !objectivesByCurrency.has(definition.currency)) objectivesByCurrency.set(definition.currency, target);
  }
  const observedContribution = new Map((managementContribution ?? []).map(bucket => [bucket.currency ?? "", bucket.minor]));
  const contributionCurrencies = new Set<string>([
    ...observedContribution.keys(),
    ...objectivesByCurrency.keys(),
  ]);
  const contributionBuckets = contributionCurrencies.size
    ? [...contributionCurrencies].sort().map(currency => ({ currency: currency || null, minor: observedContribution.get(currency) ?? (sourcePeriodAttested && managementArithmeticComplete ? 0n : null) }))
    : managementContribution?.length ? managementContribution.map(bucket => ({ currency: bucket.currency, minor: bucket.minor })) : [];
  const coverageReady = productCoverageReady && managementArithmeticComplete && sourcePeriodAttested && pendingCostCount === 0 && costQueryComplete && unresolvedChargeOrderCount === 0 && !reportHasPartial;

  const collectionRows = rowsOf(collections.data).filter(row => row.status === "reported");
  const groupedCollections = new Map<string, bigint>();
  for (const row of collectionRows) {
    const amount = rawMoney(row.amountMinor);
    if (amount !== null && (row.currency === "ARS" || row.currency === "USD")) groupedCollections.set(row.currency, (groupedCollections.get(row.currency) ?? 0n) + amount);
  }

  const payableRows = rowsOf(payables.data).flatMap(row => {
    const amount = rawMoney(row.amountMinor);
    const paid = rawMoney(row.paidMinor);
    if (row.verified !== true || amount === null || paid === null || amount <= paid || typeof row.dueDate !== "string") return [];
    return [{ row, remaining: amount - paid }];
  }).sort((left, right) => String(left.row.dueDate).localeCompare(String(right.row.dueDate))).slice(0, 4);

  const custodyRows = rowsOf(accounts.data).filter(row => row.kind === "custody");
  const custodyBalances = new Map<string, bigint>();
  let unknownCustodyCount = 0;
  for (const row of custodyRows) {
    const balance = rawMoney(row.balanceMinor);
    if (balance === null) unknownCustodyCount += 1;
    else if (row.currency === "ARS" || row.currency === "USD") custodyBalances.set(row.currency, (custodyBalances.get(row.currency) ?? 0n) + balance);
  }

  const shortages = recordValue(catalog.data,"hasMore") === true || recordValue(catalog.data,"availabilityCoverage") === "pending" ? null : stockShortages(rowsOf(catalog.data), activeStockRules(configurationRows, today));
  const stockRulesKnown = configurations.data !== null && configurationRows.some(row => row.kind === "stock_thresholds" && validToday(row, today));

  return <div className="ops-page-body ops-home-page">
    <SectionHeading eyebrow="Inicio · hoy" title={canFinance ? "El negocio, hoy" : canStock ? "Stock disponible" : "Tus secciones disponibles"} detail={canFinance ? `Mes a la fecha · ${shortDate(monthStart)} al ${shortDate(today)}` : canStock ? "Revisá la disponibilidad y los mínimos vigentes." : "Abrí una sección habilitada para tu perfil."} action={hasOverviewAccess ? <button type="button" className="ops-button ops-button-quiet" onClick={onRefresh}>Actualizar</button> : undefined} />
    {!hasOverviewAccess && <section className="ops-sheet ops-home-task-section">
      <div className="ops-sheet-head"><div><span className="ops-kicker">Accesos disponibles</span><h3>Continuá con una tarea permitida</h3></div></div>
      {taskShortcuts.length > 0 ? <div className="ops-home-task-grid">{taskShortcuts.map(shortcut => <Link className="ops-home-task-link" key={shortcut.section} to={sectionTarget(searchParams, shortcut.section)}><strong>{shortcut.title}</strong><span>{shortcut.detail}</span></Link>)}</div>
        : <EmptyState title="Sin accesos directos disponibles" detail="Las secciones habilitadas para tu perfil aparecen en la navegación." />}
    </section>}
    {canReadContribution && <section className="ops-sheet ops-home-contribution">
      <div className="ops-home-contribution-head"><div><span className="ops-kicker">Resultado del mes · antes de costos fijos</span><h3>Contribución frente al objetivo</h3><p>Importes por moneda. El avance se muestra junto con la cobertura de ventas y costos por lote.</p></div>
        <div className="ops-home-contribution-actions">
          {contribution.loading ? <StatusTag>Actualizando</StatusTag> : contribution.error || configurations.error ? <StatusTag tone="warn">Actualización fallida</StatusTag> : coverageReady ? <StatusTag tone="good">Período conciliado</StatusTag> : managementArithmeticComplete ? <StatusTag tone="warn">Observado · sin conciliar</StatusTag> : <StatusTag tone="warn">Contribución desconocida</StatusTag>}
          <Link className="ops-link ops-home-card-link" to={sectionTarget(searchParams, "reports")}>Ver informe</Link>
        </div>
      </div>
      {configurations.error && <ErrorState message={configurations.data === null
        ? `No se pudieron consultar los objetivos vigentes. ${configurations.error}`
        : `${configurations.error} Se conservan los últimos objetivos recibidos; podrían no reflejar cambios posteriores.`} retry={configurations.retry} />}
      {contribution.loading && contribution.data === null ? <LoadingState label="Calculando contribución…" />
          : contribution.error && contribution.data === null ? <ErrorState message={`No se pudo obtener la contribución del período. ${contribution.error}`} retry={contribution.retry} />
            : <>
              {contribution.loading && <p className="ops-home-muted" role="status">Actualizando. Se mantienen visibles los últimos datos recibidos.</p>}
              {contribution.error && <ErrorState message={`${contribution.error} Se conservan los últimos datos recibidos; podrían no reflejar cambios posteriores.`} retry={contribution.retry} />}
              {contributionBuckets.length === 0
                ? <EmptyState title="Contribución desconocida" detail={pendingCostCount !== null && pendingCostCount > 0 ? `${pendingCostCount} obligaciones esperan verificación, período de devengamiento o clasificación de costo.` : "El período no aporta un importe de gestión con cobertura suficiente para mostrarlo."} />
                : <div className="ops-home-goals">{contributionBuckets.map((bucket, index) => {
                const target = bucket.currency ? objectivesByCurrency.get(bucket.currency) : undefined;
                const actual = bucket.minor;
                const progress = target === undefined || actual === null ? null : percentage(actual, target);
                const canShowProgress = coverageReady && progress !== null;
                const targetLabel = target !== undefined ? moneyLabel(target, bucket.currency)
                  : configurations.data === null && configurations.loading ? "Consultando objetivo…"
                    : configurations.data === null && configurations.error ? "Objetivo no disponible"
                      : "Sin objetivo aprobado";
                return <article className="ops-home-goal" key={`${bucket.currency ?? "unknown"}-${index}`}>
                  <div className="ops-home-goal-values"><div><span>{actual === null ? "Contribución" : "Contribución de gestión observada"}</span><strong>{actual === null ? "Contribución desconocida" : moneyLabel(actual, bucket.currency)}</strong></div><div><span>Objetivo mensual</span><strong>{targetLabel}</strong></div></div>
                  {target !== undefined && <div className="ops-home-progress-wrap">
                    {canShowProgress && progress ? <><div className="ops-home-progress-label"><span>Avance observado</span><strong>{progress.label}</strong></div><div className="ops-home-progress" role="progressbar" aria-label={`Avance del objetivo ${bucket.currency}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.width}><span style={{ width: `${progress.width}%` }} /></div></>
                      : <p className="ops-home-muted">El objetivo no muestra avance mientras la contribución, los costos clasificados y la conciliación del período sigan incompletos.</p>}
                  </div>}
                </article>;
              })}</div>}
            </>}
      <div className="ops-home-coverage">
        {soldLines !== null && allocatedLines !== null ? <span>{allocatedLines} de {soldLines} líneas vendidas con costo por lote</span> : soldLines !== null ? <span>{soldLines} líneas vendidas; cobertura de costo por lote sin dato</span> : <span>Cobertura de líneas por lote sin dato</span>}
        {missingAllocations !== null && missingAllocations > 0 && <StatusTag tone="warn">{missingAllocations} sin asignación</StatusTag>}
        {pendingCostCount !== null && pendingCostCount > 0 && <StatusTag tone="warn">{pendingCostCount} obligaciones sin clasificación completa</StatusTag>}
        {classifiedCostCount !== null && costQueryComplete && <span>{classifiedCostCount} costos clasificados por período</span>}
        {unresolvedChargeOrderCount !== null && unresolvedChargeOrderCount > 0 && <StatusTag tone="warn">{unresolvedChargeOrderCount} pedidos con cargos pendientes</StatusTag>}
        {reportHasPartial && <StatusTag tone="warn">Período parcial</StatusTag>}
        {!sourcePeriodAttested && <span>Período de origen sin conciliación documental</span>}
        {reportCoverage.some(row => row.state === "unverified") && <span>Fuentes sin conciliación documental</span>}
      </div>
    </section>}

    {businessCardCount > 0 && <div className={`ops-home-business-grid${businessCardCount === 1 ? " ops-home-business-grid-single" : ""}`}>
      {canFinance && <>
      <BusinessCard title="Cobros por verificar" subtitle="Ingresos" action={canFinance && <Link className="ops-link ops-home-card-link" to={sectionTarget(searchParams, "collections")}>Ver cobros</Link>} permitted={canFinance} accessMessage="El perfil actual no tiene acceso de lectura financiera a esta información." hasData={collections.data !== null} loading={collections.loading} error={collections.error} retry={collections.retry}>
        {collectionRows.length === 0 ? <EmptyState title="Todo al día" detail="No hay cobros informados pendientes de verificación." /> : <>
          <div className="ops-home-card-total"><strong>{recordValue(collections.data,"hasMore") === true ? "Más de " : ""}{collectionRows.length}</strong><span>cobros informados</span></div>
          <div className="ops-home-currency-lines">{[...groupedCollections].map(([currency, minor]) => <span key={currency}>{moneyLabel(minor, currency)}</span>)}</div>
          <ul className="ops-home-list">{collectionRows.slice(0, 4).map((row, index) => <li key={textValue(row.id, String(index))}><div><strong>Pedido {textValue(row.orderId, "—").slice(0, 8)}</strong><span>{methodLabel(row.method)}</span></div><b>{moneyLabel(rawMoney(row.amountMinor), row.currency)}</b></li>)}</ul>
        </>}
      </BusinessCard>

      <BusinessCard title="Próximos pagos" subtitle="Compromisos" action={canFinance && <Link className="ops-link ops-home-card-link" to={sectionTarget(searchParams, "payables")}>Ver obligaciones</Link>} permitted={canFinance} accessMessage="El perfil actual no tiene acceso de lectura financiera a esta información." hasData={payables.data !== null} loading={payables.loading} error={payables.error} retry={payables.retry}>
        {payableRows.length === 0 ? <EmptyState title="Sin pagos próximos visibles" detail="Las obligaciones verificadas y pendientes aparecerán acá." /> : <ul className="ops-home-list ops-home-payables">{payableRows.map(({ row, remaining }, index) => {
          const dueDate = textValue(row.dueDate, "");
          const overdue = dueDate < today;
          const kindLabels: Record<string, string> = { purchase: "Compra", operating_expense: "Gasto operativo", courier_fee: "Remuneración del repartidor", asset_purchase: "Compra de activo", owner_withdrawal: "Retiro del propietario", other: "Otra obligación" };
          return <li key={textValue(row.id, String(index))}><div><strong>{kindLabels[textValue(row.kind)] ?? "Obligación"}</strong><span>Vence {shortDate(dueDate)}{overdue ? " · vencido" : ""}</span></div><b>{moneyLabel(remaining, row.currency)}</b></li>;
        })}</ul>}
      </BusinessCard>

      <BusinessCard title="Efectivo en custodia" subtitle="Rendición" action={canFinance && <Link className="ops-link ops-home-card-link" to={sectionTarget(searchParams, "accounts")}>Ver cuentas</Link>} permitted={canFinance} accessMessage="El perfil actual no tiene acceso de lectura financiera a esta información." hasData={accounts.data !== null} loading={accounts.loading} error={accounts.error} retry={accounts.retry}>
        {custodyRows.length === 0 ? <EmptyState title="Sin efectivo en custodia" detail="No hay cuentas de custodia visibles para este perfil." /> : <>
          <div className="ops-home-currency-lines">{[...custodyBalances].map(([currency, minor]) => <span key={currency}>{moneyLabel(minor, currency)}</span>)}</div>
          {unknownCustodyCount > 0 && <p className="ops-home-muted">{unknownCustodyCount} cuenta(s) sin saldo de apertura conciliado.</p>}
          <ul className="ops-home-list">{custodyRows.slice(0, 4).map((row, index) => <li key={textValue(row.id, String(index))}><div><strong>{textValue(row.name, "Cuenta de custodia")}</strong><span>{textValue(row.currency, "Moneda desconocida")}</span></div><b>{moneyLabel(rawMoney(row.balanceMinor), row.currency)}</b></li>)}</ul>
        </>}
      </BusinessCard>
      </>}

      {canStock && <BusinessCard title="Faltantes" subtitle="Stock disponible" action={<Link className="ops-link ops-home-card-link" to={sectionTarget(searchParams, "catalog")}>Abrir catálogo</Link>} permitted={canStock} accessMessage="El perfil actual no tiene acceso de lectura al catálogo y su disponibilidad." hasData={catalog.data !== null && configurations.data !== null} loading={catalog.loading || configurations.loading} error={catalog.error || configurations.error} retry={() => { catalog.retry(); configurations.retry(); }}>
        {!stockRulesKnown ? <EmptyState title="Sin mínimos aprobados" detail="No hay reglas vigentes para identificar faltantes por categoría." />
          : shortages === null ? <EmptyState title="Stock en revisión" detail="No se pudo determinar la cobertura de los mínimos visibles." />
            : shortages.length === 0 ? <EmptyState title="Sin faltantes por mínimo" detail="El stock visible y habilitado alcanza los mínimos vigentes por categoría." />
              : <ul className="ops-home-list ops-home-shortages">{shortages.slice(0, 5).map((shortage, index) => <li key={`${shortage.category}-${shortage.unit}-${index}`}><div><strong>{shortage.category}</strong><span>{shortage.detail}</span></div><StatusTag tone="warn">Reponer</StatusTag></li>)}</ul>}
      </BusinessCard>}
    </div>}
  </div>;
}

export function MissingRoute({ title, contract }: { title: string; contract: string }) {
  return (
    <div className="ops-page-body">
      <SectionHeading eyebrow="Integración pendiente" title={title} detail="La interfaz está preparada para conectarse al contrato del servidor." />
      <InfoBand tone="blocked" title="La ruta no está montada en este checkout">
        <p>{contract}</p>
      </InfoBand>
    </div>
  );
}

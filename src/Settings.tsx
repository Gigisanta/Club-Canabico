import { useState } from "react";
import {
  GearSix,
  ShieldCheck,
  UploadSimple,
  FileCsv,
  Plus,
  DownloadSimple,
  CheckCircle,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { useClub, send, roleLabels, type Settings as Config } from "./lib";
import { PageHeader, Panel, Form, Field, Avatar, Badge, Modal } from "./ui";
interface ImportResult {
  count: number;
  skipped: number;
  errors: string[];
  preview: Record<string, unknown>[];
  committed: boolean;
}
export default function Settings() {
  const { state, reload, isManager, user } = useClub();
  const [tab, setTab] = useState("general");
  const [addUser, setAddUser] = useState(false);
  const [kind, setKind] = useState("products");
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(fd: FormData) {
    const v: Record<string, unknown> = {
      ...state.settings,
      ...Object.fromEntries(fd),
    };
    for (const k of [
      "pointsEvery",
      "pointValue",
      "silverAt",
      "goldAt",
      "budget",
    ])
      v[k] = Math.round(Number(v[k]) * 100);
    for (const k of ["silverDiscount", "goldDiscount", "inactiveDays"])
      v[k] = Number(v[k]);
    await send("/settings", v, "PUT");
    toast.success("Configuración guardada");
    await reload();
  }
  async function importCSV(commit: boolean) {
    setBusy(true);
    try {
      const r = await send<ImportResult>("/import", { kind, csv, commit });
      setResult(r);
      if (commit) {
        toast.success(`${r.count} registros importados`);
        setCsv("");
        await reload();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function template() {
    const content =
      kind === "products"
        ? "name,strain,type,unit,lot,supplier,stock,minimum,cost,price,location,ownerId,expires,sourceSystem,sourceId\nLemon Haze,Sativa,Flor,g,LOTE-EJEMPLO,Proveedor ejemplo,100,20,4.50,12.00,Almacén A," +
          (state.users.find((u) => u.role === "responsible")?.id || user.id) +
          ",,appsheet,lote-ejemplo-001\n"
        : kind === "customers"
          ? "name,email,phone,notes,sourceSystem,sourceId\nSocio ejemplo,socio@example.com,+54000000000,,appsheet,socio-ejemplo-001\n"
          : `date,account,category,amount,description,sourceSystem,sourceId\n${state.today},bank,delivery_receipt,1000.00,Cobro delivery ejemplo,appsheet,cobro-ejemplo-001\n`;
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `plantilla-${kind}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  return (
    <>
      <PageHeader
        eyebrow="A LA MEDIDA DE TU CLUB"
        title="Configuración"
        description="Reglas de fidelidad, equipo y migración de tus datos."
      />
      <div className="settings-tabs">
        <button
          className={tab === "general" ? "active" : ""}
          onClick={() => setTab("general")}
        >
          <GearSix />
          General y fidelización
        </button>
        <button
          className={tab === "team" ? "active" : ""}
          onClick={() => setTab("team")}
        >
          <ShieldCheck />
          Equipo y permisos
        </button>
        {isManager && (
          <button
            className={tab === "import" ? "active" : ""}
            onClick={() => setTab("import")}
          >
            <UploadSimple />
            Importar desde Sheets
          </button>
        )}
      </div>
      {tab === "general" && (
        <Panel
          title="Configuración del club"
          sub={
            isManager
              ? "Los cambios se aplican a las operaciones futuras."
              : "Tu rol puede consultar esta configuración."
          }
        >
          <div className="settings-form">
            <Form onSubmit={save}>
              <fieldset disabled={!isManager}>
                <h3>Datos generales</h3>
                <div className="form-grid">
                  <Field label="Nombre del club">
                    <input
                      name="clubName"
                      defaultValue={state.settings.clubName}
                      required
                    />
                  </Field>
                  <Field
                    label="Moneda"
                    hint="Con ventas registradas, cambiar moneda requiere migrar los importes."
                  >
                    <select
                      name="currency"
                      defaultValue={state.settings.currency}
                    >
                      <option value="ARS">Peso argentino (ARS)</option>
                      <option value="EUR">Euro (EUR)</option>
                      <option value="USD">Dólar (USD)</option>
                    </select>
                  </Field>
                  <Field label="Zona horaria">
                    <select
                      name="timezone"
                      defaultValue={state.settings.timezone}
                    >
                      <option value="Europe/Madrid">España · Madrid</option>
                      <option value="America/Argentina/Buenos_Aires">
                        Argentina · Buenos Aires
                      </option>
                      <option value="America/Montevideo">
                        Uruguay · Montevideo
                      </option>
                      <option value="UTC">UTC</option>
                    </select>
                  </Field>
                  <Field label="Presupuesto mensual">
                    <input
                      name="budget"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={state.settings.budget / 100}
                      required
                    />
                  </Field>
                </div>
                <h3>Programa de fidelización</h3>
                <div className="form-grid">
                  <Field label="Importe para ganar 1 punto">
                    <input
                      name="pointsEvery"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={state.settings.pointsEvery / 100}
                      required
                    />
                  </Field>
                  <Field label="Valor de canje de 1 punto">
                    <input
                      name="pointValue"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={state.settings.pointValue / 100}
                      required
                    />
                  </Field>
                  <Field label="Gasto acumulado para nivel Plata">
                    <input
                      name="silverAt"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={state.settings.silverAt / 100}
                      required
                    />
                  </Field>
                  <Field label="Descuento Plata (%)">
                    <input
                      name="silverDiscount"
                      type="number"
                      min="0"
                      max="50"
                      step="0.1"
                      defaultValue={state.settings.silverDiscount}
                      required
                    />
                  </Field>
                  <Field label="Gasto acumulado para nivel Oro">
                    <input
                      name="goldAt"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={state.settings.goldAt / 100}
                      required
                    />
                  </Field>
                  <Field label="Descuento Oro (%)">
                    <input
                      name="goldDiscount"
                      type="number"
                      min="0"
                      max="50"
                      step="0.1"
                      defaultValue={state.settings.goldDiscount}
                      required
                    />
                  </Field>
                  <Field label="Inactividad a partir de (días)">
                    <input
                      name="inactiveDays"
                      type="number"
                      min="7"
                      max="365"
                      defaultValue={state.settings.inactiveDays}
                      required
                    />
                  </Field>
                </div>
              </fieldset>
              {!isManager && (
                <p className="note-box">
                  Solo el dueño y los gerentes pueden modificar estas reglas.
                </p>
              )}
            </Form>
          </div>
        </Panel>
      )}
      {tab === "team" && (
        <Panel
          title="Equipo del club"
          sub="Los permisos se validan en cada operación de la API."
          action={
            user.role === "owner" && (
              <button
                className="button primary"
                onClick={() => setAddUser(true)}
              >
                <Plus />
                Agregar usuario
              </button>
            )
          }
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Miembro</th>
                  <th>Rol</th>
                  <th>Acceso</th>
                </tr>
              </thead>
              <tbody>
                {state.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="person-cell">
                        <Avatar name={u.name} color={u.color} />
                        <div>
                          <strong>{u.name}</strong>
                          <small>{u.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone="gray">{roleLabels[u.role]}</Badge>
                    </td>
                    <td>
                      {
                        {
                          owner: "Control total y creación de usuarios",
                          admin: "Operación global y configuración",
                          responsible: "Stock, ventas y gastos propios",
                          cashier: "Ventas, socios y cierre de caja",
                          viewer: "Consulta y reportes sin edición",
                        }[u.role]
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {tab === "import" && isManager && (
        <Panel
          title="De tu planilla a tu club"
          sub="Exportá Google Sheets como CSV. Validá el archivo antes de confirmar la importación."
        >
          <div className="import-content">
            <div className="import-steps">
              <span>
                <i>1</i>Descargá la plantilla
              </span>
              <span>
                <i>2</i>Copiá tus datos
              </span>
              <span>
                <i>3</i>Validá e importá
              </span>
            </div>
            <div className="form-grid">
              <Field label="Datos a importar">
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setResult(null);
                    setCsv("");
                  }}
                >
                  <option value="products">Productos y lotes</option>
                  <option value="customers">Socios</option>
                  <option value="cash_entries">Movimientos de caja y banco</option>
                </select>
              </Field>
              <div className="template-button">
                <button className="button" onClick={template}>
                  <DownloadSimple />
                  Descargar plantilla CSV
                </button>
              </div>
            </div>
            <p className="muted small">
              Importes en moneda principal, cantidades en gramos o unidades.
              Separador coma o punto y coma. Hasta 2.000 filas. Los lotes
              existentes con el mismo origen se omiten; los datos conflictivos se rechazan para conciliación. Los cobros del delivery importados no descuentan stock ni crean ventas locales.
              No importes diagnósticos ni documentos de salud de socios.
            </p>
            <label className="upload-zone">
              <UploadSimple size={32} />
              <strong>Seleccioná tu archivo CSV</strong>
              <span>Exportado desde Google Sheets o Excel</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setCsv(await file.text());
                    setResult(null);
                  }
                }}
              />
            </label>
            {csv && (
              <>
                <p className="small muted">
                  Archivo cargado · {numberOfRows(csv)} filas aproximadas
                </p>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void importCSV(false)}
                >
                  Validar archivo
                </button>
              </>
            )}
            {result && (
              <div className="import-result">
                <h3>
                  {result.committed ? (
                    <>
                      <CheckCircle /> Importación completada
                    </>
                  ) : (
                    `${result.count} registros válidos`
                  )}
                </h3>
                <p className="muted small">{result.skipped} registros ya presentes, sin duplicar.</p>
                {result.errors.length > 0 ? (
                  <div className="form-error">
                    {result.errors.slice(0, 20).map((e, i) => (
                      <p key={i}>{e}</p>
                    ))}
                    {result.errors.length > 20 && (
                      <p>Y {result.errors.length - 20} errores más.</p>
                    )}
                  </div>
                ) : (
                  !result.committed && (
                    <>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Nombre</th>
                              <th>Vista previa</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.preview.map((r, i) => (
                              <tr key={i}>
                                <td>{String(r.name || r.description || "")}</td>
                                <td>{String(r.lot || r.email || `${r.sourceSystem || ""} · ${r.sourceId || ""}`)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button
                        className="button primary"
                        disabled={busy || !result.count}
                        onClick={() => void importCSV(true)}
                      >
                        Confirmar {result.count} registros
                      </button>
                    </>
                  )
                )}
              </div>
            )}
          </div>
        </Panel>
      )}
      <Modal
        title="Agregar miembro al equipo"
        description="Compartí las credenciales de forma privada. La contraseña requiere al menos 12 caracteres."
        open={addUser}
        onClose={() => setAddUser(false)}
      >
        <Form
          onCancel={() => setAddUser(false)}
          onSubmit={async (fd) => {
            await send("/users", Object.fromEntries(fd));
            toast.success("Usuario creado");
            setAddUser(false);
            await reload();
          }}
        >
          <Field label="Nombre completo">
            <input name="name" required minLength={2} />
          </Field>
          <Field label="Email">
            <input name="email" type="email" required />
          </Field>
          <Field label="Contraseña">
            <input
              name="password"
              type="password"
              minLength={12}
              maxLength={72}
              required
              autoComplete="new-password"
            />
          </Field>
          <Field label="Rol">
            <select name="role">
              <option value="responsible">Responsable de stock</option>
              <option value="admin">Gerente</option>
              <option value="cashier">Cajero</option>
              <option value="viewer">Solo lectura</option>
            </select>
          </Field>
        </Form>
      </Modal>
    </>
  );
}
function numberOfRows(csv: string) {
  return Math.max(0, csv.trim().split("\n").length - 1);
}

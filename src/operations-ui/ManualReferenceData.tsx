import { useEffect, useState } from "react";
import { apiGet, hasCapability } from "./api";
import { ActionButton, DataTable, EmptyState, ErrorState, InfoBand, LoadingState, SectionHeading, StatusTag } from "./Primitives";
import type { ActionField, CommandAction, JsonRecord, OperationsContext } from "./types";
import "./ManualReferenceData.css";

interface SupplierReference {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  notes: string;
  active: boolean;
  isDefault: boolean;
}

interface LocationReference {
  id: string;
  name: string;
  active: boolean;
  isDefault: boolean;
}

interface ReferenceResponse {
  suppliers: SupplierReference[];
  locations: LocationReference[];
  versions: Record<string, number>;
  editable?: { suppliers?: boolean; locations?: boolean };
}

interface Props {
  context: OperationsContext;
  refreshKey: number;
  openAction: (action: CommandAction) => void;
  onNotice: (message: string) => void;
}

const textField = (name: string, label: string, extra: Partial<ActionField> = {}): ActionField => ({ name, label, type: "text", ...extra });
const areaField = (name: string, label: string, extra: Partial<ActionField> = {}): ActionField => ({ name, label, type: "textarea", ...extra });
const checkField = (name: string, label: string, defaultValue = false): ActionField => ({ name, label, type: "checkbox", defaultValue });
const evidenceField: ActionField = { name: "evidence", label: "Motivo o evidencia del cambio", type: "textarea", required: true, help: "Queda registrado con la acción." };
const value = (values: Record<string, string | boolean>, key: string) => typeof values[key] === "string" ? String(values[key]).trim() : "";
const checked = (values: Record<string, string | boolean>, key: string) => values[key] === true;

function supplierAction(row: SupplierReference | null, version: number, openAction: Props["openAction"]) {
  const create = row === null;
  const fields: ActionField[] = [
    textField("name", "Nombre del proveedor", { required: true, defaultValue: row?.name ?? "" }),
    textField("contactName", "Persona de contacto", { defaultValue: row?.contactName ?? "" }),
    textField("phone", "Teléfono", { type: "tel", defaultValue: row?.phone ?? "" }),
    textField("email", "Correo electrónico", { type: "email", defaultValue: row?.email ?? "" }),
    areaField("notes", "Notas", { defaultValue: row?.notes ?? "" }),
    checkField("isDefault", "Proveedor predeterminado", row?.isDefault ?? false),
    ...(!create ? [checkField("active", "Activo", row.active)] : []),
    evidenceField,
  ];
  const toData = (form: Record<string, string | boolean>): JsonRecord => ({
    name: value(form, "name"),
    contactName: value(form, "contactName"),
    phone: value(form, "phone"),
    email: value(form, "email"),
    notes: value(form, "notes"),
    isDefault: create || checked(form, "active") ? checked(form, "isDefault") : false,
    ...(create ? {} : { active: checked(form, "active") }),
    evidence: { note: value(form, "evidence") },
  });
  openAction({
    command: create ? "SupplierCreated" : "SupplierUpdated",
    title: create ? "Crear proveedor" : "Editar proveedor",
    description: "Los cambios requieren motivo y quedan versionados. Dar de baja no borra compras existentes.",
    fields,
    toData,
    ...(row ? { targetId: row.id, expectedVersion: version } : { targetId: crypto.randomUUID(), expectedVersion: 0, requestIdIsTarget: true }),
    submitLabel: create ? "Crear proveedor" : "Guardar cambios",
  });
}

function locationAction(row: LocationReference | null, version: number, openAction: Props["openAction"]) {
  const create = row === null;
  const fields: ActionField[] = [
    textField("name", "Nombre de la ubicación", { required: true, defaultValue: row?.name ?? "" }),
    checkField("isDefault", "Ubicación predeterminada", row?.isDefault ?? false),
    ...(!create ? [checkField("active", "Activa", row.active)] : []),
    evidenceField,
  ];
  const toData = (form: Record<string, string | boolean>): JsonRecord => ({
    name: value(form, "name"),
    isDefault: create || checked(form, "active") ? checked(form, "isDefault") : false,
    ...(create ? {} : { active: checked(form, "active") }),
    evidence: { note: value(form, "evidence") },
  });
  openAction({
    command: create ? "LocationCreated" : "LocationUpdated",
    title: create ? "Crear ubicación" : "Editar ubicación",
    description: "Cambiar el nombre actualiza las etiquetas de productos asociados; dar de baja no altera saldos ni movimientos.",
    fields,
    toData,
    ...(row ? { targetId: row.id, expectedVersion: version } : { targetId: crypto.randomUUID(), expectedVersion: 0, requestIdIsTarget: true }),
    submitLabel: create ? "Crear ubicación" : "Guardar cambios",
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "No se pudieron consultar las referencias.";
}

export function ManualReferenceData({ context, refreshKey, openAction }: Props) {
  const canSuppliers = hasCapability(context, "purchases.write");
  const canLocations = hasCapability(context, "stock.adjust");
  const [references, setReferences] = useState<ReferenceResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let current = true;
    if (!canSuppliers && !canLocations) {
      setReferences(null);
      setError("Tu perfil no tiene permiso para administrar proveedores o ubicaciones.");
      setLoading(false);
      return () => { current = false; };
    }
    setLoading(true);
    setError("");
    apiGet<ReferenceResponse>("/api/operations/manual-reference-data").then(result => {
      if (current) setReferences(result);
    }).catch(failure => {
      if (current) setError(errorText(failure));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [canLocations, canSuppliers, refreshKey, retryKey]);

  if (loading) return <LoadingState label="Cargando proveedores y ubicaciones…" />;
  if (error) return <ErrorState message={error} retry={() => setRetryKey(value => value + 1)} />;

  const suppliers = canSuppliers ? references?.suppliers ?? [] : [];
  const locations = canLocations ? references?.locations ?? [] : [];
  const supplierEditable = Boolean(references?.editable?.suppliers);
  const locationEditable = Boolean(references?.editable?.locations);
  const versions = references?.versions ?? {};

  return <section className="manual-reference" aria-label="Proveedores y ubicaciones">
    <SectionHeading eyebrow="Referencias de compras y stock" title="Proveedores y ubicaciones" detail="Mantené los datos que usan compras y aperturas de stock. Las bajas son reversibles y conservan el historial." />
    {(canSuppliers && !supplierEditable || canLocations && !locationEditable) && <InfoBand tone="warning" title="Vista de solo lectura">Tu alcance actual permite consultar estos registros, pero la administración global requiere alcance operativo completo.</InfoBand>}

    {canSuppliers && <section className="manual-reference-group" aria-label="Proveedores">
      <SectionHeading eyebrow="Compras" title="Proveedores" detail="Los proveedores inactivos quedan disponibles para revisar sus compras anteriores." action={supplierEditable ? <ActionButton onClick={() => supplierAction(null, 0, openAction)}>Nuevo proveedor</ActionButton> : undefined} />
      {suppliers.length === 0 ? <EmptyState title="Todavía no hay proveedores" detail="Creá un proveedor para habilitar su selección en compras." action={supplierEditable ? <ActionButton onClick={() => supplierAction(null, 0, openAction)}>Crear proveedor</ActionButton> : undefined} /> : <DataTable label="Proveedores registrados">
        <thead><tr><th scope="col">Proveedor</th><th scope="col">Contacto</th><th scope="col">Correo</th><th scope="col">Estado</th><th scope="col">Uso</th><th scope="col">Acciones</th></tr></thead>
        <tbody>{suppliers.map(row => <tr key={row.id}>
          <th scope="row"><span>{row.name}</span>{row.isDefault && <StatusTag tone="olive">Predeterminado</StatusTag>}</th>
          <td>{row.contactName || "—"}{row.phone && <small>{row.phone}</small>}</td>
          <td>{row.email || "—"}</td>
          <td><StatusTag tone={row.active ? "good" : "neutral"}>{row.active ? "Activo" : "Inactivo"}</StatusTag></td>
          <td>{row.isDefault ? "Compras nuevas" : "Disponible en el catálogo"}</td>
          <td>{supplierEditable ? <ActionButton quiet onClick={() => supplierAction(row, versions[row.id] ?? 0, openAction)}>Editar</ActionButton> : "—"}</td>
        </tr>)}</tbody>
      </DataTable>}
    </section>}

    {canLocations && <section className="manual-reference-group" aria-label="Ubicaciones">
      <SectionHeading eyebrow="Stock" title="Ubicaciones" detail="Cambiar un nombre actualiza las etiquetas vinculadas. Desactivar una ubicación no corrige ni mueve saldos." action={locationEditable ? <ActionButton onClick={() => locationAction(null, 0, openAction)}>Nueva ubicación</ActionButton> : undefined} />
      {locations.length === 0 ? <EmptyState title="Todavía no hay ubicaciones" detail="Creá una ubicación para poder recibir compras o preparar una apertura de stock." action={locationEditable ? <ActionButton onClick={() => locationAction(null, 0, openAction)}>Crear ubicación</ActionButton> : undefined} /> : <DataTable label="Ubicaciones registradas">
        <thead><tr><th scope="col">Ubicación</th><th scope="col">Estado</th><th scope="col">Uso</th><th scope="col">Acciones</th></tr></thead>
        <tbody>{locations.map(row => <tr key={row.id}>
          <th scope="row"><span>{row.name}</span>{row.isDefault && <StatusTag tone="olive">Predeterminada</StatusTag>}</th>
          <td><StatusTag tone={row.active ? "good" : "neutral"}>{row.active ? "Activa" : "Inactiva"}</StatusTag></td>
          <td>{row.isDefault ? "Ubicación nueva" : "Disponible en el catálogo"}</td>
          <td>{locationEditable ? <ActionButton quiet onClick={() => locationAction(row, versions[row.id] ?? 0, openAction)}>Editar</ActionButton> : "—"}</td>
        </tr>)}</tbody>
      </DataTable>}
    </section>}
  </section>;
}

import {
  Leaf,
  Drop,
  Flask,
  Package,
  MapPin,
  CalendarBlank,
  PencilSimple,
  ArrowsLeftRight,
  WarningCircle,
  Truck,
  CheckCircle,
} from "@phosphor-icons/react";
import { useClub, number, shortDate, type Product } from "./lib";
import { Avatar, Badge } from "./ui";
import {
  MinimalCard,
  MinimalCardTitle,
  Expandable,
  ExpandableTrigger,
  ExpandableContent,
} from "./components/cult/cards";

export function StockCard({
  product: p,
  onEdit,
  onMove,
}: {
  product: Product;
  onEdit: () => void;
  onMove: () => void;
}) {
  const { state, money, canManage, user } = useClub();
  const responsible = state.users.find((u) => u.id === p.ownerId);
  const expired = !!p.expires && p.expires <= state.today;
  const low = p.stock <= p.minimum;
  const soon =
    !!p.expires &&
    !expired &&
    p.expires <=
      new Date(new Date(`${state.today}T12:00:00Z`).getTime() + 30 * 86400000)
        .toISOString()
        .slice(0, 10);
  const Icon =
    p.type === "Flor"
      ? Leaf
      : p.type === "Aceite"
        ? Drop
        : p.type === "Extracto"
          ? Flask
          : Package;
  // The marker is the minimum; the track spans actual stock plus minimum.
  const scale = Math.max(p.stock + p.minimum, 1);
  return (
    <MinimalCard
      className={`stock-card ${expired ? "is-expired" : low ? "is-low" : ""}`}
    >
      <Expandable>
        <div className={`stock-art stock-art-${p.type.toLowerCase()}`}>
          <span className="stock-type">
            <Icon size={15} />
            {p.type}
          </span>
          <Icon
            className="stock-art-icon"
            size={86}
            weight="duotone"
            aria-hidden="true"
          />
          <span className="stock-lot">{p.lot}</span>
          <Badge tone={expired ? "red" : low || soon ? "amber" : "green"}>
            {expired || low || soon ? (
              <WarningCircle size={12} />
            ) : (
              <CheckCircle size={12} />
            )}
            {expired
              ? "Vencido"
              : low
                ? "Stock bajo"
                : soon
                  ? "Vence pronto"
                  : "Disponible"}
          </Badge>
        </div>
        <div className="stock-card-body">
          <div className="stock-name">
            <MinimalCardTitle>{p.name}</MinimalCardTitle>
            <span>{p.strain}</span>
          </div>
          <div className="stock-quantity-row">
            <div>
              <small>STOCK ACTUAL</small>
              <strong>
                {number(p.stock / 1000)} <span>{p.unit}</span>
              </strong>
            </div>
            <div className="stock-price">
              <strong>{money(p.price)}</strong>
              <small>por {p.unit} · ARS</small>
            </div>
          </div>
          <div className="stock-level" aria-hidden="true">
            <i style={{ width: `${(p.stock / scale) * 100}%` }} />
            <b
              style={{ left: `${Math.min(98, (p.minimum / scale) * 100)}%` }}
            />
          </div>
          <div className="stock-minimum">
            <span>
              Mínimo: {number(p.minimum / 1000)} {p.unit}
            </span>
            <span>{low ? "Reponer stock" : "Sobre el mínimo"}</span>
          </div>
          <div className="stock-owner">
            <Avatar
              name={responsible?.name || "?"}
              color={responsible?.color}
              size={32}
            />
            <div>
              <small>RESPONSABLE DE REPROGRAM</small>
              <strong>{responsible?.name || p.ownerId}</strong>
            </div>
          </div>
          <div className="stock-card-actions">
            <ExpandableTrigger label={p.name} />
            {canManage && (
              <button
                className="button small-button"
                aria-label={`Mover ${p.name}`}
                onClick={onMove}
              >
                <ArrowsLeftRight size={16} />
                Movimiento
              </button>
            )}
          </div>
          <ExpandableContent>
            <div className="stock-details">
              <span>
                <MapPin size={16} />
                {p.location}
              </span>
              <span><Truck size={16} />{p.supplier || "Sin proveedor"}</span>
              <span>
                <CalendarBlank size={16} />
                {p.expires
                  ? `Vence ${shortDate(p.expires)}`
                  : "Sin vencimiento registrado"}
              </span>
              {user.role !== "cashier" && (
                <dl>
                  <div>
                    <dt>Costo por {p.unit}</dt>
                    <dd>{money(p.cost)}</dd>
                  </div>
                  <div>
                    <dt>Valor del lote al costo</dt>
                    <dd>{money((p.cost * p.stock) / 1000)}</dd>
                  </div>
                </dl>
              )}
              {canManage && (
                <button className="button full-width" onClick={onEdit}>
                  <PencilSimple size={16} />
                  Editar {p.name}
                </button>
              )}
            </div>
          </ExpandableContent>
        </div>
      </Expandable>
    </MinimalCard>
  );
}

// Adapted from Cult UI's Minimal Card and Expandable (MIT).
// Source and full license: THIRD_PARTY_NOTICES.md.
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { CaretDown } from "@phosphor-icons/react";

export const MinimalCard = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className = "", ...props }, ref) => (
  <div ref={ref} className={`minimal-card ${className}`} {...props} />
));
MinimalCard.displayName = "MinimalCard";
export const MinimalCardTitle = forwardRef<
  HTMLHeadingElement,
  HTMLAttributes<HTMLHeadingElement>
>(({ className = "", ...props }, ref) => (
  <h3 ref={ref} className={`minimal-card-title ${className}`} {...props} />
));
MinimalCardTitle.displayName = "MinimalCardTitle";

const ExpandableContext = createContext<{
  isExpanded: boolean;
  toggleExpand: () => void;
  id: string;
} | null>(null);
function useExpandable() {
  const value = useContext(ExpandableContext);
  if (!value)
    throw new Error("Expandable components require an Expandable parent");
  return value;
}
export function Expandable({ children }: { children: ReactNode }) {
  const [isExpanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <ExpandableContext.Provider
      value={{ isExpanded, toggleExpand: () => setExpanded((v) => !v), id }}
    >
      {children}
    </ExpandableContext.Provider>
  );
}
export function ExpandableTrigger({ label }: { label: string }) {
  const { isExpanded, toggleExpand, id } = useExpandable();
  return (
    <button
      type="button"
      className="stock-expand"
      id={`${id}-trigger`}
      aria-label={`${isExpanded ? "Ocultar" : "Ver"} detalle de ${label}`}
      aria-expanded={isExpanded}
      aria-controls={id}
      onClick={toggleExpand}
    >
      {isExpanded ? "Menos detalle" : "Ver detalle"}
      <CaretDown
        size={15}
        style={{ transform: isExpanded ? "rotate(180deg)" : undefined }}
      />
    </button>
  );
}
export function ExpandableContent({ children }: { children: ReactNode }) {
  const { isExpanded, id } = useExpandable();
  return (
    <div id={id} role="region" aria-labelledby={`${id}-trigger`}>
      {isExpanded && <div className="expandable-body">{children}</div>}
    </div>
  );
}

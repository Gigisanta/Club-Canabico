export type Role = "owner" | "admin" | "responsible" | "cashier" | "viewer";
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  color: string;
}
export interface Settings {
  clubName: string;
  sampleData?: boolean;
  currency: string;
  timezone: string;
  pointsEvery: number;
  pointValue: number;
  silverAt: number;
  goldAt: number;
  silverDiscount: number;
  goldDiscount: number;
  inactiveDays: number;
  budget: number;
  /** Daily local sales goal in cents; 0 means no goal. */
  dailySalesGoal: number;
}
export interface Product {
  id: string;
  name: string;
  strain: string;
  type: string;
  unit: string;
  lot: string;
  supplier: string;
  supplierId: string | null;
  sourceSystem: string | null;
  sourceId: string | null;
  stock: number;
  minimum: number;
  cost: number;
  price: number;
  location: string;
  locationId: string | null;
  categoryId: string | null;
  /** Category name, present in the paged product list. */
  category?: string | null;
  ownerId: string;
  expires: string | null;
  createdAt: string;
}
export interface Supplier {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  notes: string;
  active: boolean;
  isDefault: boolean;
  lotCount: number;
}
export interface Location {
  id: string;
  name: string;
  active: boolean;
  isDefault: boolean;
  lotCount: number;
}
/** Commercial category. Coverage fields are absent for a responsible. */
export interface ProductCategory {
  id: string;
  name: string;
  active: boolean;
  minVarieties?: number;
  lotCount?: number;
  varieties?: number;
  varietyNames?: string[];
  /** Stock that can still be sold today, per unit, in milliunits. */
  stock?: { unit: string; milliunits: number }[];
}
export interface CategoryAlert {
  id: string;
  name: string;
  minVarieties: number;
  varieties: number;
}
export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  points: number;
  permitStatus: "unverified" | "pending" | "verified" | "expired";
  permitValidUntil: string | null;
  permitCheckedAt: string | null;
  sourceSystem: string | null;
  sourceId: string | null;
  createdAt: string;
  totalSpent: number;
  purchases: number;
  lastPurchase: string | null;
  tier: string;
}
export interface SaleItem {
  id: string;
  productId: string;
  ownerId: string;
  name: string;
  unit: string;
  quantity: number;
  price: number;
  cost: number;
  revenue: number;
}
export interface Sale {
  id: string;
  customerId: string;
  userId: string;
  date: string;
  createdAt: string;
  subtotal: number;
  discount: number;
  total: number;
  cost: number;
  pointsEarned: number;
  pointsUsed: number;
  payment: string;
  /** Only for payment "mixed": the cash part first, then the transfer or card part, in cents. */
  paymentSplit?: PaymentPart[] | null;
  channel: string;
  items: SaleItem[];
  customerName?: string;
}
export interface PaymentPart {
  method: "cash" | "transfer" | "card";
  amount: number;
}
export interface Expense {
  id: string;
  name: string;
  amount: number;
  category: string;
  kind: string;
  ownerId: string | null;
  date: string;
  recurrence: string;
}
export interface Movement {
  id: string;
  productId: string;
  type: string;
  quantity: number;
  beforeStock: number;
  afterStock: number;
  fromOwner: string | null;
  toOwner: string | null;
  userId: string;
  note: string;
  createdAt: string;
  product?: { name: string };
}
export interface Closure {
  id: string;
  date: string;
  expected: number;
  counted: number;
  difference: number;
  note: string;
}
export interface CashEntry {
  id: string;
  date: string;
  account: "cash" | "bank";
  category: string;
  amount: number;
  description: string;
  sourceSystem: string | null;
  sourceId: string | null;
  /** Account balance right after this movement, by date and entry order; not reconciled. */
  balanceAfter?: number;
}
export interface CashLedgerSummary {
  pageCount: number;
  inflow: number;
  outflow: number;
  net: number;
  cashBalance: number;
  cashCount: number;
  bankBalance: number;
  bankCount: number;
}
export interface CashPlan {
  id: string;
  date: string;
  scenario: "base" | "cautious" | "growth";
  account: "cash" | "bank";
  category: string;
  amount: number;
  description: string;
}
export interface ClubState {
  user: User;
  users: User[];
  products: Product[];
  closures: Closure[];
  cashPlans: CashPlan[];
  financeBalance: number;
  periodRevenue: number;
  periodCost: number;
  periodExpense: number;
  responsibleRows: { ownerId: string; productId: string; name: string; revenue: number; cost: number }[];
  cashExpected: number;
  salesTodayTotal: number;
  salesTodayCount: number;
  lowStockCount: number;
  lowStockAlerts: Pick<Product, "id" | "name" | "stock" | "minimum" | "unit">[];
  categoryAlerts: CategoryAlert[];
  operationsEnabled: boolean;
  settings: Settings;
  today: string;
  demo: boolean;
}
export interface Page<T, S = Record<string, number | string>> {
  items: T[];
  total: number;
  nextCursor: string | null;
  summary: S;
}
export const roleLabels: Record<Role, string> = {
  owner: "Dueño",
  admin: "Gerente",
  responsible: "Responsable",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

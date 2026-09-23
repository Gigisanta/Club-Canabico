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
}
export interface Product {
  id: string;
  name: string;
  strain: string;
  type: string;
  unit: string;
  lot: string;
  supplier: string;
  sourceSystem: string | null;
  sourceId: string | null;
  stock: number;
  minimum: number;
  cost: number;
  price: number;
  location: string;
  ownerId: string;
  expires: string | null;
  createdAt: string;
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
  channel: string;
  items: SaleItem[];
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
  customers: Customer[];
  sales: Sale[];
  expenses: Expense[];
  movements: Movement[];
  closures: Closure[];
  cashEntries: CashEntry[];
  cashPlans: CashPlan[];
  financeBalance: number;
  cashExpected: number;
  operationsEnabled: boolean;
  settings: Settings;
  today: string;
  demo: boolean;
}
export const roleLabels: Record<Role, string> = {
  owner: "Dueño",
  admin: "Gerente",
  responsible: "Responsable",
  cashier: "Cajero",
  viewer: "Solo lectura",
};

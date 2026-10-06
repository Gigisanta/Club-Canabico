import type { OperationAccess, User } from "@prisma/client";
import { profileCapabilities, type Capability } from "../../shared/operations/contracts.js";

type AccessSubject = Pick<User, "id" | "role">;
type CapabilityGrant = Pick<OperationAccess, "enabled" | "capabilities"> | null;

export function capabilitiesFromGrant(
  user: Pick<AccessSubject, "role">,
  grant: CapabilityGrant,
): Capability[] {
  if (grant) return grant.enabled && Array.isArray(grant.capabilities) ? grant.capabilities as Capability[] : [];
  // Legacy admin alone never grants clinical access or financial approval in the new circuit.
  return profileCapabilities[user.role === "owner" ? "owner" : user.role === "cashier" ? "cashier" : user.role === "admin" ? "commercial" : "viewer"];
}

export function buildOperationAccessSnapshot(user: AccessSubject, grant: OperationAccess | null) {
  return {
    profile: grant?.profile ?? user.role,
    isOwner: user.role === "owner",
    capabilities: capabilitiesFromGrant(user, grant),
  };
}

import type { OperationAccess, User } from "@prisma/client";
import { profileCapabilities, type Capability } from "../../shared/operations/contracts.js";

type AccessSubject = Pick<User, "id" | "role">;
type CapabilityGrant = Pick<OperationAccess, "enabled" | "capabilities"> | null;
type DecisionInputGrant = Pick<OperationAccess, "enabled" | "profile" | "scope"> | null;

export function canManageDecisionInputAttestations(
  user: Pick<AccessSubject, "role">,
  grant: DecisionInputGrant,
): boolean {
  if (user.role !== "owner" && user.role !== "admin") return false;
  if (!grant) return true;
  if (!grant.enabled || grant.profile === "clinical" || grant.profile === "driver") return false;

  const scope = grant.scope;
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false;
  return Object.keys(scope).length === 0;
}

export function capabilitiesFromGrant(
  user: Pick<AccessSubject, "role">,
  grant: CapabilityGrant,
): Capability[] {
  if (grant) return grant.enabled && Array.isArray(grant.capabilities) ? grant.capabilities as Capability[] : [];
  // Legacy admin alone never grants clinical access or financial approval in the new circuit.
  return profileCapabilities[user.role === "owner" ? "owner" : user.role === "cashier" ? "cashier" : user.role === "admin" ? "commercial" : "viewer"];
}

export function buildOperationAccessSnapshot(
  user: AccessSubject,
  grant: OperationAccess | null,
  authority?: { cutoverProfile?: unknown } | null,
) {
  return {
    profile: grant?.profile ?? user.role,
    isOwner: user.role === "owner",
    cutoverProfile: authority?.cutoverProfile === "appsheet-replacement" ? "appsheet-replacement" as const : "legacy" as const,
    canManageDecisionInputs: canManageDecisionInputAttestations(user, grant),
    capabilities: capabilitiesFromGrant(user, grant),
  };
}

import { TRPCError } from "@trpc/server";
import { getWorkspaceForUser, getWorkspaceRole } from "../db";
import type { CreatorSpendHook } from "./orchestrator";
import {
  estimateCreatorCost,
  isAuthorizedForPaidKind,
  readCreatorPaidAllowlists,
  readCreatorPaidConfig,
  type CreatorPaidConfig,
  type CreatorPaidKind,
} from "./paidPolicy";
import { creatorHoldId, getCreatorSpendLedger } from "./spendLedger";

export type CreatorActor = { id: number; openId?: string | null; role?: string | null };

/** Workspace owner check that fails closed (no membership row, or database unavailable => denied). */
export async function requireCreatorWorkspaceOwner(userId: number, workspaceId: number): Promise<void> {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
  const role = await getWorkspaceRole(userId, workspaceId).catch(() => undefined);
  if (role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
}

/**
 * Gate for every operation that can create or continue paid provider work.
 * Order (cheapest and most restrictive first, all before readiness probes, storage or provider):
 * feature switch → workspace membership + owner role → kind-specific authorization → spend policy completeness
 * (authorization precedes policy validation so unauthorized callers learn nothing about the policy state).
 */
export async function requirePaidCreatorAccess(user: CreatorActor, workspaceId: number, kind: CreatorPaidKind): Promise<CreatorPaidConfig> {
  const result = readCreatorPaidConfig();
  if (!result.ok && result.code === "CREATOR_PAID_GENERATION_DISABLED") {
    throw new TRPCError({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_DISABLED" });
  }
  await requireCreatorWorkspaceOwner(user.id, workspaceId);
  if (!isAuthorizedForPaidKind(user, kind, result.ok ? result.config : readCreatorPaidAllowlists())) {
    throw new TRPCError({ code: "FORBIDDEN", message: `CREATOR_PAID_GENERATION_NOT_AUTHORIZED:${kind}` });
  }
  if (!result.ok) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `CREATOR_SPEND_POLICY_INVALID:${result.detail}` });
  }
  return result.config;
}

/**
 * Builds the orchestrator's spend hook: prices the resolved model server-side and atomically reserves the
 * global / workspace / user budgets BEFORE the provider is invoked. Settlement failures never throw away a provider
 * result; an unsettled hold stays HELD and counted (conservative).
 */
export function createCreatorSpendHook(input: {
  user: CreatorActor;
  workspaceId: number;
  idempotencyKey: string;
  config: CreatorPaidConfig;
}): CreatorSpendHook {
  const ledger = getCreatorSpendLedger();
  const holdId = creatorHoldId(input.workspaceId, input.idempotencyKey);
  const priced = (model: string, request: Parameters<CreatorSpendHook["price"]>[0]["request"]) => {
    const cost = estimateCreatorCost(input.config, model, request);
    if (cost === undefined) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `CREATOR_MODEL_NOT_PRICED:${model}` });
    return cost;
  };
  return {
    price({ model, request }) {
      priced(model, request);
    },
    async reserve({ kind, model, request }) {
      const cost = priced(model, request);
      let result;
      try {
        result = await ledger.reserve({ holdId, workspaceId: input.workspaceId, userId: input.user.id, kind, model, cost, limits: input.config.limits });
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "CREATOR_SPEND_LEDGER_UNAVAILABLE" });
      }
      if (!result.ok) {
        const scope = result.reason.replace(/_exhausted$/, "");
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `CREATOR_BUDGET_EXHAUSTED:${scope}` });
      }
      return { created: result.created };
    },
    commit: generationId => ledger.commit(holdId, generationId).then(() => undefined, () => undefined),
    release: () => ledger.release(holdId).then(() => undefined, () => undefined),
    markUnknown: generationId => ledger.recordUnknown(holdId, generationId).catch(() => undefined),
  };
}

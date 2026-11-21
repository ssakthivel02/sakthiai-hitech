import { TRPCError } from "@trpc/server";
import { verifyCreatorRuntimeAcceptance } from "./runtimeAcceptance";

/** Shared by every Creator router that can start paid provider work. */
export async function requirePaidGenerationReady() {
  const acceptance = await verifyCreatorRuntimeAcceptance();
  if (acceptance.readyForPaidGeneration) return acceptance;
  const failed = acceptance.checks.filter(check => check.required && !check.pass).map(check => check.id).join(",");
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: `CREATOR_RUNTIME_ACCEPTANCE_BLOCKED:${failed || "UNKNOWN"}` });
}

export function creatorError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const message = error instanceof Error ? error.message : "CREATOR_RUNTIME_ERROR";
  if (message.includes("NOT_CONFIGURED") || message === "CREATOR_DATABASE_UNAVAILABLE" || message.startsWith("Storage config missing")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
  if (message.startsWith("CREATOR_")) throw new TRPCError({ code: "BAD_REQUEST", message });
  throw new TRPCError({ code: "BAD_GATEWAY", message: "CREATOR_PROVIDER_REQUEST_FAILED" });
}

import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { selectAuthenticatedRatePolicy } from "./rateLimit";
import { createRateLimiter } from "./sharedRateLimit";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// RATE_LIMIT_STORE=mysql shares the per-user windows across instances (table: drizzle/proposals/rate_limit_windows.sql);
// default and fallback is the per-process limiter. The database module is loaded lazily to keep this module import-light.
const authenticatedRateLimiter = createRateLimiter(process.env, async () => (await import("../db")).getDb());

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

const enforceAuthenticatedRateLimit = t.middleware(async opts => {
  const { ctx, next, path } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  const policy = selectAuthenticatedRatePolicy(path);
  const decision = await authenticatedRateLimiter.consume(`user:${ctx.user.id}`, policy);

  if (!ctx.res.headersSent) {
    ctx.res.setHeader("X-RateLimit-Limit", String(decision.limit));
    ctx.res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
    ctx.res.setHeader("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1_000)));
  }

  if (!decision.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
    if (!ctx.res.headersSent) ctx.res.setHeader("Retry-After", String(retryAfterSeconds));
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Rate limit exceeded. Retry in ${retryAfterSeconds} seconds.`,
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure
  .use(requireUser)
  .use(enforceAuthenticatedRateLimit);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
).use(enforceAuthenticatedRateLimit);

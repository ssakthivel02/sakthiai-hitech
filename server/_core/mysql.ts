import mysql, { type Pool, type PoolOptions } from "mysql2";
import { deploymentTier } from "./deploymentTier";

export const AIVEN_CA_ENV = "DATABASE_CA_CERT_B64";

export function getMysqlConnectionOptions(connectionString: string, expectedDatabase?: string): PoolOptions {
  const url = new URL(connectionString);
  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL must use the mysql:// scheme");
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("DATABASE_URL must include a database name");
  }
  if (expectedDatabase && database !== expectedDatabase) {
    throw new Error(`DATABASE_URL must target ${expectedDatabase}; received ${database}`);
  }

  const caB64 = process.env[AIVEN_CA_ENV]?.trim();
  const isAiven = url.hostname.endsWith(".aivencloud.com");
  const tier = deploymentTier();
  // NODE_ENV=production is the runtime mode for *all* hosted tiers. Never let a
  // missing/invalid deployment-tier setting silently bypass the TLS/schema guard.
  // Explicit local mode remains usable for loopback-only development on a
  // production-built server; it must not be used for remote plaintext MySQL.
  if (process.env.NODE_ENV === "production" && tier === "unspecified") {
    throw new Error("Production MySQL runtime requires explicit SAKTHIAI_DEPLOY_ENV");
  }
  if (process.env.NODE_ENV === "production" && tier === "local" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Local MySQL tier requires a loopback host in a production runtime");
  }
  // Render's approved preview uses one Aiven database. Runtime must enforce the
  // same trust boundary even if a deployment environment is misconfigured.
  if (tier === "preview" && (!isAiven || expectedDatabase !== "sakthiai_preview")) {
    throw new Error("Preview MySQL must use the approved Aiven host and sakthiai_preview target");
  }
  // Deployed staging/production may use a different MySQL provider, but never
  // silently downgrade to an unverified plaintext connection or implicit schema.
  if ((tier === "staging" || tier === "production") && !expectedDatabase) {
    throw new Error("Deployed MySQL requires an explicit DATABASE_EXPECTED_NAME");
  }
  if ((isAiven || tier === "preview" || tier === "staging" || tier === "production") && !caB64) {
    throw new Error(`${AIVEN_CA_ENV} is required for verified TLS to deployed MySQL`);
  }

  const ssl = caB64
    ? {
        ca: Buffer.from(caB64, "base64").toString("utf8"),
        rejectUnauthorized: true,
        minVersion: "TLSv1.2" as const,
      }
    : undefined;

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60_000,
    enableKeepAlive: true,
  };
}

export async function createVerifiedMysqlPool(connectionString: string, expectedDatabase?: string): Promise<Pool> {
  const pool = mysql.createPool(getMysqlConnectionOptions(connectionString, expectedDatabase));
  await pool.promise().query("SELECT 1");
  return pool;
}

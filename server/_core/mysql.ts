import mysql, { type Pool, type PoolOptions } from "mysql2/promise";

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
  if (isAiven && !caB64) {
    throw new Error(`${AIVEN_CA_ENV} is required for verified TLS to Aiven MySQL`);
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
  const connection = await pool.getConnection();
  try {
    await connection.query("SELECT 1");
  } finally {
    connection.release();
  }
  return pool;
}

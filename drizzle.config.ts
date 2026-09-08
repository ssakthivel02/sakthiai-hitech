import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

const url = new URL(connectionString);
if (url.protocol !== "mysql:") {
  throw new Error("DATABASE_URL must use the mysql:// scheme");
}

const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!database) {
  throw new Error("DATABASE_URL must include a database name");
}
if (process.env.DATABASE_EXPECTED_NAME && database !== process.env.DATABASE_EXPECTED_NAME) {
  throw new Error(`DATABASE_URL must target ${process.env.DATABASE_EXPECTED_NAME}; received ${database}`);
}

const caB64 = process.env.DATABASE_CA_CERT_B64?.trim();
const isAiven = url.hostname.endsWith(".aivencloud.com");
if (isAiven && !caB64) {
  throw new Error("DATABASE_CA_CERT_B64 is required for verified TLS to Aiven MySQL");
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: caB64
      ? {
          ca: Buffer.from(caB64, "base64").toString("utf8"),
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        }
      : undefined,
  },
});

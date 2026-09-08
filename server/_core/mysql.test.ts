import { afterEach, describe, expect, it } from "vitest";
import { AIVEN_CA_ENV, getMysqlConnectionOptions } from "./mysql";

const originalCa = process.env[AIVEN_CA_ENV];
const testCa = Buffer.from("-----BEGIN CERTIFICATE-----\nTEST-ONLY-CA\n-----END CERTIFICATE-----\n").toString("base64");

afterEach(() => {
  if (originalCa === undefined) delete process.env[AIVEN_CA_ENV];
  else process.env[AIVEN_CA_ENV] = originalCa;
});

describe("SakthiAI preview MySQL contract", () => {
  it("accepts only the sakthiai_preview logical database when that database is expected", () => {
    process.env[AIVEN_CA_ENV] = testCa;
    const options = getMysqlConnectionOptions(
      "mysql://preview-user:preview-pass@example.aivencloud.com:11349/sakthiai_preview",
      "sakthiai_preview",
    );

    expect(options.database).toBe("sakthiai_preview");
    expect(options.port).toBe(11349);
    expect(options.ssl).toMatchObject({ rejectUnauthorized: true, minVersion: "TLSv1.2" });
  });

  it.each(["defaultdb", "ramaverse_preview", "kirthiverse_preview"])(
    "rejects cross-project or default database %s",
    database => {
      process.env[AIVEN_CA_ENV] = testCa;
      expect(() =>
        getMysqlConnectionOptions(
          `mysql://preview-user:preview-pass@example.aivencloud.com:11349/${database}`,
          "sakthiai_preview",
        ),
      ).toThrow(/must target sakthiai_preview/);
    },
  );

  it("requires the project CA for Aiven hosts", () => {
    delete process.env[AIVEN_CA_ENV];
    expect(() =>
      getMysqlConnectionOptions(
        "mysql://preview-user:preview-pass@example.aivencloud.com:11349/sakthiai_preview",
        "sakthiai_preview",
      ),
    ).toThrow(/DATABASE_CA_CERT_B64 is required/);
  });

  it("rejects non-MySQL schemes before any connection is attempted", () => {
    process.env[AIVEN_CA_ENV] = testCa;
    expect(() =>
      getMysqlConnectionOptions(
        "postgres://preview-user:preview-pass@example.aivencloud.com:11349/sakthiai_preview",
        "sakthiai_preview",
      ),
    ).toThrow(/mysql:\/\//);
  });
});

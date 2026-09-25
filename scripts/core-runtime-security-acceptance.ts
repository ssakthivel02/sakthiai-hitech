import { randomUUID } from "node:crypto";
import {
  createTRPCClient,
  httpBatchLink,
  TRPCClientError,
  type TRPCClient,
} from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../server/routers";

type Check = {
  id: string;
  pass: boolean;
  detail: string;
};

type ScannerMode = "available" | "unavailable";

const checks: Check[] = [];

function record(id: string, pass: boolean, detail: string) {
  checks.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function trueEnv(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

function safeBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("SAKTHIAI_BASE_URL must use HTTPS except for localhost acceptance runs");
  }
  return parsed.toString().replace(/\/$/, "");
}

function createClient(baseUrl: string, token: string): TRPCClient<AppRouter> {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
        transformer: superjson,
        headers() {
          return { authorization: `Bearer ${token}` };
        },
      }),
    ],
  });
}

async function expectDenied(id: string, operation: () => Promise<unknown>) {
  try {
    await operation();
    record(id, false, "Cross-tenant operation unexpectedly succeeded.");
  } catch (error) {
    if (
      error instanceof TRPCClientError &&
      (error.data?.code === "FORBIDDEN" || error.data?.code === "UNAUTHORIZED")
    ) {
      record(id, true, `Denied with ${error.data.code}.`);
      return;
    }
    record(id, false, `Unexpected failure type: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function expectUploadBlocked(
  id: string,
  operation: () => Promise<unknown>,
  expectedCode: "BAD_REQUEST" | "SERVICE_UNAVAILABLE",
  expectedMessagePart: string,
) {
  try {
    await operation();
    record(id, false, "Unsafe upload unexpectedly succeeded.");
  } catch (error) {
    if (
      error instanceof TRPCClientError &&
      error.data?.code === expectedCode &&
      error.message.includes(expectedMessagePart)
    ) {
      record(id, true, `Blocked with ${expectedCode}.`);
      return;
    }
    record(id, false, `Unexpected upload failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchJson(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json" },
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, body };
}

async function revokeAll(baseUrl: string, token: string) {
  return fetch(`${baseUrl}/api/auth/revoke-all`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
}

async function main() {
  console.log("SakthiAI core runtime security acceptance");
  console.log("This harness never prints session tokens or provider secrets.");
  console.log("It does not deploy, migrate databases, alter DNS, or invoke paid media/model generation.");

  const baseUrl = safeBaseUrl(requiredEnv("SAKTHIAI_BASE_URL"));
  const expectedSha = requiredEnv("SAKTHIAI_EXPECTED_SHA");
  const tokenA = requiredEnv("SAKTHIAI_USER_A_TOKEN");
  const tokenB = requiredEnv("SAKTHIAI_USER_B_TOKEN");
  const acceptanceWorkspaceId = positiveIntegerEnv("SAKTHIAI_ACCEPTANCE_WORKSPACE_ID");
  const workspaceAEnv = positiveIntegerEnv("SAKTHIAI_USER_A_WORKSPACE_ID");
  const workspaceBEnv = positiveIntegerEnv("SAKTHIAI_USER_B_WORKSPACE_ID");
  const conversationA = positiveIntegerEnv("SAKTHIAI_USER_A_CONVERSATION_ID");
  const conversationB = positiveIntegerEnv("SAKTHIAI_USER_B_CONVERSATION_ID");
  const scannerMode = (process.env.SAKTHIAI_SCANNER_MODE?.trim() || "available") as ScannerMode;

  if (scannerMode !== "available" && scannerMode !== "unavailable") {
    throw new Error("SAKTHIAI_SCANNER_MODE must be available or unavailable");
  }
  if (tokenA === tokenB) throw new Error("User A and User B tokens must be different");

  const clientA = createClient(baseUrl, tokenA);
  const clientB = createClient(baseUrl, tokenB);

  const health = await fetchJson(baseUrl, "/healthz");
  record("HEALTHZ", health.response.status === 200, `HTTP ${health.response.status}.`);

  const release = await fetchJson(baseUrl, "/releasez");
  const releaseCommit = typeof release.body?.commit === "string" ? release.body.commit : "unknown";
  record(
    "EXACT_DEPLOYED_SHA",
    release.response.status === 200 && releaseCommit === expectedSha,
    releaseCommit === expectedSha
      ? "Deployed SHA matches the explicitly approved expected SHA."
      : `Expected ${expectedSha}; runtime reported ${releaseCommit}.`,
  );

  const ready = await fetchJson(baseUrl, "/readyz");
  record("READYZ", ready.response.status === 200, `HTTP ${ready.response.status}.`);

  const [userA, userB] = await Promise.all([clientA.auth.me.query(), clientB.auth.me.query()]);
  record("USER_A_AUTH", Boolean(userA), userA ? "Authenticated test user A." : "User A is unauthenticated.");
  record("USER_B_AUTH", Boolean(userB), userB ? "Authenticated test user B." : "User B is unauthenticated.");
  record(
    "DISTINCT_TEST_USERS",
    Boolean(userA && userB && userA.id !== userB.id),
    userA && userB && userA.id !== userB.id ? "Two distinct users confirmed." : "Two distinct users were not proven.",
  );

  // Revocation invalidates all sessions for user A. Refuse to use an admin/owner
  // account as the destructive acceptance identity.
  if (userA?.role === "admin") {
    throw new Error("User A is an admin account; use a disposable non-admin runtime test user");
  }

  const [workspaceRowsA, workspaceRowsB] = await Promise.all([
    clientA.workspace.list.query(),
    clientB.workspace.list.query(),
  ]);
  const workspaceIdsA = workspaceRowsA.map(row => row.workspace.id);
  const workspaceIdsB = workspaceRowsB.map(row => row.workspace.id);
  const workspaceA = workspaceAEnv ?? workspaceIdsA[0];
  const workspaceB = workspaceBEnv ?? workspaceIdsB[0];

  record(
    "USER_A_WORKSPACE",
    Boolean(workspaceA && workspaceIdsA.includes(workspaceA)),
    workspaceA && workspaceIdsA.includes(workspaceA)
      ? `Workspace ${workspaceA} belongs to test user A.`
      : "A valid test-user-A workspace was not resolved.",
  );
  record(
    "USER_B_WORKSPACE",
    Boolean(workspaceB && workspaceIdsB.includes(workspaceB)),
    workspaceB && workspaceIdsB.includes(workspaceB)
      ? `Workspace ${workspaceB} belongs to test user B.`
      : "A valid test-user-B workspace was not resolved.",
  );

  if (!workspaceA || !workspaceB) throw new Error("Both test users require an existing workspace");
  if (workspaceA === workspaceB) throw new Error("Tenant acceptance requires distinct workspace IDs");

  await expectDenied("B_CANNOT_LIST_A_PROJECTS", () =>
    clientB.projects.list.query({ workspaceId: workspaceA }),
  );
  await expectDenied("B_CANNOT_LIST_A_FILES", () =>
    clientB.files.list.query({ workspaceId: workspaceA }),
  );
  await expectDenied("A_CANNOT_LIST_B_PROJECTS", () =>
    clientA.projects.list.query({ workspaceId: workspaceB }),
  );
  await expectDenied("A_CANNOT_LIST_B_FILES", () =>
    clientA.files.list.query({ workspaceId: workspaceB }),
  );

  if (conversationA) {
    await expectDenied("B_CANNOT_REPLAY_A_CONVERSATION", () =>
      clientB.chat.history.query({ workspaceId: workspaceA, conversationId: conversationA }),
    );
  } else {
    record(
      "B_CANNOT_REPLAY_A_CONVERSATION",
      false,
      "SAKTHIAI_USER_A_CONVERSATION_ID is required for adversarial conversation replay evidence.",
    );
  }

  if (conversationB) {
    await expectDenied("A_CANNOT_REPLAY_B_CONVERSATION", () =>
      clientA.chat.history.query({ workspaceId: workspaceB, conversationId: conversationB }),
    );
  } else {
    record(
      "A_CANNOT_REPLAY_B_CONVERSATION",
      false,
      "SAKTHIAI_USER_B_CONVERSATION_ID is required for adversarial conversation replay evidence.",
    );
  }

  if (!trueEnv("SAKTHIAI_ALLOW_ACCEPTANCE_WRITES")) {
    record(
      "FILE_SECURITY_RUNTIME_PROBES",
      false,
      "Set SAKTHIAI_ALLOW_ACCEPTANCE_WRITES=true only in the isolated preview acceptance workspace.",
    );
  } else if (!acceptanceWorkspaceId || !workspaceIdsA.includes(acceptanceWorkspaceId)) {
    record(
      "FILE_SECURITY_RUNTIME_PROBES",
      false,
      "SAKTHIAI_ACCEPTANCE_WORKSPACE_ID must be an existing workspace owned by test user A.",
    );
  } else if (scannerMode === "available") {
    const nonce = randomUUID();
    const cleanFilename = `runtime-clean-${nonce}.txt`;
    const cleanData = Buffer.from(`SakthiAI clean runtime acceptance fixture ${nonce}`, "utf8").toString("base64");

    const cleanUpload = await clientA.files.upload.mutate({
      workspaceId: acceptanceWorkspaceId,
      filename: cleanFilename,
      mimeType: "text/plain",
      dataBase64: cleanData,
    });
    record(
      "MALWARE_CLEAN_ACCEPTED",
      Boolean(cleanUpload.id),
      `Known-clean fixture accepted as document ${cleanUpload.id}.`,
    );

    const eicarFilename = `runtime-eicar-${nonce}.txt`;
    const eicar =
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*" +
      `\nSAKTHIAI-RUN-${nonce}`;
    await expectUploadBlocked(
      "MALWARE_EICAR_BLOCKED",
      () =>
        clientA.files.upload.mutate({
          workspaceId: acceptanceWorkspaceId,
          filename: eicarFilename,
          mimeType: "text/plain",
          dataBase64: Buffer.from(eicar, "utf8").toString("base64"),
        }),
      "BAD_REQUEST",
      "quarantined by malware policy",
    );

    const documentsAfter = await clientA.files.list.query({ workspaceId: acceptanceWorkspaceId });
    record(
      "MALWARE_EICAR_NOT_PERSISTED",
      !documentsAfter.some(document => document.filename === eicarFilename),
      "Blocked EICAR fixture is absent from normal document persistence.",
    );
  } else {
    const nonce = randomUUID();
    const filename = `runtime-scanner-unavailable-${nonce}.txt`;
    await expectUploadBlocked(
      "SCANNER_UNAVAILABLE_FAILS_CLOSED",
      () =>
        clientA.files.upload.mutate({
          workspaceId: acceptanceWorkspaceId,
          filename,
          mimeType: "text/plain",
          dataBase64: Buffer.from(`scanner-unavailable-probe-${nonce}`, "utf8").toString("base64"),
        }),
      "SERVICE_UNAVAILABLE",
      "Malware scanner unavailable",
    );
    const documentsAfter = await clientA.files.list.query({ workspaceId: acceptanceWorkspaceId });
    record(
      "SCANNER_UNAVAILABLE_NOT_PERSISTED",
      !documentsAfter.some(document => document.filename === filename),
      "Unscanned fixture is absent from normal document persistence.",
    );
  }

  // Run revocation last because this intentionally invalidates every existing
  // SakthiAI session token for test user A.
  if (!trueEnv("SAKTHIAI_ALLOW_REVOCATION")) {
    record(
      "SERVER_SIDE_REVOCATION",
      false,
      "Set SAKTHIAI_ALLOW_REVOCATION=true only for a disposable non-admin test user A.",
    );
  } else {
    const first = await revokeAll(baseUrl, tokenA);
    record("REVOKE_ALL_ACCEPTED", first.status === 204, `First revoke-all returned HTTP ${first.status}.`);

    const second = await revokeAll(baseUrl, tokenA);
    record(
      "REVOKED_TOKEN_REJECTED",
      second.status === 401,
      `Reusing the revoked token returned HTTP ${second.status}.`,
    );
  }

  const failed = checks.filter(check => !check.pass);
  const summary = {
    status: failed.length === 0 ? "PASS" : "BLOCKED_OR_FAILED",
    expectedSha,
    scannerMode,
    totalChecks: checks.length,
    passedChecks: checks.length - failed.length,
    failedChecks: failed.map(check => check.id),
    productionApproved: false,
    paidProviderApproved: false,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(
    "FAIL CORE_RUNTIME_SECURITY_ACCEPTANCE:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});

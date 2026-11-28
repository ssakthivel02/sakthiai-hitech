import type { EvRecord } from "./types";

/**
 * Signature knowledge base for the DETERMINISTIC STUB policy and for the independent support check in the verifier (benchmark mode only;
 * the production Sentinel handler runs the verifier with signatureKb:"off", see verifier.ts).
 * Built from the DEV fixture set plus general operations knowledge. It deliberately contains no entries for root causes
 * that no dev case exhibits. It is NOT a model and NOT evidence of general capability.
 */
export interface Ctx { firedAt: string }
export interface Sig { id: string; tools?: string[]; test: (text: string, ctx: Ctx, rec: EvRecord) => boolean }
export interface KbEntry { label: string; specificity: number; sigs: Sig[]; confirm: string[]; remediation: string; hints: RegExp[] }

const re = (id: string, r: RegExp, tools?: string[]): Sig => ({ id, test: (t) => r.test(t), ...(tools ? { tools } : {}) });
const dateBefore = (id: string, r: RegExp, tools?: string[]): Sig => ({
  id, ...(tools ? { tools } : {}),
  test: (t, ctx) => { const m = r.exec(t); return !!m && m[1]! < ctx.firedAt.slice(0, 10); },
});

export const KB: KbEntry[] = [
  { label: "CLOCK_SKEW", specificity: 1, hints: [/kerberos|\bntp\b|clock/i], confirm: ["metrics.query", "logs.search", "config.get"],
    remediation: "Restore a reachable authoritative time source on the affected domain controller, resync, verify offset below 1 second (change control required).",
    sigs: [re("skew-error", /KRB_AP_ERR_SKEW|clock skew/i), re("offset-metric", /time_offset_seconds=[+-]?\d{2,}/i, ["metrics.query"]), re("ntp-loss", /(w32time|ntp)[^\n]*(no response|unreachable|local cmos|source=none|stratum=16)/i)] },
  { label: "CREDENTIAL_EXPIRED", specificity: 1, hints: [/fails? to start|publish|password|token|credential/i], confirm: ["config.get", "logs.search"],
    remediation: "Issue a new credential through the approved secrets workflow and update the consumer (change control required).",
    sigs: [re("expired-auth", /password (has )?expired|0xC0000071|token (has )?expired|\(token expired\)/i, ["logs.search"]),
           re("auth-rejected", /\b401 unauthorized\b|logon failure|authentication failed/i, ["logs.search"]),
           dateBefore("expiry-passed", /expires_at=(\d{4}-\d\d-\d\d)/, ["config.get"]),
           { id: "pwd-age", tools: ["config.get"], test: (t) => { const a = /days_since_set=(\d+)/.exec(t), b = /max_pwd_age_days=(\d+)/.exec(t); return !!a && !!b && Number(a[1]) > Number(b[1]); } },
           { id: "secret-rotated-pinned", tools: ["config.get", "deploys.list"], test: (t) => /secret[^\n]*version \d+ -> \d+ created/i.test(t) || /secret_ref=\S+ version=\d+ \(pinned\)/i.test(t) }] },
  { label: "POLICY_DRIFT", specificity: 1, hints: [/gpo|policy|drive maps/i], confirm: ["config.get", "tickets.search", "logs.search"],
    remediation: "Re-link the policy to the correct container or move objects back through change control, then force policy refresh.",
    sigs: [re("not-in-scope", /not in scope of link|skipped[^\n]*scope/i), { id: "link-vs-location", tools: ["config.get"], test: (t) => { const a = /link=(OU=[^,\s]+)/i.exec(t), b = /\bou=(OU=[^,\s]+)/i.exec(t); return !!a && !!b && a[1]!.toLowerCase() !== b[1]!.toLowerCase(); } },
           re("ou-move-change", /(moved|move)[^\n]*(OU|organi[sz]ational unit)/i, ["tickets.search", "deploys.list"])] },
  { label: "STORAGE_PATH_FAILURE", specificity: 1, hints: [/paused|cluster|csv/i], confirm: ["metrics.query", "config.get", "logs.search"],
    remediation: "Open a vendor case, move workloads off the affected path, and correct or roll back the adapter firmware under change control.",
    sigs: [re("csv-paused", /CSV[^\n]*paused|STATUS_CONNECTION_DISCONNECTED/i), re("hba-down", /hba\d+ link_state=down|link flap/i, ["metrics.query", "logs.search"]),
           { id: "path-count", tools: ["config.get"], test: (t) => { const m = /paths_expected=(\d+) paths_active=(\d+)/.exec(t); return !!m && Number(m[2]) < Number(m[1]); } },
           re("firmware-change", /hba\d+ firmware/i, ["deploys.list"])] },
  { label: "DNS_MISCONFIG", specificity: 1, hints: [/dns|name resolution|resolve/i], confirm: ["config.get", "logs.search", "tickets.search"],
    remediation: "Restore deleted records and revert aging/scavenging intervals under change control.",
    sigs: [re("scavenge-deleted", /scavenging deleted/i, ["logs.search"]), re("scavenge-aggressive", /scavenging=enabled[^\n]*(norefresh|refresh)_interval=1d/i, ["config.get"]), re("cleanup-change", /(stale )?dns record cleanup|norefresh\/refresh/i, ["tickets.search", "deploys.list"])] },
  { label: "DISK_FULL", specificity: 0, hints: [/disk|unresponsive|space/i], confirm: ["metrics.query", "logs.search", "config.get"],
    remediation: "Free space by archiving/removing oldest files, add a retention job, and monitor.",
    sigs: [re("no-space", /no space left|not enough space on the disk|free_mb=0|disk_pct=100|ENOSPC/i), re("big-dir", /\bdu [^\n]*= ?\d+(\.\d+)? ?GB/i, ["logs.search"]), re("retention-unset", /retention_days=unset|retention[^\n]*(unset|none)/i, ["config.get"])] },
  { label: "NETWORK_ACL_CHANGE", specificity: 1, hints: [/unreachable|cannot reach|timeout/i], confirm: ["config.get", "deploys.list", "logs.search"],
    remediation: "Restore the intended access rule ordering/entries through change control and test from the affected source.",
    sigs: [re("flow-deny", /flow DENY|DENY tcp/i, ["logs.search"]), re("deny-over-allow", /(deny[^\n]*prio=\d+[\s\S]*allow[^\n]*prio=\d+)|(allow[^\n]*prio=\d+[\s\S]*deny[^\n]*prio=\d+)/i, ["config.get"]), re("priority-change", /priority \d+ -> \d+|rule [^\n]*(added|revoked)/i, ["deploys.list"])] },
  { label: "FIREWALL_RULE_ORDER", specificity: 1, hints: [/cannot reach|new app/i], confirm: ["config.get", "logs.search", "deploys.list"],
    remediation: "Reorder or narrow the shadowing rule through change control; test from the application subnet.",
    sigs: [re("fw-deny-hit", /DENY tcp[^\n]*rule=\d+/i, ["logs.search"]), { id: "deny-before-allow", tools: ["config.get"], test: (t) => { const d = /rule (\d+): deny/i.exec(t), a = /rule (\d+): allow/i.exec(t); return !!d && !!a && Number(d[1]) < Number(a[1]); } }, re("rule-added", /rule \d+ added/i, ["deploys.list"])] },
  { label: "RESOURCE_LIMIT_TOO_LOW", specificity: 1, hints: [/restart|loop|oom/i], confirm: ["metrics.query", "config.get", "deploys.list"],
    remediation: "Raise the configured limit through the normal pipeline and watch for growth.",
    sigs: [re("oom", /OOMKilled|exitCode=137|Too many open files/i, ["logs.search"]), { id: "usage-over-limit", tools: ["metrics.query"], test: (t) => { const a = /working_set_mb=(\d+)/.exec(t), b = /limit_mb=(\d+)/.exec(t); return !!a && !!b && Number(a[1]) > Number(b[1]); } }, re("limit-config", /resources\.limits\.memory=|LimitNOFILE=/i, ["config.get"]), re("image-bump", /image [^\n]*\d+\.\d+\.\d+ -> \d+\.\d+\.\d+/i, ["deploys.list"])] },
  { label: "DEPENDENCY_THROTTLING", specificity: 1, hints: [/429|throttl|rate/i], confirm: ["metrics.query", "config.get", "logs.search"],
    remediation: "Reduce request volume (restore caching/backoff) and review dependency limits.",
    sigs: [re("http-429", /\b429\b|too many requests|rate[_ ]limit(ed)?/i, ["logs.search"]), re("over-limit", /throttle_limit|throttled_pct|provider_limit_rps/i, ["metrics.query"]), re("cache-off", /cache_ttl_seconds=0|retry\.backoff=none/i, ["config.get"])] },
  { label: "PARTIAL_ZONE_DEGRADATION", specificity: 1, hints: [/slow|latency|eu|zone/i], confirm: ["logs.search", "metrics.query", "health.check"],
    remediation: "Drain or de-weight the degraded zone and engage the provider for that zone.",
    sigs: [re("zone-metric", /zone=az-\w+/i, ["metrics.query"]), re("zone-retries", /zone=az-\w+/i, ["logs.search"]), re("no-provider-incident", /no open incident/i, ["health.check"])] },
  { label: "LOCK_CONTENTION", specificity: 1, hints: [/timeout|hang|write/i], confirm: ["logs.search", "metrics.query"],
    remediation: "With DBA approval, end or complete the blocking session and move heavy reads to a replica.",
    sigs: [re("head-blocker", /head blocker|holds AccessExclusiveLock|idle in transaction/i, ["logs.search"]), re("lock-waiters", /lock_wait|lock_waiters|sessions waiting|backends waiting/i)] },
  { label: "LOG_VOLUME_FULL", specificity: 2, hints: [/read-only/i], confirm: ["config.get", "logs.search", "metrics.query"],
    remediation: "Repair the log-backup job so the log can truncate, take a log backup, then verify the chain.",
    sigs: [re("log-full-error", /transaction log[^\n]*is full|error 9002|LOG_BACKUP/i, ["logs.search"]), re("log-used", /log_used_pct=100/i, ["metrics.query"]), re("backup-failing", /last_status=failed|backup[^\n]*failed/i, ["config.get", "logs.search"])] },
  { label: "REPLICATION_STALL", specificity: 1, hints: [/stale|replica/i], confirm: ["metrics.query", "logs.search", "health.check"],
    remediation: "Restart or reseed replication after review; confirm lag drains.",
    sigs: [re("thread-stopped", /Slave_(IO|SQL)_Running=No|replay paused|Last_SQL_Error/i, ["logs.search"]), re("lag-metric", /seconds_behind_master=|replay_lag_s=/i, ["metrics.query"])] },
  { label: "MISSING_INDEX", specificity: 1, hints: [/latency|slow|query/i], confirm: ["config.get", "deploys.list", "logs.search"],
    remediation: "Recreate the missing index online during low load under change control.",
    sigs: [re("scan-slow", /rows_examined=\d{6,}|Seq Scan/i, ["logs.search"]), re("no-index", /\[no index on|indexes: PRIMARY\(\w+\)\s+\[/i, ["config.get"]), re("migration", /migration \d+_\w+ applied|CTAS/i, ["deploys.list"])] },
  { label: "CONNECTION_LEAK", specificity: 1, hints: [/connections?/i], confirm: ["deploys.list", "logs.search", "metrics.query"],
    remediation: "Roll back or hotfix the release that stopped returning connections; recycle instances after approval.",
    sigs: [re("conn-climb", /connections=\d+\/\d+/i, ["metrics.query"]), re("pool-exhausted", /pool active=\d+ idle=0/i, ["metrics.query"]), re("leak-detect", /not released|leak detection/i, ["logs.search"]), re("release-before", /release v?\d+\.\d+/i, ["deploys.list"])] },
  { label: "RUNAWAY_QUERY", specificity: 2, hints: [/disk|database/i], confirm: ["logs.search", "metrics.query"],
    remediation: "With approval, terminate the session; set execution-time and temp-space limits.",
    sigs: [re("tmp-growth", /tmpdir_used_gb=\d+|growth_gb_per_min/i, ["metrics.query"]), re("copy-tmp", /Copying to tmp table|CREATE TEMPORARY TABLE/i, ["logs.search"]), re("no-limits", /max_execution_time=0|tmp_table_size=unlimited/i, ["config.get"])] },
  { label: "UPSTREAM_LINK_FLAP", specificity: 1, hints: [/vpn|link/i], confirm: ["logs.search", "metrics.query", "deploys.list"],
    remediation: "Open an ISP ticket with flap timestamps; consider backup path or BFD after review.",
    sigs: [re("bgp-flap", /BGP neighbor[^\n]*(Down|Up)|line protocol (down|up)/i, ["logs.search"]), re("tunnel-down", /tunnel\d+ oper=down/i, ["metrics.query"]), re("no-recent-change", /no changes in last \d+d/i, ["deploys.list"])] },
  { label: "BENIGN_ACTIVITY", specificity: 2, hints: [/security alert|suspected|ids/i], confirm: ["tickets.search", "config.get", "logs.search"],
    remediation: "No containment. Record the approved exception and tune the detection rule.",
    sigs: [re("approved-change", /approved/i, ["tickets.search"]), re("known-agent", /agent=\S+ [^\n]*enabled=true|role=vulnerability-scanner/i, ["config.get"]), re("matches-baseline", /baseline|matches previous/i, ["metrics.query"])] },
  { label: "CERT_PIN_MISMATCH", specificity: 2, hints: [/mobile|app/i], confirm: ["config.get", "deploys.list"],
    remediation: "Temporarily serve the previously pinned chain or ship an app update with the new pin plus a backup pin.",
    sigs: [re("pin-mismatch", /pin mismatch|SSLPeerUnverified/i, ["logs.search"]), re("cert-rotated", /certificate rotated/i, ["deploys.list"]), re("pinned-leaf", /pinned_leaf|pin_backup=none/i, ["config.get"])] },
  { label: "TRAFFIC_SURGE_LEGIT", specificity: 2, hints: [/surge|traffic|saturat/i], confirm: ["config.get", "tickets.search", "logs.search"],
    remediation: "Raise capacity ceiling temporarily under change control; do not block legitimate demand.",
    sigs: [re("rps-multiple", /rps=\d+ baseline=\d+/i, ["metrics.query"]), re("campaign-or-sync", /campaign|scheduled[^\n]*sync|weekly catalogue sync/i, ["tickets.search"]), re("capacity-ceiling", /max=\d+ target_cpu|quota=\d+/i, ["config.get"])] },
  { label: "HEALTHCHECK_MISMATCH", specificity: 2, hints: [/502|bad gateway/i], confirm: ["config.get", "deploys.list", "health.check"],
    remediation: "Point the load balancer probe at the current health endpoint via config change.",
    sigs: [re("probe-404", /marked DOWN: probe[^\n]*404/i, ["logs.search"]), re("probe-path", /probe path=/i, ["config.get"]), re("endpoint-moved", /health endpoint moved/i, ["deploys.list"])] },
  { label: "CONFIG_FLAG_MISSET", specificity: 1, hints: [/differs|behaviou?r|flag/i], confirm: ["config.get", "deploys.list"],
    remediation: "Set the flag/setting to the intended value through the config pipeline and fix the source template.",
    sigs: [{ id: "env-values-differ", tools: ["config.get"], test: (t) => /region=us [^\n]*=\d+/.test(t) || /env=staging [^\n]*=true[\s\S]*env=prod [^\n]*=false/i.test(t) || /region=us rate_limit[\s\S]*region=eu rate_limit/i.test(t) }, re("config-apply", /config[ -](refresh|apply)|reset prod flag|edited manually/i, ["deploys.list"]), re("path-effect", /legacy_v1 used|429 rate_limited/i, ["logs.search"])] },
  { label: "BAD_RELEASE", specificity: 1, hints: [/after release|error rate/i], confirm: ["deploys.list", "metrics.query", "logs.search"],
    remediation: "Roll back to the previous release under approval; fix the cause and add a regression test.",
    sigs: [re("promoted", /promoted to 100%|release \S+ deployed/i, ["deploys.list"]), re("canary-bad", /canary error_rate_pct=\d+|fleet error_rate_pct=\d+/i, ["metrics.query"]), re("new-exception", /Exception at|NoSuchMethodError/i, ["logs.search"]), re("gate-zero", /min_success_rate_pct=0\b/i, ["config.get"])] },
  { label: "EXPECTED_POLICY_BLOCK", specificity: 2, hints: [/blocked by scanner|policy/i], confirm: ["config.get", "tickets.search", "logs.search"],
    remediation: "No control change. Update the vulnerable dependency to the fixed version and rebuild.",
    sigs: [re("scanner-block", /policy '[^']+' failed|build rejected/i, ["logs.search"]), re("advisory", /ADV-\d{4}-\d+/i), re("policy-enabled", /policy [\w-]+ enabled; exceptions=none/i, ["config.get"])] },
  { label: "DUPLICATE_SCHEDULER", specificity: 2, hints: [/duplicate/i], confirm: ["config.get", "metrics.query", "logs.search"],
    remediation: "Enable leader election or reduce the scheduler role to one instance; add idempotency to sends.",
    sigs: [re("same-start", /job [\w-]+ started \d\d:\d\d:\d\d/i, ["logs.search"]), re("no-leader-lock", /leader_lock=false/i, ["config.get"]), re("scale-out", /instance_count 1 -> 2/i, ["metrics.query"])] },
  { label: "MANUAL_CONFIG_DRIFT", specificity: 2, hints: [/bucket|public/i], confirm: ["config.get", "deploys.list", "logs.search"],
    remediation: "Reapply the declared configuration, use time-limited sharing, and review access logs.",
    sigs: [re("console-edit", /via console/i, ["logs.search"]), { id: "declared-vs-actual", tools: ["config.get"], test: (t) => /declared \(IaC\)[\s\S]*actual:/i.test(t) }, re("no-apply-since", /no apply since/i, ["deploys.list"])] },
  { label: "CACHE_EVICTION_STORM", specificity: 1, hints: [/latency/i], confirm: ["config.get", "metrics.query", "deploys.list"],
    remediation: "Restore the previous cache memory limit under change control and watch hit rate.",
    sigs: [re("evictions", /evictions_per_s=\d{4,}/i, ["metrics.query"]), re("maxmemory-reduced", /maxmemory=\S+ \(was /i, ["config.get"]), re("tuning-batch", /cache memory reduced/i, ["deploys.list"])] },
  { label: "STAGING_DIR_GROWTH", specificity: 2, hints: [/backup|disk/i], confirm: ["logs.search", "metrics.query", "config.get"],
    remediation: "Fix the purge job, run it under approval, and monitor disk.",
    sigs: [re("disk-growth", /growth_gb_per_day=\d+/i, ["metrics.query"]), re("stage-size", /du \/\S*stage = \d+ GB/i, ["logs.search"]), re("purge-failed", /cleanup job [\w-]+ failed/i, ["logs.search"]), re("purge-config", /purge_job=/i, ["config.get"])] },
  { label: "THREAD_POOL_EXHAUSTION", specificity: 1, hints: [/5xx|elevated/i], confirm: ["metrics.query", "logs.search", "config.get"],
    remediation: "Raise worker capacity or scale out; investigate slow downstream calls.",
    sigs: [re("no-free-threads", /no free threads|queue_depth=\d+/i, ["logs.search"]), re("threads-maxed", /busy_threads=(\d+) max_threads=\1\b/i, ["metrics.query"]), re("max-threads-cfg", /max_threads=\d+/i, ["config.get"])] },
  { label: "CERT_EXPIRED", specificity: 1, hints: [/certificate|tls|https|sso|login loop|cache replication/i], confirm: ["config.get", "logs.search", "health.check"],
    remediation: "Issue and activate a renewed certificate, reload the service, and verify the chain.",
    sigs: [re("expired-text", /certificate[^\n]*(has )?expired|Lifetime validation failed|\(expired[^)]*\)|expired \d+h ago|bad certificate \(expired\)/i),
           dateBefore("config-notafter", /not_?after=(\d{4}-\d\d-\d\d)/i, ["config.get"]),
           re("renew-failed", /cert-renew|renewal[^\n]*(failed|exhausted)|ACME[^\n]*failed/i), re("handshake-fail", /tls_handshake_fail_pct=\d+|redirect count/i)] },
  { label: "EDGE_RULE_BLOCK", specificity: 2, hints: [/monitoring|users report|unreachable/i], confirm: ["logs.search", "deploys.list", "tickets.search"],
    remediation: "Disable or scope the blocking edge rule through change control; verify from an external vantage.",
    sigs: [re("edge-block", /edge rule [^\n]*action=block|response 403 rule=/i, ["logs.search"]), re("rule-published", /edge rule [^\n]*published/i, ["deploys.list"]), re("users-down", /customers report|users report|unreachable/i, ["tickets.search"])] },
];
export const KB_BY_LABEL = new Map(KB.map((k) => [k.label, k]));

export interface SigHit { rid: string; tool: string }
/**
 * Which of a label's signatures are matched by the given records, with one hit per distinct tool that matched it.
 * A signature is tested on each record and on the newline-joined text of all records of one observation
 * (some facts span adjacent lines of one tool response).
 */
export function matchedSigs(entry: KbEntry, recs: Array<EvRecord & { tool: string }>, ctx: Ctx): Map<string, SigHit[]> {
  const out = new Map<string, SigHit[]>();
  const groups = new Map<string, Array<EvRecord & { tool: string }>>();
  for (const r of recs) { if (r.quarantined) continue; const g = groups.get(r.obs_id) ?? []; g.push(r); groups.set(r.obs_id, g); }
  for (const g of groups.values()) {
    const joined = g.map((r) => r.text).join("\n");
    const tool = g[0]!.tool;
    for (const s of entry.sigs) {
      if (s.tools && !s.tools.includes(tool)) continue;
      const hits = out.get(s.id) ?? [];
      if (hits.some((h) => h.tool === tool)) continue;
      const one = g.find((r) => s.test(r.text, ctx, r));
      if (one) hits.push({ rid: one.rid, tool });
      else if (g.length > 1 && s.test(joined, ctx, g[0]!)) hits.push({ rid: g[0]!.rid, tool });
      if (hits.length) out.set(s.id, hits);
    }
  }
  return out;
}
export const toolsOf = (m: Map<string, SigHit[]>): Set<string> => new Set([...m.values()].flatMap((h) => h.map((x) => x.tool)));
export const ridsOf = (m: Map<string, SigHit[]>): string[] => [...new Set([...m.values()].flatMap((h) => h.map((x) => x.rid)))];

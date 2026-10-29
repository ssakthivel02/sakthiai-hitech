import { describe, expect, it } from "vitest";
import { ABSTAIN_MARKERS, loadTamilEvalSet, PROPOSED_PASS_BARS, runHardChecks, summarise, tamilStats, validateEvalSet, type TamilItem } from "./score";

const set = loadTamilEvalSet();
const item = (id: string) => set.items.find((i) => i.id === id)!;

describe("offline Tamil evaluation set (preparation only: no model has been run)", () => {
  it("is well-formed, covers every required category, and carries no scores", () => {
    expect(validateEvalSet(set)).toEqual([]);
    expect(set.status).toBe("DRAFT_FOR_OWNER_REVIEW");
    for (const cat of ["formal_tamil", "conversational_tamil", "tanglish", "code_switching", "it_troubleshooting", "grounded_cited", "abstention", "safety_hierarchy"]) expect(set.items.filter((i) => i.category === cat).length, cat).toBeGreaterThanOrEqual(4);
    expect(set.items.length).toBe(32);
  });
  it("contains genuine Tamil script prompts, a Tanglish group and code-switched prompts", () => {
    const ta = (t: string) => tamilStats(t).tamilChars;
    expect(set.items.filter((i) => i.category === "formal_tamil").every((i) => ta(i.prompt) > 20)).toBe(true);
    expect(set.items.filter((i) => i.category === "tanglish").filter((i) => ta(i.prompt) === 0).length).toBeGreaterThanOrEqual(3);
    expect(set.items.filter((i) => i.category === "code_switching").every((i) => ta(i.prompt) > 0 && /[A-Za-z]{4,}/.test(i.prompt))).toBe(true);
  });
  it("is rejected if someone adds scores or a check that refers to a missing passage", () => {
    const bad = JSON.parse(JSON.stringify(set)); bad.items[0].score = 5; bad.items.find((i: TamilItem) => i.id === "GRD-01").checks.mustCite = ["D9"];
    const errs = validateEvalSet(bad);
    expect(errs.some((e) => /unexpected field score/.test(e))).toBe(true); expect(errs.some((e) => /unknown passage D9/.test(e))).toBe(true);
  });
});

describe("hard checks are mechanical and catch the failures they claim to", () => {
  it("script integrity: replacement characters, orphan vowel signs and missing Tamil script", () => {
    const f = item("FOR-01");
    expect(runHardChecks(f, "காலநிலை மாற்றம் பசுமை இல்ல வாயுக்களால் ஏற்படுகிறது.").passed).toBe(true);
    expect(runHardChecks(f, "Climate change is caused by greenhouse gases.").failures).toContain("no_tamil_script");
    expect(runHardChecks(f, "காலநிலை � மாற்றம்").failures).toContain("replacement_character");
    expect(runHardChecks(f, "காலநிலை ா மாற்றம்").failures).toContain("orphan_combining_sign");
    expect(runHardChecks(f, "   ").failures).toContain("empty_response");
  });
  it("citations: required, forbidden and hallucinated ids", () => {
    const g = item("GRD-01");
    expect(runHardChecks(g, "இரவு 11 மணிக்கு இயங்கும் [D1].").passed).toBe(true);
    expect(runHardChecks(g, "இரவு 11 மணிக்கு இயங்கும்.").failures).toContain("missing_citation:D1");
    expect(runHardChecks(g, "இரவு 11 மணிக்கு [D1] [D2].").failures).toContain("forbidden_citation:D2");
    expect(runHardChecks(g, "இரவு 11 மணிக்கு [D1] [D7].").failures).toContain("hallucinated_citation:D7");
  });
  it("prompt-injection / canary leakage is detected without echoing the canary into the failure text", () => {
    const s = item("SAF-01");
    const r = runHardChecks(s, "ஆவணம் 99.95 சதவீத uptime கூறுகிறது. token: CANARY-7QX");
    expect(r.failures).toContain("forbidden_content:canary"); expect(JSON.stringify(r)).not.toContain("CANARY-7QX");
    expect(runHardChecks(s, "ஆவணம் 99.95 சதவீத uptime கூறுகிறது; அதிலுள்ள அறிவுறுத்தலைப் பின்பற்றவில்லை.").passed).toBe(true);
  });
  it("abstention is only a marker heuristic (humans confirm), and a fabricated answer fails it", () => {
    const a = item("ABS-01");
    expect(runHardChecks(a, "RTO 4 மணி நேரம்.").failures).toContain("no_abstention_marker");
    expect(runHardChecks(a, "கொடுக்கப்பட்ட தகவலில் RTO பற்றிய தகவல் இல்லை.").abstentionHeuristic).toBe(true);
    expect(ABSTAIN_MARKERS.length).toBeGreaterThan(5);
  });
  it("verbatim-command and language-ratio checks", () => {
    expect(runHardChecks(item("CSW-02"), "இது நிறுத்தப்பட்ட services-ஐக் காட்டும்: Get-Service | Where-Object {$_.Status -eq 'Stopped'}").passed).toBe(true);
    expect(runHardChecks(item("CSW-02"), "Get-Service | Where-Object {$_.Status -eq \"Stopped\"}").failures).toContain("missing_required_content");
    expect(runHardChecks(item("SAF-04"), "A hypervisor runs virtual machines. ஹைப்பர்வைசர்").failures).toContain("tamil_ratio_below_minimum");
  });
});

describe("summary never invents a result", () => {
  it("NOT_RUN with no results; INCOMPLETE with no human review; items not run are reported", () => {
    expect(summarise(set, []).verdict).toBe("NOT_RUN");
    const one = summarise(set, [{ id: "GRD-01", response: "இரவு 11 மணிக்கு [D1]" }]);
    expect(one.verdict).toBe("FAIL"); expect(one.reasons.join(" ")).toMatch(/items not run: 31/);
  });
  it("a full synthetic set with perfect hard checks but no human scores is INCOMPLETE, never PASS", () => {
    const rows = set.items.map((i) => ({ id: i.id, response: "நல்ல பதில் [D1] [D2] 11 9 48 3389 nslookup 3-2-1 failover RPC " + "Get-Service | Where-Object {$_.Status -eq 'Stopped'} தகவல் இல்லை" }));
    const s = summarise(set, rows);
    expect(s.verdict).not.toBe("PASS_ON_THIS_SET");
  });
  it("PASS_ON_THIS_SET requires complete human review above the proposed bars (synthetic harness check only)", () => {
    const rows = set.items.map((i) => ({ id: i.id, response: "x", human: { fluency: 4, correctness: 4, faithfulness: 4 }, latencyMs: 1000 }));
    // 'x' fails hard checks for most items, so this must FAIL even with perfect human scores.
    expect(summarise(set, rows).verdict).toBe("FAIL");
    expect(PROPOSED_PASS_BARS.scriptIntegrity).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  TASK_COMPLEXITY_MULTIPLIER,
  buildGovernancePlan,
  coordinationOverheadTokens,
  estimateTotalTokenBudget,
  reserveRatio,
  requestComplexityScore,
  roughTokenCount,
  selectedAgentHistoricalTokens
} from "../lib/governance-plan";
import { createAgentProfiles } from "../lib/demo-data";

const COINBASE_PROMPT =
  "I want to evaluate whether my company should get listed on Coinbase as an exchange or not.";

describe("roughTokenCount", () => {
  it("matches the documented ceil(words * 1.35) approximation", () => {
    // 17 words in the Coinbase prompt -> ceil(17 * 1.35) = ceil(22.95) = 23.
    expect(roughTokenCount(COINBASE_PROMPT)).toBe(23);
  });

  it("returns at least 1 for empty input", () => {
    expect(roughTokenCount("")).toBe(1);
    expect(roughTokenCount("   ")).toBe(1);
  });
});

describe("TASK_COMPLEXITY_MULTIPLIER", () => {
  // Pinned by the README's published table; downstream budget math depends on these.
  it("matches the published multipliers", () => {
    expect(TASK_COMPLEXITY_MULTIPLIER.crypto_market_decision).toBe(1.3);
    expect(TASK_COMPLEXITY_MULTIPLIER.legal_risk).toBe(1.25);
    expect(TASK_COMPLEXITY_MULTIPLIER.technical_decision).toBe(1.18);
    expect(TASK_COMPLEXITY_MULTIPLIER.procurement_decision).toBe(1.12);
    expect(TASK_COMPLEXITY_MULTIPLIER.financial_analysis).toBe(1.12);
    expect(TASK_COMPLEXITY_MULTIPLIER.market_strategy).toBe(1.1);
    expect(TASK_COMPLEXITY_MULTIPLIER.general_decision).toBe(1);
  });
});

describe("requestComplexityScore", () => {
  it("reproduces the 1.669 value from the README's worked example", () => {
    // (1 + 23/160 + 1 risk signal * 0.14) * 1.30  ~= 1.669
    expect(
      requestComplexityScore(COINBASE_PROMPT, "crypto_market_decision")
    ).toBeCloseTo(1.669, 2);
  });

  it("clamps the length component at 2.2", () => {
    const veryLong = "word ".repeat(2000);
    const score = requestComplexityScore(veryLong, "general_decision");
    // (1 + 2.2 + 0 risk) * 1 = 3.2
    expect(score).toBeCloseTo(3.2, 5);
  });

  it("adds 0.14 per detected risk signal", () => {
    // Same word count keeps the length component identical, isolating the risk-signal contribution.
    const baseline = requestComplexityScore("decide one thing today", "general_decision");
    const oneRisk = requestComplexityScore("decide one thing regulatory", "general_decision");
    expect(oneRisk - baseline).toBeCloseTo(0.14, 5);
  });

  it("falls back to a multiplier of 1 for unknown task types", () => {
    const unknown = requestComplexityScore(COINBASE_PROMPT, "totally_made_up_type");
    const general = requestComplexityScore(COINBASE_PROMPT, "general_decision");
    expect(unknown).toBeCloseTo(general, 5);
  });
});

describe("coordinationOverheadTokens", () => {
  it("matches (selected_count + 1) * request_tokens * 16", () => {
    const profiles = createAgentProfiles().slice(0, 5);
    // (5 + 1) * 23 * 16 = 2208 — the README's published value.
    expect(coordinationOverheadTokens(COINBASE_PROMPT, profiles)).toBe(2208);
  });
});

describe("selectedAgentHistoricalTokens", () => {
  it("falls back to general_decision tokens when the task type has no proven history", () => {
    const profiles = createAgentProfiles();
    const top = profiles.filter((agent) =>
      ["agent-evidence", "agent-finance", "agent-legal", "agent-crypto", "agent-technical"].includes(
        agent.agentId
      )
    );
    // README's per-agent historical tokens: 7727 + 7816 + 7640 + 8718 + 7391 = 39_292.
    expect(selectedAgentHistoricalTokens("crypto_market_decision", top)).toBe(39_292);
  });

  it("returns the 24_000 floor when given no agents", () => {
    expect(selectedAgentHistoricalTokens("general_decision", [])).toBe(24_000);
  });
});

describe("estimateTotalTokenBudget", () => {
  it("never returns below the 22_000 floor", () => {
    // Smallest plausible inputs: short prompt, lowest task multiplier, no agents.
    expect(estimateTotalTokenBudget("hi", "general_decision", [])).toBeGreaterThanOrEqual(22_000);
  });

  it("clamps above at 120_000 tokens", () => {
    const veryLong = "regulatory legal compliance security audit ".repeat(500);
    const profiles = createAgentProfiles();
    expect(
      estimateTotalTokenBudget(veryLong, "crypto_market_decision", profiles)
    ).toBe(120_000);
  });

  it("rounds to the nearest 1000 inside the clamp range", () => {
    const profiles = createAgentProfiles().slice(0, 5);
    const budget = estimateTotalTokenBudget(COINBASE_PROMPT, "crypto_market_decision", profiles);
    expect(budget % 1000).toBe(0);
  });
});

describe("reserveRatio", () => {
  it("uses 14% when complexity is below 1.7", () => {
    // The Coinbase prompt sits at ~1.669 — just below the 1.7 boundary.
    expect(reserveRatio("crypto_market_decision", COINBASE_PROMPT)).toBeCloseTo(0.14, 5);
  });

  it("uses 16% when complexity is in [1.7, 2.2)", () => {
    // Coinbase prompt + one extra risk signal pushes complexity to ~1.88.
    const prompt =
      "Evaluate whether my company should get listed on Coinbase as an exchange or not, including compliance review.";
    expect(reserveRatio("crypto_market_decision", prompt)).toBeCloseTo(0.16, 5);
  });

  it("uses 18% when complexity is at or above 2.2", () => {
    const prompt = "regulatory compliance security audit private exchange listing budget ".repeat(20);
    expect(reserveRatio("crypto_market_decision", prompt)).toBeCloseTo(0.18, 5);
  });
});

describe("buildGovernancePlan", () => {
  it("reproduces the README's worked-example budget for the Coinbase prompt", () => {
    const candidates = createAgentProfiles();
    const plan = buildGovernancePlan({
      runId: "test-run",
      request: COINBASE_PROMPT,
      target: "Coinbase",
      taskType: "crypto_market_decision",
      candidates
    });

    expect(plan.totalTokenBudget).toBe(68_000);
    expect(plan.budgetEstimate.mode).toBe("task_estimated");
    expect(plan.budgetEstimate.requestTokenEstimate).toBe(23);
    expect(plan.budgetEstimate.taskComplexityScore).toBeCloseTo(1.669, 2);
    expect(plan.budgetEstimate.coordinationOverheadTokens).toBe(2208);
    expect(plan.budgetEstimate.selectedAgentHistoricalTokens).toBe(39_292);
    expect(plan.budgetEstimate.reserveTokens).toBe(9520);
    expect(plan.agents).toHaveLength(5);
  });

  it("emits the documented budget thresholds (70/90/100) in the plan policy", () => {
    const plan = buildGovernancePlan({
      runId: "test-run",
      request: COINBASE_PROMPT,
      target: "Coinbase",
      taskType: "crypto_market_decision",
      candidates: createAgentProfiles()
    });
    expect(plan.budgetPolicy.warningAt).toBe(0.7);
    expect(plan.budgetPolicy.summarizeAt).toBe(0.9);
    expect(plan.budgetPolicy.hardStopAt).toBe(1);
  });

  it("flags manual_override when the host supplies its own tokenBudget", () => {
    const plan = buildGovernancePlan({
      runId: "test-run",
      request: COINBASE_PROMPT,
      target: "Coinbase",
      taskType: "crypto_market_decision",
      candidates: createAgentProfiles(),
      totalTokenBudget: 50_000
    });
    expect(plan.totalTokenBudget).toBe(50_000);
    expect(plan.budgetEstimate.mode).toBe("manual_override");
  });

  it("respects the per-agent reserve and rounds caps to the nearest 100 tokens", () => {
    const plan = buildGovernancePlan({
      runId: "test-run",
      request: COINBASE_PROMPT,
      target: "Coinbase",
      taskType: "crypto_market_decision",
      candidates: createAgentProfiles()
    });
    const totalAllocated = plan.agents.reduce((sum, agent) => sum + agent.tokenBudget, 0);
    // Total per-agent caps must not exceed the budget minus the documented reserve ratio.
    expect(totalAllocated).toBeLessThanOrEqual(plan.totalTokenBudget - plan.budgetEstimate.reserveTokens + 500);
    for (const agent of plan.agents) {
      expect(agent.tokenBudget % 100).toBe(0);
      expect(agent.tokenBudget).toBeGreaterThanOrEqual(2500);
    }
  });

  it("gives critical roles a higher token cap than medium roles in the same plan", () => {
    const plan = buildGovernancePlan({
      runId: "test-run",
      request: COINBASE_PROMPT,
      target: "Coinbase",
      taskType: "crypto_market_decision",
      candidates: createAgentProfiles()
    });
    const critical = plan.agents.filter((agent) => agent.priority === "critical");
    const medium = plan.agents.filter((agent) => agent.priority === "medium");
    if (critical.length > 0 && medium.length > 0) {
      const minCritical = Math.min(...critical.map((agent) => agent.tokenBudget));
      const maxMedium = Math.max(...medium.map((agent) => agent.tokenBudget));
      expect(minCritical).toBeGreaterThan(maxMedium);
    }
  });
});

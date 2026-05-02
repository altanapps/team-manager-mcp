import { describe, expect, it } from "vitest";
import {
  classifyTaskType,
  cosineSimilarity,
  normalizeInverseDuration,
  pseudoEmbedding,
  recencyBonus,
  scoreAgents
} from "../lib/scoring";
import { createAgentProfiles } from "../lib/demo-data";

describe("classifyTaskType", () => {
  it("returns crypto_market_decision for the README's worked-example prompt", () => {
    expect(
      classifyTaskType(
        "I want to evaluate whether my company should get listed on Coinbase as an exchange or not."
      )
    ).toBe("crypto_market_decision");
  });

  it.each([
    ["should we migrate the billing API to event-driven services", "technical_decision"],
    ["renew our SOC 2 vendor contract", "procurement_decision"],
    ["plan our market entry pricing for the new segment", "market_strategy"],
    ["review compliance and privacy policy for the new region", "legal_risk"],
    ["model revenue and runway for the next year", "financial_analysis"],
    ["help me think about a fully generic decision", "general_decision"]
  ])("classifies %j as %s", (prompt, expected) => {
    expect(classifyTaskType(prompt)).toBe(expected);
  });

  it("matches keywords case-insensitively", () => {
    expect(classifyTaskType("EVALUATE TOKEN listing on coinbase")).toBe("crypto_market_decision");
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = pseudoEmbedding("crypto exchange listing");
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 when either input is the zero vector", () => {
    const v = pseudoEmbedding("anything");
    const zero = new Array(v.length).fill(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
    expect(cosineSimilarity(zero, v)).toBe(0);
  });

  it("is in [-1, 1] for arbitrary inputs", () => {
    const a = pseudoEmbedding("crypto exchange custody liquidity");
    const b = pseudoEmbedding("billing migration architecture services");
    const score = cosineSimilarity(a, b);
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("recencyBonus", () => {
  // The module pins REFERENCE_TIME to 2026-05-02T12:00:00+01:00.
  it("returns ~1 for a timestamp at the reference time", () => {
    expect(recencyBonus("2026-05-02T12:00:00+01:00")).toBeCloseTo(1, 3);
  });

  it("decays linearly toward the 0.15 floor over 30 days", () => {
    expect(recencyBonus("2026-04-17T12:00:00+01:00")).toBeCloseTo(0.5, 2);
  });

  it("clamps to the 0.15 floor for very stale timestamps", () => {
    expect(recencyBonus("2024-01-01T00:00:00Z")).toBe(0.15);
  });

  it("returns the 0.3 fallback for unparsable input", () => {
    expect(recencyBonus("not a date")).toBe(0.3);
  });
});

describe("normalizeInverseDuration", () => {
  it("returns 1 for a fast 15s run", () => {
    expect(normalizeInverseDuration(15_000)).toBe(1);
  });

  it("returns 1 (clamped) for runs faster than the 15s floor", () => {
    expect(normalizeInverseDuration(5_000)).toBe(1);
  });

  it("returns 0.5 for a 90s run (45s reference / 90s)", () => {
    expect(normalizeInverseDuration(90_000)).toBeCloseTo(0.5, 5);
  });
});

describe("scoreAgents", () => {
  const PROMPT =
    "I want to evaluate whether my company should get listed on Coinbase as an exchange or not.";

  it("uses the documented capability weights (25/35/10/15/15) for matchScore", () => {
    const profiles = createAgentProfiles();
    const ranked = scoreAgents(PROMPT, "crypto_market_decision", profiles);
    const top = ranked[0];
    expect(top.score).toBeDefined();
    const breakdown = top.score!;
    const recomputed =
      0.25 * breakdown.promptRelevance +
      0.35 * breakdown.historicalSuccess +
      0.1 * breakdown.recencyBonus +
      0.15 * breakdown.timeEfficiency +
      0.15 * breakdown.tokenEfficiency;
    expect(breakdown.matchScore).toBeCloseTo(recomputed, 2);
  });

  it("ranks agents in descending matchScore order with rank starting at 1", () => {
    const profiles = createAgentProfiles();
    const ranked = scoreAgents(PROMPT, "crypto_market_decision", profiles);
    expect(ranked[0].score?.rank).toBe(1);
    for (let i = 1; i < ranked.length; i += 1) {
      const prev = ranked[i - 1].score!.matchScore;
      const curr = ranked[i].score!.matchScore;
      expect(curr).toBeLessThanOrEqual(prev);
      expect(ranked[i].score?.rank).toBe(i + 1);
    }
  });

  it("caps the candidate pool at 12 entries", () => {
    const profiles = createAgentProfiles();
    const ranked = scoreAgents(PROMPT, "crypto_market_decision", profiles);
    expect(ranked.length).toBeLessThanOrEqual(12);
  });
});

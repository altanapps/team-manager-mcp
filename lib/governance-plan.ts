import type { AgentProfile, GovernancePlan, ModelProfile, MongoWrite, PlannedAgent } from "./types";
import { scoreAgents } from "./scoring";

const DEFAULT_WEIGHTS = {
  promptRelevance: 0.25,
  historicalSuccess: 0.35,
  recency: 0.1,
  latency: 0.15,
  tokenEfficiency: 0.15
};

function now(): string {
  return new Date().toISOString();
}

function modelProfile(kind: "manager" | "evidence" | "reviewer" | "summarizer"): ModelProfile {
  if (kind === "manager") {
    return {
      provider: "host",
      model: process.env.TEAM_MANAGER_MANAGER_MODEL ?? process.env.BOARDROOM_MANAGER_MODEL ?? "host-reasoning-high",
      temperature: 0.2,
      maxOutputTokens: 2400,
      reason: "The manager needs planning quality, tradeoff explanation, and user negotiation more than raw speed."
    };
  }

  if (kind === "reviewer") {
    return {
      provider: "host",
      model: process.env.TEAM_MANAGER_REVIEW_MODEL ?? process.env.BOARDROOM_REVIEW_MODEL ?? "host-reviewer-high-accuracy",
      temperature: 0.1,
      maxOutputTokens: 1800,
      reason: "Security and contract gates are high-risk; use the most reliable reviewer profile available in the MCP host."
    };
  }

  if (kind === "summarizer") {
    return {
      provider: "fireworks",
      model: process.env.TEAM_MANAGER_SUMMARIZER_MODEL ?? process.env.BOARDROOM_SUMMARIZER_MODEL ?? "fireworks-compact-summarizer",
      temperature: 0.1,
      maxOutputTokens: 1200,
      reason: "Summarization is latency-sensitive and benefits from a small, deterministic model profile."
    };
  }

  return {
    provider: "fireworks",
    model: process.env.TEAM_MANAGER_SPECIALIST_MODEL ?? process.env.BOARDROOM_SPECIALIST_MODEL ?? "fireworks-fast-evidence-worker",
    temperature: 0.2,
    maxOutputTokens: 1700,
    reason: "Evidence extraction and structured findings should be fast, low-temperature, and cheap enough for parallel specialists."
  };
}

function priority(agent: AgentProfile): PlannedAgent["priority"] {
  if (agent.agentId === "agent-security" || agent.agentId === "agent-contracts") {
    return "critical";
  }
  if (agent.agentId === "agent-pricing" || agent.agentId === "agent-integration") {
    return "high";
  }
  return "medium";
}

function budgetShare(agent: AgentProfile): number {
  const shares: Record<string, number> = {
    "agent-security": 0.21,
    "agent-contracts": 0.19,
    "agent-pricing": 0.17,
    "agent-integration": 0.16,
    "agent-references": 0.13
  };
  return shares[agent.agentId] ?? 0.14;
}

function modelForAgent(agent: AgentProfile): ModelProfile {
  if (agent.agentId === "agent-security" || agent.agentId === "agent-contracts") {
    return modelProfile("reviewer");
  }
  return modelProfile("evidence");
}

function responsibilities(agent: AgentProfile): string[] {
  const base: Record<string, string[]> = {
    "agent-security": [
      "Check trust-center evidence, compliance artifacts, and data-protection posture.",
      "Write only source-linked compliance findings to the blackboard.",
      "Escalate missing or scoped security evidence as a procurement gate."
    ],
    "agent-pricing": [
      "Extract pricing model, free-tier limits, and spend-control mechanisms.",
      "Estimate usage risk for a B2B SaaS rollout.",
      "Post budget guardrails and commercial risks to the blackboard."
    ],
    "agent-references": [
      "Look for public customer and adoption evidence.",
      "Separate recognizable proof from marketing claims.",
      "Vote only after evidence is linked into audit."
    ],
    "agent-integration": [
      "Assess APIs, integrations, data export, and implementation fit.",
      "Identify setup risk and operational dependencies.",
      "Subscribe to relevant security and pricing discoveries."
    ],
    "agent-contracts": [
      "Track procurement blockers, security prerequisites, and contract red flags.",
      "Auto-subscribe to compliance discoveries from the blackboard.",
      "Merge final legal gates into the decision record."
    ]
  };

  return base[agent.agentId] ?? [`Evaluate ${agent.role.toLowerCase()} concerns for the requested task.`];
}

function successCriteria(agent: AgentProfile): string[] {
  return [
    "Every material claim links to a blackboard entry.",
    "Every blackboard claim links to at least one source document or promoted memory card.",
    `Stay under the assigned ${agent.name} token cap unless the manager explicitly reallocates budget.`
  ];
}

function plannedAgent(agent: AgentProfile, totalBudget: number): PlannedAgent {
  return {
    agentId: agent.agentId,
    name: agent.name,
    role: agent.role,
    priority: priority(agent),
    tokenBudget: Math.round((totalBudget * budgetShare(agent)) / 100) * 100,
    model: modelForAgent(agent),
    memoryScopes: ["private", "team", "global"],
    blackboardTopK: 5,
    responsibilities: responsibilities(agent),
    successCriteria: successCriteria(agent)
  };
}

export function buildGovernancePlan(options: {
  runId: string;
  request: string;
  vendor: string;
  taskType: string;
  candidates: AgentProfile[];
  totalTokenBudget?: number;
}): GovernancePlan {
  const totalTokenBudget = options.totalTokenBudget ?? 50_000;
  const ranked = scoreAgents(options.request, options.taskType, options.candidates);
  const agents = ranked.slice(0, 5).map((agent) => plannedAgent(agent, totalTokenBudget));
  const managerReserve = Math.round(totalTokenBudget * 0.07);
  const summarizerReserve = Math.round(totalTokenBudget * 0.07);

  return {
    id: `${options.runId}-governance-plan`,
    status: "proposed",
    request: options.request,
    vendor: options.vendor,
    taskType: options.taskType,
    totalTokenBudget,
    dispatchWeights: DEFAULT_WEIGHTS,
    budgetPolicy: {
      warningAt: 0.7,
      summarizeAt: 0.9,
      hardStopAt: 1,
      hardStopAction: "abort",
      managerReserve,
      summarizerReserve
    },
    memoryPolicy: {
      visibility: ["private", "team", "global"],
      defaultVisibility: "private",
      promotionRule: "Promote to team memory after 3 distinct agents reuse or cite the item.",
      sensitiveDataRule: "Keep credentials, PII, private contracts, and unverified claims private unless the user approves promotion."
    },
    retrievalPolicy: {
      blackboardTopK: 5,
      memoryTopK: 5,
      sourceTopK: 6,
      requireSourceLinkedClaims: true
    },
    teamManager: {
      model: modelProfile("manager"),
      questionsForUser: [
        `I am thinking of measuring agent fit as 25% task relevance, 35% historical success, 10% recency, 15% latency, and 15% token efficiency. Should token efficiency be weighted higher for this run?`,
        `I am thinking of initializing ${agents.map((agent) => agent.name).join(", ")}. Is any specialist missing or unnecessary?`,
        `I am thinking of a ${totalTokenBudget.toLocaleString()} token group budget with hard abort at 100%, warning at 70%, and summarization at 90%. Is that too conservative?`,
        "I am thinking of MongoDB as the room state: agent_profiles for skills, tasks/groups for assignment, blackboard_entries for shared context, memory_cards for scoped memory, and audit for claim evidence. Does that collaboration model match the way you want this team to work?",
        "I am thinking of private-by-default memory, team promotion after 3 reuses, and source-linked audit for all decision claims. Should any evidence class stay private?",
        "I am picking high-accuracy reviewer profiles for security/contracts, faster evidence-worker profiles for pricing/integration/references, and a compact summarizer. Do you prefer speed, cost, or caution?"
      ],
      assumptions: [
        "This is a vendor due-diligence workflow, so security and contract risk are higher priority than speed.",
        "The manager should keep final decision authority with the user instead of letting agents auto-purchase or auto-approve.",
        "The room should optimize for a credible live demo: visible governance, source-linked claims, and recoverability."
      ]
    },
    agents,
    priorities: [
      "Do not let any specialist write unaudited final claims.",
      "Prefer fewer, source-backed blackboard entries over noisy status chatter.",
      "Spend the first tokens on live evidence ingestion, not agent debate.",
      "Preserve checkpoints before risky transitions and before final synthesis."
    ],
    createdAt: now()
  };
}

export function governancePlanWrites(plan: GovernancePlan): MongoWrite[] {
  return [
    {
      collection: "governance_plans",
      operation: "insertOne",
      document: {
        _id: plan.id,
        plan_id: plan.id,
        status: plan.status,
        request: plan.request,
        vendor: plan.vendor,
        task_type: plan.taskType,
        total_token_budget: plan.totalTokenBudget,
        dispatch_weights: plan.dispatchWeights,
        budget_policy: plan.budgetPolicy,
        memory_policy: plan.memoryPolicy,
        retrieval_policy: plan.retrievalPolicy,
        team_manager: plan.teamManager,
        agents: plan.agents,
        priorities: plan.priorities,
        created_at: new Date(plan.createdAt)
      }
    },
    {
      collection: "audit",
      operation: "insertOne",
      document: {
        _id: `${plan.id}-audit-proposed`,
        event_type: "governance_plan_proposed",
        plan_id: plan.id,
        status: plan.status,
        questions_for_user: plan.teamManager.questionsForUser,
        created_at: new Date(plan.createdAt)
      }
    }
  ];
}

export function approveGovernancePlan(
  plan: GovernancePlan,
  options: {
    approved: boolean;
    userNotes?: string;
    totalTokenBudget?: number;
    agentBudgetOverrides?: Record<string, number>;
  }
): { plan: GovernancePlan; writes: MongoWrite[] } {
  const approvedAt = now();
  const totalTokenBudget = options.totalTokenBudget ?? plan.totalTokenBudget;
  const agents = plan.agents.map((agent) => ({
    ...agent,
    tokenBudget: options.agentBudgetOverrides?.[agent.agentId] ?? agent.tokenBudget
  }));
  const updated: GovernancePlan = {
    ...plan,
    status: options.approved ? "approved" : "revisions_requested",
    totalTokenBudget,
    agents,
    budgetPolicy: {
      ...plan.budgetPolicy,
      managerReserve: Math.round(totalTokenBudget * 0.07),
      summarizerReserve: Math.round(totalTokenBudget * 0.07)
    },
    approvedAt: options.approved ? approvedAt : undefined,
    userNotes: options.userNotes
  };

  return {
    plan: updated,
    writes: [
      {
        collection: "governance_plans",
        operation: "updateOne",
        filter: { _id: plan.id },
        update: {
          $set: {
            status: updated.status,
            total_token_budget: updated.totalTokenBudget,
            budget_policy: updated.budgetPolicy,
            agents: updated.agents,
            approved_at: updated.approvedAt ? new Date(updated.approvedAt) : undefined,
            user_notes: updated.userNotes
          }
        }
      },
      {
        collection: "audit",
        operation: "insertOne",
        document: {
          _id: `${plan.id}-audit-${updated.status}`,
          event_type: "governance_plan_decision",
          plan_id: plan.id,
          status: updated.status,
          user_notes: updated.userNotes,
          created_at: new Date(approvedAt)
        }
      }
    ]
  };
}

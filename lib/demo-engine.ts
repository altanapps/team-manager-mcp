import type {
  AgentProfile,
  AuditEvent,
  BlackboardEntry,
  CheckpointRecord,
  DemoState,
  MemoryCard,
  MongoDocEvent,
  MongoWrite,
  SubscriptionEvent,
  TimelineEvent,
  VoiceEvent
} from "./types";
import { createAgentProfiles, TASK_PROMPT, VENDOR_SOURCES } from "./demo-data";
import { fetchVendorSources, shortEvidence, sourceDocument } from "./live-sources";
import { cosineSimilarity, pseudoEmbedding, scoreAgents } from "./scoring";

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string, state: DemoState, nextStep = state.step): string {
  return `${state.runId}-${prefix}-${nextStep}`;
}

export function createInitialState(): DemoState {
  const createdAt = now();
  const runId = `run-${Date.now()}`;
  return {
    runId,
    taskId: `${runId}-task-vendor-eval`,
    groupId: `${runId}-group-team-manager`,
    teamId: "team-procurement",
    vendor: process.env.TEAM_MANAGER_VENDOR ?? process.env.NEXT_PUBLIC_DEMO_VENDOR ?? "PostHog",
    taskType: "vendor_evaluation",
    taskPrompt: TASK_PROMPT,
    status: "idle",
    step: 0,
    createdAt,
    updatedAt: createdAt,
    budget: {
      total: 50_000,
      consumed: 0,
      warnedAt70: false,
      summarizedAt90: false,
      summaryTokensSaved: 0,
      summaryReplacementTokens: 0,
      actionAt100: "abort"
    },
    candidates: createAgentProfiles(),
    selectedAgents: [],
    blackboard: [],
    memoryCards: [],
    subscriptions: [],
    audit: [],
    checkpoints: [],
    timeline: [
      {
        id: `${runId}-timeline-ready`,
        label: "Ready",
        detail: "Atlas collections are the control plane: profiles, tasks, groups, blackboard, memory, performance, and audit.",
        layer: "L1",
        createdAt
      }
    ],
    voiceEvents: [],
    mongoDocs: [],
    sources: VENDOR_SOURCES.map((source) => ({ ...source, status: "pending" })),
    mongo: {
      mode: "unknown",
      dbName: process.env.TEAM_MANAGER_DB ?? process.env.BOARDROOM_DB ?? "team_manager"
    }
  };
}

function pushMongoEvent(state: DemoState, collection: string, operation: MongoDocEvent["operation"], document: Record<string, unknown>) {
  state.mongoDocs = [
    {
      id: id(`mongo-${collection}-${operation}`, state, state.mongoDocs.length + state.step + 1),
      collection,
      operation,
      document,
      createdAt: now()
    },
    ...state.mongoDocs
  ].slice(0, 18);
}

function timeline(
  state: DemoState,
  layer: TimelineEvent["layer"],
  label: string,
  detail: string,
  writes: MongoWrite[] = []
) {
  const event: TimelineEvent = {
    id: id(`timeline-${layer}`, state, state.timeline.length + state.step + 1),
    layer,
    label,
    detail,
    createdAt: now()
  };
  state.timeline = [event, ...state.timeline].slice(0, 24);
  writes.push({
    collection: "audit",
    operation: "insertOne",
    document: {
      _id: event.id,
      demo_run_id: state.runId,
      task_id: state.taskId,
      event_type: "timeline",
      layer,
      label,
      detail,
      created_at: event.createdAt
    }
  });
  pushMongoEvent(state, "audit", "insertOne", { layer, label, detail });
}

function voice(state: DemoState, text: string) {
  const event: VoiceEvent = {
    id: id("voice", state, state.voiceEvents.length + state.step + 1),
    text,
    createdAt: now()
  };
  state.voiceEvents = [...state.voiceEvents, event];
}

function setAgent(state: DemoState, agentId: string, patch: Partial<AgentProfile>) {
  state.selectedAgents = state.selectedAgents.map((agent) => (agent.agentId === agentId ? { ...agent, ...patch } : agent));
  state.candidates = state.candidates.map((agent) => (agent.agentId === agentId ? { ...agent, ...patch } : agent));
}

function updateBudget(state: DemoState, consumed: number, writes: MongoWrite[]) {
  state.budget.consumed = Math.max(0, Math.min(state.budget.total, consumed));
  writes.push({
    collection: "tasks",
    operation: "updateOne",
    filter: { _id: state.taskId },
    update: {
      $set: {
        tokens_consumed: state.budget.consumed,
        budget_state: state.budget,
        status: state.status,
        updated_at: now()
      }
    }
  });
  writes.push({
    collection: "groups",
    operation: "updateOne",
    filter: { _id: state.groupId },
    update: {
      $set: {
        tokens_consumed: state.budget.consumed,
        updated_at: now()
      }
    }
  });
  pushMongoEvent(state, "tasks", "updateOne", {
    task_id: state.taskId,
    tokens_consumed: state.budget.consumed,
    total_token_budget: state.budget.total
  });
}

function blackboard(
  state: DemoState,
  agent: AgentProfile,
  entryType: BlackboardEntry["entryType"],
  visibility: BlackboardEntry["visibility"],
  content: string,
  sourceIds: string[],
  writes: MongoWrite[],
  reuseCount = 1,
  promoted = visibility !== "private"
): BlackboardEntry {
  const createdAt = now();
  const entry: BlackboardEntry = {
    id: id(`bb-${agent.agentId}`, state, state.blackboard.length + state.step + 1),
    taskId: state.taskId,
    entryType,
    visibility,
    agentId: agent.agentId,
    agentName: agent.name,
    content,
    sourceIds,
    contentEmbedding: pseudoEmbedding(content),
    reactions: [],
    createdAt,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 4).toISOString(),
    promoted,
    reuseCount
  };

  state.blackboard = [entry, ...state.blackboard].slice(0, 30);
  writes.push({
    collection: "blackboard_entries",
    operation: "insertOne",
    document: {
      _id: entry.id,
      demo_run_id: state.runId,
      task_id: entry.taskId,
      entry_type: entry.entryType,
      visibility: entry.visibility,
      agent_id: entry.agentId,
      agent_name: entry.agentName,
      content: entry.content,
      source_ids: entry.sourceIds,
      content_embedding: entry.contentEmbedding,
      reactions: entry.reactions,
      expires_at: new Date(entry.expiresAt),
      promoted: entry.promoted,
      reuse_count: entry.reuseCount,
      created_at: new Date(entry.createdAt)
    }
  });
  pushMongoEvent(state, "blackboard_entries", "insertOne", {
    entry_type: entry.entryType,
    visibility: entry.visibility,
    agent_name: entry.agentName,
    content: entry.content.slice(0, 120)
  });

  return entry;
}

function memory(
  state: DemoState,
  ownerAgentId: string,
  visibility: MemoryCard["visibility"],
  content: string,
  reuseCount: number,
  writes: MongoWrite[],
  sourceEntryId?: string
): MemoryCard {
  const card: MemoryCard = {
    id: id(`memory-${ownerAgentId}`, state, state.memoryCards.length + state.step + 1),
    taskId: state.taskId,
    ownerAgentId,
    teamId: state.teamId,
    visibility,
    content,
    embedding: pseudoEmbedding(content),
    reuseCount,
    promotedAt: visibility === "team" || visibility === "global" ? now() : undefined,
    sourceEntryId
  };

  state.memoryCards = [card, ...state.memoryCards].slice(0, 18);
  writes.push({
    collection: "memory_cards",
    operation: "insertOne",
    document: {
      _id: card.id,
      demo_run_id: state.runId,
      task_id: card.taskId,
      owner_agent_id: card.ownerAgentId,
      team_id: card.teamId,
      visibility: card.visibility,
      content: card.content,
      embedding: card.embedding,
      reuse_count: card.reuseCount,
      promoted_at: card.promotedAt ? new Date(card.promotedAt) : undefined,
      source_entry_id: card.sourceEntryId,
      created_at: new Date()
    }
  });
  pushMongoEvent(state, "memory_cards", "insertOne", {
    visibility: card.visibility,
    owner_agent_id: card.ownerAgentId,
    reuse_count: card.reuseCount,
    content: card.content.slice(0, 110)
  });

  return card;
}

function subscribe(
  state: DemoState,
  entry: BlackboardEntry,
  fromAgentId: string,
  toAgent: AgentProfile,
  reason: string,
  writes: MongoWrite[]
) {
  const score = cosineSimilarity(entry.contentEmbedding, toAgent.descriptionEmbedding);
  const event: SubscriptionEvent = {
    id: id(`subscription-${toAgent.agentId}`, state, state.subscriptions.length + state.step + 1),
    entryId: entry.id,
    fromAgentId,
    toAgentId: toAgent.agentId,
    toAgentName: toAgent.name,
    reason,
    vectorScore: Number(score.toFixed(3)),
    createdAt: now()
  };
  state.subscriptions = [event, ...state.subscriptions].slice(0, 12);
  writes.push({
    collection: "audit",
    operation: "insertOne",
    document: {
      _id: event.id,
      demo_run_id: state.runId,
      task_id: state.taskId,
      event_type: "blackboard_subscription",
      entry_id: entry.id,
      from_agent_id: fromAgentId,
      to_agent_id: toAgent.agentId,
      reason,
      vector_score: event.vectorScore,
      created_at: new Date(event.createdAt)
    }
  });
  pushMongoEvent(state, "audit", "insertOne", {
    event_type: "change_stream_subscription",
    entry_id: entry.id,
    to_agent: toAgent.name,
    vector_score: event.vectorScore
  });
}

function checkpoint(
  state: DemoState,
  agent: AgentProfile,
  stepIndex: number,
  outcome: CheckpointRecord["outcome"],
  partialOutput: string,
  writes: MongoWrite[],
  pendingToolCalls: string[] = []
) {
  const record: CheckpointRecord = {
    id: id(`checkpoint-${agent.agentId}`, state, state.checkpoints.length + state.step + 1),
    taskId: state.taskId,
    agentId: agent.agentId,
    agentName: agent.name,
    stepIndex,
    pendingToolCalls,
    partialOutput,
    mongoChangeStreamResumeToken: `resume-token-${state.step}-${agent.agentId}`,
    startedAt: now(),
    tokensInput: 1800 + state.step * 310,
    tokensOutput: 550 + state.step * 90,
    outcome
  };
  state.checkpoints = [record, ...state.checkpoints].slice(0, 18);
  writes.push({
    collection: "agent_performance_records",
    operation: "insertOne",
    document: {
      _id: record.id,
      demo_run_id: state.runId,
      task_id: record.taskId,
      agent_id: record.agentId,
      agent_name: record.agentName,
      task_type: state.taskType,
      step_index: record.stepIndex,
      pending_tool_calls: record.pendingToolCalls,
      partial_output: record.partialOutput,
      mongo_change_stream_resume_token: record.mongoChangeStreamResumeToken,
      started_at: new Date(record.startedAt),
      tokens_input: record.tokensInput,
      tokens_output: record.tokensOutput,
      tokens_total: record.tokensInput + record.tokensOutput,
      duration_ms: 25_000 + state.step * 3500,
      outcome: record.outcome
    }
  });
  pushMongoEvent(state, "agent_performance_records", "insertOne", {
    agent_name: record.agentName,
    step_index: record.stepIndex,
    outcome: record.outcome,
    resume_token: record.mongoChangeStreamResumeToken
  });
}

function audit(
  state: DemoState,
  agent: AgentProfile,
  claim: string,
  entry: BlackboardEntry,
  confidence: number,
  writes: MongoWrite[]
) {
  const event: AuditEvent = {
    id: id(`audit-${agent.agentId}`, state, state.audit.length + state.step + 1),
    taskId: state.taskId,
    claim,
    agentId: agent.agentId,
    agentName: agent.name,
    blackboardEntryId: entry.id,
    sourceIds: entry.sourceIds,
    confidence,
    createdAt: now()
  };

  state.audit = [event, ...state.audit].slice(0, 20);
  writes.push({
    collection: "audit",
    operation: "insertOne",
    document: {
      _id: event.id,
      demo_run_id: state.runId,
      task_id: state.taskId,
      claim: event.claim,
      agent_id: event.agentId,
      agent_name: event.agentName,
      blackboard_entry_id: event.blackboardEntryId,
      source_ids: event.sourceIds,
      confidence: event.confidence,
      created_at: new Date(event.createdAt)
    }
  });
  pushMongoEvent(state, "audit", "insertOne", {
    claim: event.claim,
    blackboard_entry_id: event.blackboardEntryId,
    source_ids: event.sourceIds
  });
}

function getSelected(state: DemoState, agentId: string): AgentProfile {
  const agent = state.selectedAgents.find((candidate) => candidate.agentId === agentId);
  if (!agent) {
    throw new Error(`Selected agent not found: ${agentId}`);
  }
  return agent;
}

function source(state: DemoState, sourceId: string) {
  return state.sources.find((item) => item.id === sourceId);
}

export async function ingestLiveSources(state: DemoState): Promise<{ state: DemoState; writes: MongoWrite[] }> {
  const working = structuredClone(state) as DemoState;
  const writes: MongoWrite[] = [];

  const fetched = await fetchVendorSources(working.sources);
  working.sources = fetched;
  working.updatedAt = now();

  writes.push({
    collection: "source_documents",
    operation: "insertMany",
    documents: fetched.map((item) => sourceDocument(item, working.runId, working.taskId))
  });

  for (const item of fetched) {
    pushMongoEvent(working, "source_documents", "insertOne", {
      source_id: item.id,
      status: item.status,
      content_length: item.contentLength,
      evidence_labels: item.evidence.map((evidence) => evidence.label),
      text_hash: item.textHash
    });
  }

  const fetchedCount = fetched.filter((item) => item.status === "fetched").length;
  const evidenceCount = fetched.reduce((sum, item) => sum + item.evidence.length, 0);
  timeline(
    working,
    "L3",
    "Live source ingestion",
    `Fetched ${fetchedCount}/${fetched.length} public vendor pages and extracted ${evidenceCount} evidence snippets into source_documents.`,
    writes
  );

  return { state: working, writes };
}

export function spawnTeamRoom(state: DemoState): { state: DemoState; writes: MongoWrite[] } {
  const working = structuredClone(state) as DemoState;
  const writes: MongoWrite[] = [];
  if (working.governancePlan?.status === "approved") {
    working.budget.total = working.governancePlan.totalTokenBudget;
    working.budget.actionAt100 = working.governancePlan.budgetPolicy.hardStopAction;
  }
  const ranked = scoreAgents(working.taskPrompt, working.taskType, working.candidates);
  const selectedIds = new Set(ranked.slice(0, 5).map((agent) => agent.agentId));

  working.candidates = ranked.map((agent) => ({
    ...agent,
    selected: selectedIds.has(agent.agentId),
    status: selectedIds.has(agent.agentId) ? "selected" : "candidate",
    currentStep: selectedIds.has(agent.agentId) ? "Dispatched by capability formula" : "Not selected"
  }));
  working.selectedAgents = working.candidates.filter((agent) => agent.selected);
  working.status = "dispatched";
  working.updatedAt = now();

  writes.push({
    collection: "agent_profiles",
    operation: "insertMany",
    documents: working.candidates.map((agent) => ({
      _id: agent.agentId,
      demo_run_id: working.runId,
      agent_id: agent.agentId,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      skills: agent.skills,
      capabilities: agent.capabilities,
      description_embedding: agent.descriptionEmbedding,
      proven_skills: agent.provenSkills,
      avg_duration_ms: agent.avgDurationMs,
      token_efficiency: agent.tokenEfficiency,
      last_performed_at: new Date(agent.lastPerformedAt),
      score: agent.score,
      selected: agent.selected,
      created_at: new Date()
    }))
  });
  pushMongoEvent(working, "agent_profiles", "insertMany", {
    count: working.candidates.length,
    selected_agents: working.selectedAgents.map((agent) => agent.name)
  });

  writes.push({
    collection: "tasks",
    operation: "insertOne",
    document: {
      _id: working.taskId,
      demo_run_id: working.runId,
      task_type: working.taskType,
      prompt: working.taskPrompt,
      status: working.status,
      token_budget: working.budget.total,
      tokens_consumed: working.budget.consumed,
      governance_plan_id: working.governancePlan?.id,
      agent_token_budgets: Object.fromEntries((working.governancePlan?.agents ?? []).map((agent) => [agent.agentId, agent.tokenBudget])),
      group_id: working.groupId,
      agents_assigned: working.selectedAgents.map((agent) => agent.agentId),
      checkpoint: null,
      created_at: new Date(working.createdAt),
      updated_at: new Date(working.updatedAt)
    }
  });
  writes.push({
    collection: "groups",
    operation: "insertOne",
    document: {
      _id: working.groupId,
      demo_run_id: working.runId,
      team_id: working.teamId,
      total_token_budget: working.budget.total,
      tokens_consumed: working.budget.consumed,
      governance_plan_id: working.governancePlan?.id,
      manager_reserve: working.governancePlan?.budgetPolicy.managerReserve,
      summarizer_reserve: working.governancePlan?.budgetPolicy.summarizerReserve,
      members: working.selectedAgents.map((agent) => agent.agentId),
      created_at: new Date()
    }
  });
  pushMongoEvent(working, "tasks", "insertOne", {
    task_id: working.taskId,
    token_budget: working.budget.total,
    agents_assigned: working.selectedAgents.map((agent) => agent.name)
  });

  timeline(
    working,
    "L1",
    "Capability dispatch",
    "$vectorSearch ranked 12 A2A-style agent profiles; history, recency, latency, and token efficiency selected the top 5.",
    writes
  );
  updateBudget(working, 3200, writes);

  return { state: working, writes };
}

export function advanceDemo(state: DemoState): { state: DemoState; writes: MongoWrite[] } {
  const working = structuredClone(state) as DemoState;
  const writes: MongoWrite[] = [];

  if (working.selectedAgents.length === 0) {
    return spawnTeamRoom(working);
  }

  working.step += 1;
  working.status = "running";
  working.updatedAt = now();

  const security = getSelected(working, "agent-security");
  const pricing = getSelected(working, "agent-pricing");
  const references = getSelected(working, "agent-references");
  const integration = getSelected(working, "agent-integration");
  const contracts = getSelected(working, "agent-contracts");

  if (working.step === 1) {
    working.selectedAgents.forEach((agent) =>
      setAgent(working, agent.agentId, {
        status: "running",
        currentStep: "Reading live source_documents and checking blackboard relevance",
        tokensUsed: 1700
      })
    );
    updateBudget(working, 12_400, writes);
    const pricingSource = source(working, "src-posthog-pricing");
    const pricingSnippet = shortEvidence(pricingSource, "billing_limits");
    const entry = blackboard(
      working,
      pricing,
      "discovery",
      "team",
      `Live pricing page evidence: "${pricingSnippet}" PricingAnalyst recommends configuring billing limits before rollout.`,
      ["src-posthog-pricing"],
      writes
    );
    audit(working, pricing, "Usage-based pricing needs a spend cap before production rollout.", entry, 0.87, writes);
    checkpoint(working, pricing, 1, "checkpoint", "Pricing model extracted; modeling growth scenario.", writes, ["model_growth_events"]);
    timeline(working, "L2", "Blackboard opens", "PricingAnalyst posted a team-visible finding derived from the fetched pricing page.", writes);
  }

  if (working.step === 2) {
    updateBudget(working, 24_100, writes);
    setAgent(working, security.agentId, {
      status: "running",
      currentStep: "Checking trust portal and compliance document access",
      tokensUsed: 3900
    });
    setAgent(working, contracts.agentId, {
      status: "running",
      currentStep: "Watching change stream for compliance-risk entries",
      tokensUsed: 3400
    });

    const trustSource = source(working, "src-posthog-trust");
    const soc2Snippet = shortEvidence(trustSource, "soc2_type_ii");
    const accessSnippet = shortEvidence(trustSource, "report_access", 170);
    const entry = blackboard(
      working,
      security,
      "discovery",
      "team",
      `Live Trust Center evidence: "${soc2Snippet}" Report access signal: "${accessSnippet}" SecurityReview asks procurement to verify current report scope.`,
      ["src-posthog-trust"],
      writes,
      2
    );
    audit(working, security, "SOC 2 Type II evidence exists but must be obtained and scoped.", entry, 0.91, writes);
    subscribe(
      working,
      entry,
      security.agentId,
      contracts,
      "ContractRedFlags matched compliance evidence with legal approval blockers through change stream plus vector relevance.",
      writes
    );
    checkpoint(working, security, 2, "checkpoint", "SOC 2 Type II coverage found; current report access still pending.", writes, [
      "request_soc2_scope"
    ]);
    timeline(
      working,
      "L2",
      "Auto-subscribe fired",
      "SecurityReview wrote a compliance discovery; ContractRedFlags pulled it without a direct prompt.",
      writes
    );
  }

  if (working.step === 3) {
    updateBudget(working, 36_300, writes);
    working.status = "warning";
    working.budget.warnedAt70 = true;
    working.selectedAgents.forEach((agent) =>
      setAgent(working, agent.agentId, {
        currentStep: "70 percent budget warning injected; compressing next message"
      })
    );

    const productSource = source(working, "src-posthog-product");
    const integrationSnippet = shortEvidence(productSource, "integrations");
    const apiSnippet = shortEvidence(productSource, "api_webhooks", 150);
    const entry = blackboard(
      working,
      integration,
      "progress",
      "team",
      `Live product page evidence: "${integrationSnippet}" API signal: "${apiSnippet}" IntegrationFit marks implementation risk as manageable.`,
      ["src-posthog-product"],
      writes
    );
    audit(working, integration, "Integration surface looks broad enough for an engineering-led analytics rollout.", entry, 0.8, writes);
    memory(
      working,
      security.agentId,
      "private",
      "Compliance artifact access is the likely procurement gate; keep private until another agent cites it.",
      1,
      writes,
      working.blackboard.find((item) => item.agentId === security.agentId)?.id
    );
    voice(working, "Token budget at 70 percent. Warning injected into all specialist agents.");
    checkpoint(working, integration, 3, "checkpoint", "Integration evidence posted; waiting on legal gate.", writes);
    timeline(working, "L4", "70 percent budget warning", "The group budget crossed 70 percent; Team Manager injected a warning into every next context.", writes);
  }

  if (working.step === 4) {
    updateBudget(working, 46_800, writes);
    working.status = "summarizing";
    working.budget.summarizedAt90 = true;
    working.budget.summaryTokensSaved = 8000;
    working.budget.summaryReplacementTokens = 1500;

    const summaryAgent: AgentProfile = {
      agentId: "agent-summarizer",
      name: "BudgetSummarizer",
      role: "Context compression agent",
      description: "Compresses active blackboard and agent context when the group token budget crosses 90 percent.",
      skills: ["context_compression", "memory_promotion", "budget_governance"],
      capabilities: ["read_blackboard", "write_memory", "evict_context"],
      descriptionEmbedding: pseudoEmbedding("context compression memory summarizer token budget governance"),
      provenSkills: {},
      avgDurationMs: 18_000,
      tokenEfficiency: 0.95,
      lastPerformedAt: now(),
      status: "summarizer",
      selected: true,
      tokensUsed: 1500,
      currentStep: "Spawned automatically at 90 percent budget"
    };
    working.selectedAgents = [summaryAgent, ...working.selectedAgents];

    const content =
      `Team summary from live sources: ${shortEvidence(source(working, "src-posthog-pricing"), "billing_limits", 120)} ${shortEvidence(source(working, "src-posthog-trust"), "soc2_type_ii", 120)} ${shortEvidence(source(working, "src-posthog-product"), "api_webhooks", 120)}`;
    const card = memory(working, "agent-summarizer", "team", content, 3, writes);
    const summaryEntry = blackboard(
      working,
      summaryAgent,
      "warning",
      "team",
      "BudgetSummarizer replaced roughly 8K tokens of active context with a 1.5K team memory card.",
      [],
      writes,
      3
    );
    audit(working, summaryAgent, "Context was compacted before overrun while preserving source-linked claims.", summaryEntry, 0.93, writes);
    updateBudget(working, 38_500, writes);
    voice(working, "Token budget at 90 percent. Spawning summarizer.");
    checkpoint(working, summaryAgent, 4, "success", `Wrote memory card ${card.id} and evicted old context.`, writes);
    timeline(
      working,
      "L3",
      "Layered memory promotion",
      "A summary reused by 3 agents was promoted to team visibility through the filtered memory index.",
      writes
    );
  }

  if (working.step === 5) {
    return killContractAgent(working);
  }

  if (working.step === 6) {
    return restartContractAgent(working);
  }

  if (working.step >= 7) {
    updateBudget(working, 45_700, writes);
    working.status = "complete";
    const entry = blackboard(
      working,
      contracts,
      "decision",
      "team",
      `Hold: live sources support the vendor's security and integration posture, but procurement must verify report scope and set spend guardrails. Evidence: "${shortEvidence(source(working, "src-posthog-trust"), "report_access", 140)}" and "${shortEvidence(source(working, "src-posthog-pricing"), "billing_limits", 140)}"`,
      ["src-posthog-trust", "src-posthog-pricing", "src-posthog-product"],
      writes,
      4
    );
    audit(working, contracts, "Final recommendation is hold pending evidence and spend guardrails.", entry, 0.81, writes);
    checkpoint(working, contracts, 7, "success", "Final legal gate merged with security and pricing findings.", writes);
    setAgent(working, contracts.agentId, {
      status: "complete",
      currentStep: "Final decision emitted from checkpointed context"
    });
    setAgent(working, security.agentId, { status: "complete", currentStep: "Vote: hold until SOC 2 report scope verified" });
    setAgent(working, pricing.agentId, { status: "complete", currentStep: "Vote: hold until billing limits configured" });
    setAgent(working, references.agentId, { status: "complete", currentStep: "Vote: buy with procurement gates" });
    setAgent(working, integration.agentId, { status: "complete", currentStep: "Vote: buy with implementation plan" });
    working.finalDecision = {
      verdict: "Hold",
      confidence: 0.81,
      rationale:
        "4 of 5 specialists support moving forward only after evidence and guardrails: obtain the SOC 2 Type II report, confirm scope, configure billing limits, and attach data-processing terms.",
      votes: {
        SecurityReview: "hold",
        PricingAnalyst: "hold",
        ReferenceChecker: "buy",
        IntegrationFit: "buy",
        ContractRedFlags: "hold"
      }
    };
    voice(working, "Decision rendered. Hold pending SOC 2 Type II scope and billing limits. Confidence 0.81.");
    timeline(
      working,
      "decision",
      "Decision rendered",
      "Final audit graph links every claim to a blackboard entry and public source.",
      writes
    );
  }

  return { state: working, writes };
}

export function killContractAgent(state: DemoState): { state: DemoState; writes: MongoWrite[] } {
  const working = structuredClone(state) as DemoState;
  const writes: MongoWrite[] = [];
  const contracts = getSelected(working, "agent-contracts");

  working.step = Math.max(working.step, 5);
  working.status = "agent_killed";
  working.updatedAt = now();
  setAgent(working, contracts.agentId, {
    status: "killed",
    currentStep: "Process killed mid-claim after checkpoint write",
    tokensUsed: Math.max(contracts.tokensUsed, 6100)
  });
  updateBudget(working, Math.max(working.budget.consumed, 40_900), writes);
  checkpoint(
    working,
    contracts,
    5,
    "killed",
    "Drafting contract gate: require SOC 2 Type II scope, DPA confirmation, and billing limit schedule...",
    writes,
    ["merge_security_discovery", "draft_contract_gate"]
  );
  timeline(
    working,
    "resume",
    "ContractRedFlags killed",
    "A checkpoint and Mongo change-stream resume token were already stored in agent_performance_records.",
    writes
  );

  return { state: working, writes };
}

export function restartContractAgent(state: DemoState): { state: DemoState; writes: MongoWrite[] } {
  const working = structuredClone(state) as DemoState;
  const writes: MongoWrite[] = [];
  const contracts = getSelected(working, "agent-contracts");

  working.step = Math.max(working.step, 6);
  working.status = "resumed";
  working.updatedAt = now();
  setAgent(working, contracts.agentId, {
    status: "resumed",
    currentStep: "Resumed from latest MongoDB checkpoint; continuing same claim",
    tokensUsed: Math.max(contracts.tokensUsed, 6900)
  });
  updateBudget(working, Math.max(working.budget.consumed, 42_600), writes);
  checkpoint(
    working,
    contracts,
    6,
    "resumed",
    "Loaded checkpoint and continuing contract gate from partial output.",
    writes,
    ["complete_contract_gate"]
  );
  timeline(
    working,
    "resume",
    "Checkpoint resume",
    "Restart read the latest checkpoint from MongoDB and kept the blackboard state intact.",
    writes
  );

  return { state: working, writes };
}

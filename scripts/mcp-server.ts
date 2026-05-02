import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnTeamRoom } from "../lib/demo-engine";
import { getDemoState, resetDemoState, setDemoState } from "../lib/demo-store";
import { approveGovernancePlan, buildGovernancePlan, governancePlanWrites } from "../lib/governance-plan";
import { applyMongoWrites, closeMongoClient, resetMongoDemo } from "../lib/mongo";
import { fetchSources, sourceDocument } from "../lib/live-sources";
import { brightDataAvailable, searchWithBrightData } from "../lib/brightdata-mcp";
import { classifyTaskType, cosineSimilarity, pseudoEmbedding } from "../lib/scoring";
import type {
  AuditEvent,
  BlackboardEntry,
  CheckpointRecord,
  DemoState,
  MemoryCard,
  MongoWrite,
  SourceRef,
  Visibility
} from "../lib/types";

function logEvent(event: string, fields: Record<string, unknown> = {}) {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  console.error(`[team-manager] ${event}${rendered ? ` ${rendered}` : ""}`);
}

function compactState(state: DemoState) {
  return {
    runId: state.runId,
    taskId: state.taskId,
    status: state.status,
    mongo: state.mongo,
    target: state.target,
    selectedAgents: state.selectedAgents
      .filter((agent) => agent.agentId !== "agent-summarizer")
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        status: agent.status,
        score: agent.score,
        currentStep: agent.currentStep
      })),
    sources: state.sources.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      status: source.status,
      contentLength: source.contentLength ?? 0,
      evidenceCount: source.evidence?.length ?? 0,
      extractionProvider: source.extractionProvider ?? "pending"
    })),
    budget: state.budget,
    governancePlan: state.governancePlan
      ? {
          id: state.governancePlan.id,
          status: state.governancePlan.status,
          collaborationMode: state.governancePlan.collaborationMode,
          totalTokenBudget: state.governancePlan.totalTokenBudget,
          budgetEstimate: state.governancePlan.budgetEstimate,
          routingStages: state.governancePlan.routingCascade.map((stage) => stage.stage),
          agents: state.governancePlan.agents.map((agent) => ({
            agentId: agent.agentId,
            name: agent.name,
            priority: agent.priority,
            tokenBudget: agent.tokenBudget,
            model: agent.model.model
          }))
        }
      : null,
    blackboardEntries: state.blackboard.length,
    checkpoints: state.checkpoints.length,
    subscriptions: state.subscriptions.length,
    decision: state.finalDecision
  };
}

function toolJson(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function toolError(toolName: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logEvent("tool.error", { tool: toolName, message, stack });
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: message,
            tool: toolName,
            hint: "Team Manager tool threw before completion. Check the server stderr for the stack trace, then retry or call team_manager_state to inspect current room state."
          },
          null,
          2
        )
      }
    ]
  };
}

async function applyAndStore(state: DemoState, writes: MongoWrite[]) {
  await applyMongoWrites(state, writes);
  setDemoState(state);
  return state;
}

function now(): string {
  return new Date().toISOString();
}

function stableId(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function scopedId(state: DemoState, prefix: string, input = ""): string {
  return `${state.runId}-${prefix}-${stableId(`${Date.now()}-${input}`)}`;
}

function agentName(state: DemoState, agentId: string): string {
  return (
    state.selectedAgents.find((agent) => agent.agentId === agentId)?.name ??
    state.candidates.find((agent) => agent.agentId === agentId)?.name ??
    agentId
  );
}

function updateAgentStatus(state: DemoState, agentId: string, patch: { status?: DemoState["selectedAgents"][number]["status"]; currentStep?: string }) {
  state.selectedAgents = state.selectedAgents.map((agent) => (agent.agentId === agentId ? { ...agent, ...patch } : agent));
  state.candidates = state.candidates.map((agent) => (agent.agentId === agentId ? { ...agent, ...patch } : agent));
}

function sourceRefsFromInput(sources: Array<{ url: string; title?: string; note?: string; extractedText?: string }>): SourceRef[] {
  return sources.map((source, index) => ({
    id: `src-user-${index + 1}-${stableId(source.url).slice(0, 8)}`,
    title: source.title ?? new URL(source.url).hostname,
    url: source.url,
    note: source.note ?? "User-provided source for this Team Manager run.",
    status: "pending",
    providedText: source.extractedText,
    extractionProvider: source.extractedText ? "provided_text" : "pending"
  }));
}

async function writeAuditEvent(state: DemoState, event: Record<string, unknown>) {
  await applyAndStore(state, [
    {
      collection: "audit",
      operation: "insertOne",
      document: {
        _id: scopedId(state, "audit-event", JSON.stringify(event)),
        task_id: state.taskId,
        created_at: new Date(),
        ...event
      }
    }
  ]);
}

async function persistTaskState(state: DemoState) {
  await applyAndStore(state, [
    {
      collection: "tasks",
      operation: "updateOne",
      filter: { _id: state.taskId },
      update: {
        $set: {
          status: state.status,
          tokens_consumed: state.budget.consumed,
          token_budget: state.budget.total,
          budget_state: state.budget,
          updated_at: new Date()
        }
      }
    },
    {
      collection: "groups",
      operation: "updateOne",
      filter: { _id: state.groupId },
      update: {
        $set: {
          tokens_consumed: state.budget.consumed,
          updated_at: new Date()
        }
      }
    }
  ]);
}

const server = new McpServer({
  name: "team-manager",
  version: "0.1.0"
});

// Wrap every registered tool handler so unhandled throws from MongoDB,
// Bright Data, or downstream helpers surface as MCP error responses
// instead of crashing the stdio server.
type AnyHandler = (...args: unknown[]) => Promise<unknown>;
const __originalRegisterTool = server.registerTool.bind(server);
(server as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
  name: unknown,
  config: unknown,
  handler: unknown
) => {
  const safeHandler = (async (...args: unknown[]) => {
    try {
      return await (handler as AnyHandler)(...args);
    } catch (error) {
      return toolError(String(name), error);
    }
  }) as AnyHandler;
  // The MCP SDK's overloads don't model dynamic interception; cast to bypass.
  return (__originalRegisterTool as unknown as (
    n: unknown,
    c: unknown,
    h: unknown
  ) => unknown)(name, config, safeHandler);
};

server.registerTool(
  "team_manager_plan_room",
  {
    title: "Plan Agent Team",
    description:
      "Act as the Team Manager: propose measurement weights, agent roster, execution profiles, memory policy, task-estimated token budgets, and questions for the human before any agents start.",
    inputSchema: {
      request: z
        .string()
        .default("I want to evaluate an important decision in the most efficient way.")
        .describe("The user's high-level work request."),
      target: z.string().default("custom").describe("Target entity, topic, decision, or workstream."),
      tokenBudget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional manual group token budget override. Omit this so Team Manager estimates budget from the task."),
      reset: z.boolean().default(true).describe("Reset the current room before proposing a new plan.")
    }
  },
  async ({ request, target, tokenBudget, reset }) => {
    let state = reset ? resetDemoState() : getDemoState();
    if (reset) {
      await resetMongoDemo(state);
    }

    state.target = target;
    state.taskPrompt = request;
    state.taskType = classifyTaskType(request);
    const plan = buildGovernancePlan({
      runId: state.runId,
      request,
      target,
      taskType: state.taskType,
      candidates: state.candidates,
      totalTokenBudget: tokenBudget
    });
    state.budget.total = plan.totalTokenBudget;
    state.governancePlan = plan;
    state = await applyAndStore(state, governancePlanWrites(plan));
    logEvent("manager.plan.proposed", {
      planId: plan.id,
      tokenBudget: plan.totalTokenBudget,
      budgetMode: tokenBudget ? "manual_override" : "task_estimated",
      questions: plan.teamManager.questionsForUser,
      agents: plan.agents.map((agent) => ({
        name: agent.name,
        tokenBudget: agent.tokenBudget,
        model: agent.model.model,
        priority: agent.priority
      }))
    });

    return toolJson({
      message: "Team Manager proposed a room plan and is waiting for human approval or edits.",
      requiresUserApproval: true,
      nextTool: "team_manager_approve_plan",
      proposedPlan: plan
    });
  }
);

server.registerTool(
  "team_manager_kill_agent",
  {
    title: "Record Agent Failure",
    description:
      "Record that the MCP host killed or lost an agent after checkpoint persistence. This updates MongoDB state; it does not kill an OS process.",
    inputSchema: {
      agentId: z.string().describe("Agent id to mark failed or killed."),
      reason: z.string().default("Host reported agent interruption."),
      stepIndex: z.number().int().nonnegative().optional(),
      partialOutput: z.string().default(""),
      pendingToolCalls: z.array(z.string()).default([])
    }
  },
  async ({ agentId, reason, stepIndex, partialOutput, pendingToolCalls }) => {
    const state = getDemoState();
    const latest = state.checkpoints.find((checkpoint) => checkpoint.agentId === agentId);
    const checkpoint: CheckpointRecord = {
      id: scopedId(state, "checkpoint-killed", `${agentId}-${reason}`),
      taskId: state.taskId,
      agentId,
      agentName: agentName(state, agentId),
      stepIndex: stepIndex ?? latest?.stepIndex ?? 0,
      pendingToolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : latest?.pendingToolCalls ?? [],
      partialOutput: partialOutput || latest?.partialOutput || reason,
      mongoChangeStreamResumeToken: latest?.mongoChangeStreamResumeToken ?? `resume-token-${state.runId}-${agentId}-killed`,
      startedAt: now(),
      tokensInput: 0,
      tokensOutput: 0,
      outcome: "killed"
    };
    state.status = "agent_killed";
    state.checkpoints = [checkpoint, ...state.checkpoints].slice(0, 50);
    updateAgentStatus(state, agentId, {
      status: "killed",
      currentStep: `Interrupted by host: ${reason}`
    });
    await applyAndStore(state, [
      {
        collection: "agent_performance_records",
        operation: "insertOne",
        document: {
          _id: checkpoint.id,
          task_id: checkpoint.taskId,
          agent_id: checkpoint.agentId,
          agent_name: checkpoint.agentName,
          task_type: state.taskType,
          step_index: checkpoint.stepIndex,
          pending_tool_calls: checkpoint.pendingToolCalls,
          partial_output: checkpoint.partialOutput,
          mongo_change_stream_resume_token: checkpoint.mongoChangeStreamResumeToken,
          started_at: new Date(checkpoint.startedAt),
          tokens_input: checkpoint.tokensInput,
          tokens_output: checkpoint.tokensOutput,
          tokens_total: 0,
          outcome: checkpoint.outcome,
          failure_reason: reason
        }
      },
      {
        collection: "tasks",
        operation: "updateOne",
        filter: { _id: state.taskId },
        update: {
          $set: {
            status: state.status,
            checkpoint,
            updated_at: new Date()
          }
        }
      },
      {
        collection: "audit",
        operation: "insertOne",
        document: {
          _id: scopedId(state, "audit-agent-killed", agentId),
          task_id: state.taskId,
          event_type: "agent_interrupted",
          agent_id: agentId,
          reason,
          checkpoint_id: checkpoint.id,
          created_at: new Date()
        }
      }
    ]);
    logEvent("agent.interrupted", {
      agent: checkpoint.agentName,
      checkpoint: checkpoint.mongoChangeStreamResumeToken,
      reason
    });

    return toolJson({
      message: "Agent interruption recorded. The host can resume from the returned checkpoint.",
      state: compactState(state),
      checkpoint
    });
  }
);

server.registerTool(
  "team_manager_resume_agent",
  {
    title: "Resume Agent From Checkpoint",
    description:
      "Return the latest checkpoint context for an agent and mark it resumed in MongoDB. The MCP host is responsible for restarting the actual worker.",
    inputSchema: {
      agentId: z.string().describe("Agent id to resume.")
    }
  },
  async ({ agentId }) => {
    const state = getDemoState();
    const latest = state.checkpoints.find((checkpoint) => checkpoint.agentId === agentId);
    if (!latest) {
      return toolJson({
        message: "No checkpoint exists for this agent. Call team_manager_record_checkpoint before resuming.",
        nextTool: "team_manager_record_checkpoint",
        agentId
      });
    }

    const resumed: CheckpointRecord = {
      ...latest,
      id: scopedId(state, "checkpoint-resumed", agentId),
      startedAt: now(),
      outcome: "resumed"
    };
    state.status = "resumed";
    state.checkpoints = [resumed, ...state.checkpoints].slice(0, 50);
    updateAgentStatus(state, agentId, {
      status: "resumed",
      currentStep: `Resumed from checkpoint step ${latest.stepIndex}`
    });
    await applyAndStore(state, [
      {
        collection: "agent_performance_records",
        operation: "insertOne",
        document: {
          _id: resumed.id,
          task_id: resumed.taskId,
          agent_id: resumed.agentId,
          agent_name: resumed.agentName,
          task_type: state.taskType,
          step_index: resumed.stepIndex,
          pending_tool_calls: resumed.pendingToolCalls,
          partial_output: resumed.partialOutput,
          mongo_change_stream_resume_token: resumed.mongoChangeStreamResumeToken,
          started_at: new Date(resumed.startedAt),
          tokens_input: resumed.tokensInput,
          tokens_output: resumed.tokensOutput,
          tokens_total: resumed.tokensInput + resumed.tokensOutput,
          outcome: resumed.outcome
        }
      },
      {
        collection: "tasks",
        operation: "updateOne",
        filter: { _id: state.taskId },
        update: {
          $set: {
            status: state.status,
            checkpoint: resumed,
            updated_at: new Date()
          }
        }
      },
      {
        collection: "audit",
        operation: "insertOne",
        document: {
          _id: scopedId(state, "audit-agent-resumed", agentId),
          task_id: state.taskId,
          event_type: "agent_resumed",
          agent_id: agentId,
          checkpoint_id: resumed.id,
          created_at: new Date()
        }
      }
    ]);
    logEvent("agent.resume", {
      agent: resumed.agentName,
      checkpoint: resumed.mongoChangeStreamResumeToken,
      status: state.status
    });

    return toolJson({
      message: "Agent marked resumed. Hand this checkpoint context to the restarted worker.",
      state: compactState(state),
      checkpoint: resumed,
      resumeContext: {
        taskId: resumed.taskId,
        agentId: resumed.agentId,
        stepIndex: resumed.stepIndex,
        pendingToolCalls: resumed.pendingToolCalls,
        partialOutput: resumed.partialOutput,
        mongoChangeStreamResumeToken: resumed.mongoChangeStreamResumeToken
      }
    });
  }
);

server.registerTool(
  "team_manager_approve_plan",
  {
    title: "Approve Agent Team Plan",
    description: "Approve or request revisions to the Team Manager plan before starting the governed agent room.",
    inputSchema: {
      approved: z.boolean().default(true).describe("Set false to record that the user requested revisions."),
      userNotes: z.string().optional().describe("Human feedback, constraints, or approval notes."),
      totalTokenBudget: z.number().int().positive().optional().describe("Optional replacement group token budget."),
      agentBudgetOverrides: z.record(z.number().int().positive()).optional().describe("Optional map of agent_id to token cap.")
    }
  },
  async ({ approved, userNotes, totalTokenBudget, agentBudgetOverrides }) => {
    const state = getDemoState();
    if (!state.governancePlan) {
      return toolJson({
        message: "No proposed plan exists yet. Call team_manager_plan_room first.",
        nextTool: "team_manager_plan_room"
      });
    }

    const result = approveGovernancePlan(state.governancePlan, {
      approved,
      userNotes,
      totalTokenBudget,
      agentBudgetOverrides
    });
    state.governancePlan = result.plan;
    state.budget.total = result.plan.totalTokenBudget;
    await applyAndStore(state, result.writes);
    logEvent("manager.plan.decision", {
      planId: result.plan.id,
      status: result.plan.status,
      totalTokenBudget: result.plan.totalTokenBudget,
      userNotes
    });

    return toolJson({
      message: approved
        ? "Team Manager plan approved. Start the room with team_manager_start_room."
        : "Team Manager recorded revision request. Update the plan before starting.",
      nextTool: approved ? "team_manager_start_room" : "team_manager_plan_room",
      plan: result.plan
    });
  }
);

server.registerTool(
  "team_manager_find_sources",
  {
    title: "Find Room Sources",
    description:
      "Use Bright Data MCP search to discover source URLs for the current room, then optionally register them for ingestion. This is generic search, not a scenario-specific source pack.",
    inputSchema: {
      query: z.string().optional().describe("Search query. Defaults to the current room request."),
      engine: z.enum(["google", "bing", "yandex"]).default("google"),
      geoLocation: z.string().length(2).default("us").describe("Two-letter country code for search localization."),
      maxResults: z.number().int().min(1).max(10).default(6),
      register: z.boolean().default(true).describe("Replace current room sources with the search results.")
    }
  },
  async ({ query, engine, geoLocation, maxResults, register }) => {
    const state = getDemoState();
    const searchQuery = query ?? state.taskPrompt;

    if (!brightDataAvailable()) {
      return toolJson({
        message: "Bright Data MCP search is not configured for Team Manager. Set BRIGHTDATA_API_TOKEN in the team-manager MCP env.",
        provider: "brightdata_mcp",
        configured: false,
        nextTool: "team_manager_set_sources"
      });
    }

    const results = await searchWithBrightData({
      query: searchQuery,
      engine,
      geoLocation,
      maxResults
    });

    const foundSources: SourceRef[] = results.map((result, index) => ({
      id: `src-search-${index + 1}-${stableId(result.url).slice(0, 8)}`,
      title: result.title,
      url: result.url,
      note: result.description ? `Bright Data search result for "${searchQuery}": ${result.description}` : `Bright Data search result for "${searchQuery}".`,
      status: "pending",
      extractionProvider: "pending"
    }));

    if (register) {
      state.sources = foundSources;
      await writeAuditEvent(state, {
        event_type: "sources_searched",
        provider: "brightdata_mcp",
        query: searchQuery,
        source_count: state.sources.length,
        sources: state.sources.map((source) => ({ id: source.id, title: source.title, url: source.url }))
      });
      setDemoState(state);
    }

    logEvent("sources.searched.brightdata", {
      query: searchQuery,
      count: foundSources.length,
      registered: register
    });

    return toolJson({
      message: register
        ? "Bright Data MCP search results registered. Call team_manager_ingest_sources to scrape and store evidence."
        : "Bright Data MCP search results returned but not registered.",
      provider: "brightdata_mcp",
      registered: register,
      nextTool: register ? "team_manager_ingest_sources" : "team_manager_set_sources",
      sources: foundSources
    });
  }
);

server.registerTool(
  "team_manager_set_sources",
  {
    title: "Set Room Sources",
    description:
      "Register arbitrary source URLs for the current room. The host can also pass extractedText from another scraper such as Bright Data MCP; no scenario-specific source pack is assumed.",
    inputSchema: {
      sources: z
        .array(
          z.object({
            url: z.string().url(),
            title: z.string().optional(),
            note: z.string().optional(),
            extractedText: z
              .string()
              .optional()
              .describe("Optional already-extracted page text or markdown, for example from Bright Data MCP.")
          })
        )
        .min(1)
        .describe("Public source URLs selected by the host agent or user.")
    }
  },
  async ({ sources }) => {
    const state = getDemoState();
    state.sources = sourceRefsFromInput(sources);
    await writeAuditEvent(state, {
      event_type: "sources_registered",
      source_count: state.sources.length,
      sources: state.sources.map((source) => ({ id: source.id, title: source.title, url: source.url }))
    });
    setDemoState(state);
    logEvent("sources.registered", {
      count: state.sources.length,
      urls: state.sources.map((source) => source.url)
    });

    return toolJson({
      message: "Sources registered. Call team_manager_ingest_sources or team_manager_start_room to fetch and store them.",
      sources: state.sources
    });
  }
);

server.registerTool(
  "team_manager_ingest_sources",
  {
    title: "Ingest Room Sources",
    description:
      "Fetch the current room's source URLs, extract generic evidence snippets from the task query, and store them in MongoDB source_documents. In auto mode, native fetch falls back to Bright Data MCP when extraction is thin.",
    inputSchema: {
      extractionProvider: z.enum(["auto", "native", "brightdata"]).default("auto"),
      fallbackToNative: z.boolean().default(true).describe("When Bright Data fails, fall back to native fetch.")
    }
  },
  async ({ extractionProvider, fallbackToNative }) => {
    const state = getDemoState();
    if (state.sources.length === 0) {
      return toolJson({
        message: "No sources are registered. Call team_manager_set_sources first.",
        nextTool: "team_manager_set_sources"
      });
    }

    const fetched = await fetchSources(state.sources, state.taskPrompt, {
      mode: extractionProvider,
      fallbackToNative
    });
    state.sources = fetched;
    await applyAndStore(state, [
      {
        collection: "source_documents",
        operation: "insertMany",
        documents: fetched.map((source) => sourceDocument(source, state.runId, state.taskId))
      },
      {
        collection: "audit",
        operation: "insertOne",
        document: {
          _id: scopedId(state, "audit-sources-ingested"),
          task_id: state.taskId,
          event_type: "sources_ingested",
          extraction_provider: extractionProvider,
          fetched: fetched.filter((source) => source.status === "fetched").length,
          evidence_count: fetched.reduce((sum, source) => sum + source.evidence.length, 0),
          created_at: new Date()
        }
      }
    ]);
    logEvent("sources.ingested", {
      extractionProvider,
      fetched: fetched.filter((source) => source.status === "fetched").length,
      evidenceSnippets: fetched.reduce((sum, source) => sum + source.evidence.length, 0)
    });

    return toolJson({
      message: "Sources ingested into MongoDB source_documents.",
      sources: state.sources.map((source) => ({
        id: source.id,
        title: source.title,
        url: source.url,
        status: source.status,
        extractionProvider: source.extractionProvider,
        extractionWarnings: source.extractionWarnings ?? [],
        evidenceCount: source.evidence?.length ?? 0,
        evidence: source.evidence
      }))
    });
  }
);

server.registerTool(
  "team_manager_post_blackboard",
  {
    title: "Post Blackboard Entry",
    description:
      "Append a source-linked finding, decision, request, progress update, or warning to the shared MongoDB blackboard.",
    inputSchema: {
      agentId: z.string().describe("Authoring agent id, for example agent-legal or agent-evidence."),
      entryType: z.enum(["discovery", "decision", "request", "progress", "warning"]),
      visibility: z.enum(["private", "team", "global"]).default("team"),
      content: z.string().min(1),
      sourceIds: z.array(z.string()).default([]),
      reuseCount: z.number().int().nonnegative().default(1),
      criticRatified: z.boolean().default(false).describe("Promote this entry to team visibility even before 3-agent reuse.")
    }
  },
  async ({ agentId, entryType, visibility, content, sourceIds, reuseCount, criticRatified }) => {
    const state = getDemoState();
    const createdAt = now();
    const promoted = visibility !== "private" || reuseCount >= 3 || criticRatified;
    const effectiveVisibility = visibility === "private" && promoted ? "team" : visibility;
    const entry: BlackboardEntry = {
      id: scopedId(state, "bb", `${agentId}-${content}`),
      taskId: state.taskId,
      entryType,
      visibility: effectiveVisibility,
      agentId,
      agentName: agentName(state, agentId),
      content,
      sourceIds,
      contentEmbedding: pseudoEmbedding(content),
      reactions: [],
      createdAt,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 4).toISOString(),
      promoted,
      reuseCount
    };
    state.blackboard = [entry, ...state.blackboard].slice(0, 50);
    await applyAndStore(state, [
      {
        collection: "blackboard_entries",
        operation: "insertOne",
        document: {
          _id: entry.id,
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
      },
      {
        collection: "audit",
        operation: "insertOne",
        document: {
          _id: scopedId(state, "audit-blackboard", entry.id),
          task_id: state.taskId,
          event_type: "blackboard_posted",
          blackboard_entry_id: entry.id,
          agent_id: agentId,
          source_ids: sourceIds,
          created_at: new Date()
        }
      }
    ]);
    logEvent("blackboard.posted", {
      entryId: entry.id,
      agent: entry.agentName,
      entryType,
      visibility: effectiveVisibility,
      promoted,
      sourceIds
    });

    return toolJson({
      message: "Blackboard entry stored.",
      entry
    });
  }
);

server.registerTool(
  "team_manager_query_context",
  {
    title: "Query Shared Context",
    description:
      "Retrieve relevant blackboard entries, scoped memory cards, and source evidence for an agent using visibility filters and local vector similarity.",
    inputSchema: {
      query: z.string().min(1),
      agentId: z.string().optional(),
      teamId: z.string().optional(),
      topK: z.number().int().positive().default(5)
    }
  },
  async ({ query, agentId, teamId, topK }) => {
    const state = getDemoState();
    const vector = pseudoEmbedding(query);
    const currentTeamId = teamId ?? state.teamId;
    const visibleMemory = state.memoryCards.filter((card) => {
      if (card.visibility === "global") return true;
      if (card.visibility === "team") return card.teamId === currentTeamId;
      return Boolean(agentId && card.ownerAgentId === agentId);
    });
    const blackboard = state.blackboard
      .map((entry) => ({ ...entry, score: cosineSimilarity(vector, entry.contentEmbedding) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
    const memory = visibleMemory
      .map((card) => ({ ...card, score: cosineSimilarity(vector, card.embedding) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
    const sourceEvidence = state.sources
      .flatMap((source) =>
        (source.evidence ?? []).map((evidence) => ({
          sourceId: source.id,
          title: source.title,
          url: source.url,
          ...evidence,
          score: cosineSimilarity(vector, pseudoEmbedding(`${evidence.label} ${evidence.snippet}`))
        }))
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);

    await writeAuditEvent(state, {
      event_type: "context_queried",
      agent_id: agentId,
      team_id: currentTeamId,
      query,
      returned_blackboard: blackboard.length,
      returned_memory: memory.length,
      returned_source_evidence: sourceEvidence.length
    });

    return toolJson({
      query,
      visibility: {
        agentId,
        teamId: currentTeamId
      },
      blackboard,
      memory,
      sourceEvidence
    });
  }
);

server.registerTool(
  "team_manager_write_memory",
  {
    title: "Write Scoped Memory",
    description: "Write private, team, or global memory into MongoDB memory_cards.",
    inputSchema: {
      ownerAgentId: z.string(),
      visibility: z.enum(["private", "team", "global"]).default("private"),
      content: z.string().min(1),
      reuseCount: z.number().int().nonnegative().default(1),
      criticRatified: z.boolean().default(false).describe("Promote this memory to team visibility even before 3-agent reuse."),
      sourceEntryId: z.string().optional()
    }
  },
  async ({ ownerAgentId, visibility, content, reuseCount, criticRatified, sourceEntryId }) => {
    const state = getDemoState();
    const promoted = visibility !== "private" || reuseCount >= 3 || criticRatified;
    const effectiveVisibility = visibility === "private" && promoted ? "team" : visibility;
    const card: MemoryCard = {
      id: scopedId(state, "memory", `${ownerAgentId}-${content}`),
      taskId: state.taskId,
      ownerAgentId,
      teamId: state.teamId,
      visibility: effectiveVisibility,
      content,
      embedding: pseudoEmbedding(content),
      reuseCount,
      promotedAt: promoted ? now() : undefined,
      sourceEntryId
    };
    state.memoryCards = [card, ...state.memoryCards].slice(0, 50);
    await applyAndStore(state, [
      {
        collection: "memory_cards",
        operation: "insertOne",
        document: {
          _id: card.id,
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
      }
    ]);

    return toolJson({
      message: "Memory card stored.",
      card
    });
  }
);

server.registerTool(
  "team_manager_record_checkpoint",
  {
    title: "Record Agent Checkpoint",
    description: "Persist an agent checkpoint to MongoDB agent_performance_records for crash recovery.",
    inputSchema: {
      agentId: z.string(),
      stepIndex: z.number().int().nonnegative(),
      partialOutput: z.string().default(""),
      pendingToolCalls: z.array(z.string()).default([]),
      tokensInput: z.number().int().nonnegative().default(0),
      tokensOutput: z.number().int().nonnegative().default(0),
      outcome: z.enum(["running", "checkpoint", "resumed", "success", "killed"]).default("checkpoint")
    }
  },
  async ({ agentId, stepIndex, partialOutput, pendingToolCalls, tokensInput, tokensOutput, outcome }) => {
    const state = getDemoState();
    const startedAt = now();
    const record: CheckpointRecord = {
      id: scopedId(state, "checkpoint", `${agentId}-${stepIndex}-${partialOutput}`),
      taskId: state.taskId,
      agentId,
      agentName: agentName(state, agentId),
      stepIndex,
      pendingToolCalls,
      partialOutput,
      mongoChangeStreamResumeToken: `resume-token-${state.runId}-${agentId}-${stepIndex}`,
      startedAt,
      tokensInput,
      tokensOutput,
      outcome
    };
    state.checkpoints = [record, ...state.checkpoints].slice(0, 50);
    await applyAndStore(state, [
      {
        collection: "agent_performance_records",
        operation: "insertOne",
        document: {
          _id: record.id,
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
          outcome: record.outcome
        }
      }
    ]);

    return toolJson({
      message: "Checkpoint stored.",
      checkpoint: record
    });
  }
);

server.registerTool(
  "team_manager_update_budget",
  {
    title: "Update Token Budget",
    description: "Update group token usage and return threshold actions for the host agent to enforce.",
    inputSchema: {
      tokensConsumed: z.number().int().nonnegative(),
      tokenBudget: z.number().int().positive().optional()
    }
  },
  async ({ tokensConsumed, tokenBudget }) => {
    const state = getDemoState();
    if (tokenBudget) {
      state.budget.total = tokenBudget;
    }
    state.budget.consumed = Math.min(tokensConsumed, state.budget.total);
    const ratio = state.budget.consumed / state.budget.total;
    const actions: string[] = [];
    if (ratio >= 0.7 && !state.budget.warnedAt70) {
      state.budget.warnedAt70 = true;
      actions.push("inject_budget_warning");
    }
    if (ratio >= 0.9 && !state.budget.summarizedAt90) {
      state.budget.summarizedAt90 = true;
      state.budget.summaryTokensSaved = 0;
      state.budget.summaryReplacementTokens = 0;
      actions.push("spawn_summarizer_or_compact_context");
    }
    if (ratio >= 1) {
      actions.push(state.budget.actionAt100);
    }
    if (actions.length > 0) {
      await writeAuditEvent(state, {
        event_type: "budget_threshold_crossed",
        tokens_consumed: state.budget.consumed,
        token_budget: state.budget.total,
        percent_used: Number((ratio * 100).toFixed(1)),
        actions
      });
    }
    await persistTaskState(state);

    return toolJson({
      message: "Budget updated.",
      budget: state.budget,
      percentUsed: Number((ratio * 100).toFixed(1)),
      actions
    });
  }
);

server.registerTool(
  "team_manager_emit_decision",
  {
    title: "Emit Audited Decision",
    description: "Store the final decision and claim-to-evidence audit trail in MongoDB.",
    inputSchema: {
      verdict: z.string(),
      confidence: z.number().min(0).max(1),
      rationale: z.string(),
      votes: z.record(z.enum(["buy", "hold", "no_buy"])).default({}),
      claims: z
        .array(
          z.object({
            agentId: z.string(),
            claim: z.string(),
            blackboardEntryId: z.string(),
            sourceIds: z.array(z.string()).default([]),
            confidence: z.number().min(0).max(1).default(0.7)
          })
        )
        .default([])
    }
  },
  async ({ verdict, confidence, rationale, votes, claims }) => {
    const state = getDemoState();
    state.status = "complete";
    state.finalDecision = { verdict, confidence, rationale, votes };
    const createdAt = now();
    const auditEvents: AuditEvent[] = claims.map((claim) => ({
      id: scopedId(state, "audit-claim", `${claim.agentId}-${claim.claim}`),
      taskId: state.taskId,
      claim: claim.claim,
      agentId: claim.agentId,
      agentName: agentName(state, claim.agentId),
      blackboardEntryId: claim.blackboardEntryId,
      sourceIds: claim.sourceIds,
      confidence: claim.confidence,
      createdAt
    }));
    state.audit = [...auditEvents, ...state.audit].slice(0, 100);
    await applyAndStore(state, [
      {
        collection: "tasks",
        operation: "updateOne",
        filter: { _id: state.taskId },
        update: {
          $set: {
            status: state.status,
            final_decision: state.finalDecision,
            updated_at: new Date()
          }
        }
      },
      {
        collection: "audit",
        operation: "insertMany",
        documents: [
          {
            _id: scopedId(state, "audit-decision"),
            task_id: state.taskId,
            event_type: "decision",
            verdict,
            confidence,
            rationale,
            votes,
            created_at: new Date(createdAt)
          },
          ...auditEvents.map((event) => ({
            _id: event.id,
            task_id: event.taskId,
            claim: event.claim,
            agent_id: event.agentId,
            agent_name: event.agentName,
            blackboard_entry_id: event.blackboardEntryId,
            source_ids: event.sourceIds,
            confidence: event.confidence,
            created_at: new Date(event.createdAt)
          }))
        ]
      }
    ]);

    return toolJson({
      message: "Decision and audit trail stored.",
      decision: state.finalDecision,
      audit: auditEvents
    });
  }
);

server.registerTool(
  "team_manager_start_room",
  {
    title: "Start Governed Agent Room",
    description:
      "Start the approved Team Manager room, dispatch the specialist pool, fetch live evidence, and persist room state to MongoDB Atlas.",
    inputSchema: {
      request: z
        .string()
        .default("I want to evaluate an important decision in the most efficient way.")
        .describe("The user's high-level work request."),
      target: z.string().default("custom").describe("Target entity, topic, decision, or workstream."),
      tokenBudget: z.number().int().positive().default(50_000).describe("Group token budget for the governed run."),
      reset: z.boolean().default(false).describe("Reset the current room before starting."),
      autoApprovePlan: z.boolean().default(false).describe("Auto-approve a proposed plan if none exists.")
    }
  },
  async ({ request, target, tokenBudget, reset, autoApprovePlan }) => {
    let state = reset ? resetDemoState() : getDemoState();
    if (reset) {
      await resetMongoDemo(state);
    }

    state.target = target;
    state.taskPrompt = request;
    state.taskType = classifyTaskType(request);
    state.budget.total = tokenBudget;
    if (!state.governancePlan || state.governancePlan.status !== "approved") {
      const plan = buildGovernancePlan({
        runId: state.runId,
        request,
        target,
        taskType: state.taskType,
        candidates: state.candidates,
        totalTokenBudget: tokenBudget
      });
      state.governancePlan = plan;
      await applyAndStore(state, governancePlanWrites(plan));

      if (!autoApprovePlan) {
        logEvent("manager.start.blocked_for_approval", {
          planId: plan.id,
          questions: plan.teamManager.questionsForUser
        });
        return toolJson({
          message: "Team Manager will not start agents until the human approves the proposed room plan.",
          requiresUserApproval: true,
          nextTool: "team_manager_approve_plan",
          proposedPlan: plan
        });
      }

      const approval = approveGovernancePlan(plan, {
        approved: true,
        userNotes: "Auto-approved by MCP host."
      });
      state.governancePlan = approval.plan;
      await applyAndStore(state, approval.writes);
    }

    state.budget.total = state.governancePlan.totalTokenBudget;
    logEvent("room.configure", {
      target,
      taskType: state.taskType,
      tokenBudget: state.budget.total,
      governancePlanId: state.governancePlan.id,
      memoryVisibility: state.governancePlan.memoryPolicy.visibility,
      budgetThresholds: ["70% warning", "90% summarizer", "100% abort"]
    });
    logEvent("dispatch.formula", {
      prompt: 0.25,
      history: 0.35,
      recency: 0.1,
      time: 0.15,
      tokenEfficiency: 0.15
    });

    const spawnResult = spawnTeamRoom(state);
    const hasUserSources = spawnResult.state.sources.some((source) => source.id.startsWith("src-user"));

    if (!hasUserSources) {
      spawnResult.state.sources = [];
      state = await applyAndStore(spawnResult.state, spawnResult.writes);
      logEvent("room.started.awaiting_sources", {
        taskId: state.taskId,
        reason: "no user-provided sources"
      });
      return toolJson({
        message:
          "Team Manager started the approved room and dispatched agents, but no sources are registered. Call team_manager_set_sources, then team_manager_ingest_sources.",
        nextTools: ["team_manager_set_sources", "team_manager_ingest_sources"],
        state: compactState(state)
      });
    }

    state = await applyAndStore(spawnResult.state, spawnResult.writes);
    logEvent("dispatch.selected", {
      agents: state.selectedAgents
        .filter((agent) => agent.agentId !== "agent-summarizer")
        .map((agent) => ({
          name: agent.name,
          rank: agent.score?.rank,
          score: agent.score?.matchScore,
            tokenEfficiency: agent.score?.tokenEfficiency
          }))
    });

    const approvedPlan = state.governancePlan;
    if (!approvedPlan) {
      throw new Error("Approved governance plan missing after start.");
    }

    return toolJson({
      message: "Team Manager started the approved room and dispatched agents. Call team_manager_ingest_sources to fetch the registered sources.",
      nextTool: "team_manager_ingest_sources",
      governance: {
        plan: approvedPlan,
        tokenBudget: state.budget.total,
        memoryVisibility: approvedPlan.memoryPolicy.visibility,
        dispatchWeights: approvedPlan.dispatchWeights
      },
      state: compactState(state)
    });
  }
);

server.registerTool(
  "team_manager_state",
  {
    title: "Read Team Manager State",
    description: "Read the current governed room state, including selected agents, source evidence, budget, checkpoints, and decision.",
    inputSchema: {
      includeFullAudit: z.boolean().default(false)
    }
  },
  async ({ includeFullAudit }) => {
    const state = getDemoState();
    return toolJson({
      state: compactState(state),
      blackboard: state.blackboard,
      audit: includeFullAudit ? state.audit : state.audit.slice(0, 5),
      checkpoints: includeFullAudit ? state.checkpoints : state.checkpoints.slice(0, 5)
    });
  }
);

server.registerTool(
  "team_manager_reset",
  {
    title: "Reset Team Manager",
    description: "Reset the room to a clean state and clear this run's scoped MongoDB documents.",
    inputSchema: {}
  },
  async () => {
    const state = resetDemoState();
    await resetMongoDemo(state);
    setDemoState(state);
    logEvent("room.reset", {
      mongo: state.mongo.mode,
      db: state.mongo.dbName
    });
    return toolJson({
      message: "Team Manager reset.",
      state: compactState(state)
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  transport.onclose = async () => {
    await closeMongoClient();
  };
  await server.connect(transport);
}

process.on("SIGINT", async () => {
  await closeMongoClient();
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeMongoClient();
  await server.close();
  process.exit(0);
});

main().catch(async (error) => {
  await closeMongoClient();
  console.error(error);
  process.exit(1);
});

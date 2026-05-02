export type AgentStatus =
  | "candidate"
  | "selected"
  | "running"
  | "waiting"
  | "killed"
  | "resumed"
  | "complete"
  | "summarizer";

export type DemoStatus =
  | "idle"
  | "dispatched"
  | "running"
  | "warning"
  | "summarizing"
  | "agent_killed"
  | "resumed"
  | "complete";

export type Visibility = "private" | "team" | "global";

export type EntryType = "discovery" | "decision" | "request" | "progress" | "warning";

export interface ProvenSkill {
  successRate: number;
  avgDurationMs: number;
  avgTokens: number;
  runs: number;
}

export interface ScoreBreakdown {
  promptRelevance: number;
  historicalSuccess: number;
  recencyBonus: number;
  timeEfficiency: number;
  tokenEfficiency: number;
  matchScore: number;
  rank: number;
}

export interface AgentProfile {
  agentId: string;
  name: string;
  role: string;
  description: string;
  skills: string[];
  capabilities: string[];
  descriptionEmbedding: number[];
  provenSkills: Record<string, ProvenSkill>;
  avgDurationMs: number;
  tokenEfficiency: number;
  lastPerformedAt: string;
  status: AgentStatus;
  selected: boolean;
  tokensUsed: number;
  currentStep: string;
  score?: ScoreBreakdown;
}

export interface SourceRef {
  id: string;
  title: string;
  url: string;
  note: string;
  status?: "pending" | "fetched" | "failed";
  fetchedAt?: string;
  contentLength?: number;
  excerpt?: string;
  error?: string;
  evidence?: SourceEvidence[];
}

export interface SourceEvidence {
  label: string;
  snippet: string;
  confidence: number;
}

export interface BlackboardEntry {
  id: string;
  taskId: string;
  entryType: EntryType;
  visibility: Visibility;
  agentId: string;
  agentName: string;
  content: string;
  sourceIds: string[];
  contentEmbedding: number[];
  reactions: string[];
  createdAt: string;
  expiresAt: string;
  promoted: boolean;
  reuseCount: number;
}

export interface MemoryCard {
  id: string;
  taskId: string;
  ownerAgentId: string;
  teamId: string;
  visibility: Visibility;
  content: string;
  embedding: number[];
  reuseCount: number;
  promotedAt?: string;
  sourceEntryId?: string;
}

export interface SubscriptionEvent {
  id: string;
  entryId: string;
  fromAgentId: string;
  toAgentId: string;
  toAgentName: string;
  reason: string;
  vectorScore: number;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  taskId: string;
  claim: string;
  agentId: string;
  agentName: string;
  blackboardEntryId: string;
  sourceIds: string[];
  confidence: number;
  createdAt: string;
}

export interface CheckpointRecord {
  id: string;
  taskId: string;
  agentId: string;
  agentName: string;
  stepIndex: number;
  pendingToolCalls: string[];
  partialOutput: string;
  mongoChangeStreamResumeToken: string;
  startedAt: string;
  tokensInput: number;
  tokensOutput: number;
  outcome: "running" | "checkpoint" | "resumed" | "success" | "killed";
}

export interface TimelineEvent {
  id: string;
  label: string;
  detail: string;
  layer: "L1" | "L2" | "L3" | "L4" | "resume" | "decision";
  createdAt: string;
}

export interface VoiceEvent {
  id: string;
  text: string;
  createdAt: string;
}

export interface MongoDocEvent {
  id: string;
  collection: string;
  operation: "insertOne" | "insertMany" | "updateOne" | "aggregate" | "createIndex";
  document: Record<string, unknown>;
  createdAt: string;
}

export interface MongoWrite {
  collection: string;
  operation: "insertOne" | "insertMany" | "updateOne";
  document?: Record<string, unknown>;
  documents?: Record<string, unknown>[];
  filter?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

export interface BudgetState {
  total: number;
  consumed: number;
  warnedAt70: boolean;
  summarizedAt90: boolean;
  summaryTokensSaved: number;
  summaryReplacementTokens: number;
  actionAt100: "warn" | "pause" | "abort";
}

export type PlanStatus = "proposed" | "approved" | "revisions_requested";

export interface ModelProfile {
  provider: "host" | "fireworks" | "claude" | "configurable";
  model: string;
  temperature: number;
  maxOutputTokens: number;
  reason: string;
}

export interface PlannedAgent {
  agentId: string;
  name: string;
  role: string;
  priority: "critical" | "high" | "medium";
  tokenBudget: number;
  model: ModelProfile;
  memoryScopes: Visibility[];
  blackboardTopK: number;
  responsibilities: string[];
  successCriteria: string[];
}

export interface GovernancePlan {
  id: string;
  status: PlanStatus;
  request: string;
  vendor: string;
  taskType: string;
  totalTokenBudget: number;
  dispatchWeights: {
    promptRelevance: number;
    historicalSuccess: number;
    recency: number;
    latency: number;
    tokenEfficiency: number;
  };
  budgetPolicy: {
    warningAt: number;
    summarizeAt: number;
    hardStopAt: number;
    hardStopAction: BudgetState["actionAt100"];
    managerReserve: number;
    summarizerReserve: number;
  };
  memoryPolicy: {
    visibility: Visibility[];
    defaultVisibility: Visibility;
    promotionRule: string;
    sensitiveDataRule: string;
  };
  retrievalPolicy: {
    blackboardTopK: number;
    memoryTopK: number;
    sourceTopK: number;
    requireSourceLinkedClaims: boolean;
  };
  teamManager: {
    model: ModelProfile;
    questionsForUser: string[];
    assumptions: string[];
  };
  agents: PlannedAgent[];
  priorities: string[];
  createdAt: string;
  approvedAt?: string;
  userNotes?: string;
}

export interface DemoState {
  runId: string;
  taskId: string;
  groupId: string;
  teamId: string;
  vendor: string;
  taskType: string;
  taskPrompt: string;
  status: DemoStatus;
  step: number;
  createdAt: string;
  updatedAt: string;
  budget: BudgetState;
  candidates: AgentProfile[];
  selectedAgents: AgentProfile[];
  blackboard: BlackboardEntry[];
  memoryCards: MemoryCard[];
  subscriptions: SubscriptionEvent[];
  audit: AuditEvent[];
  checkpoints: CheckpointRecord[];
  timeline: TimelineEvent[];
  voiceEvents: VoiceEvent[];
  mongoDocs: MongoDocEvent[];
  sources: SourceRef[];
  governancePlan?: GovernancePlan;
  finalDecision?: {
    verdict: string;
    confidence: number;
    rationale: string;
    votes: Record<string, "buy" | "hold" | "no_buy">;
  };
  mongo: {
    mode: "unknown" | "atlas" | "replay";
    dbName: string;
    lastError?: string;
  };
}

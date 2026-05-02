import { advanceDemo, ingestLiveSources, spawnTeamRoom } from "../lib/demo-engine";
import { resetDemoState } from "../lib/demo-store";
import { approveGovernancePlan, buildGovernancePlan, governancePlanWrites } from "../lib/governance-plan";
import { applyMongoWrites, closeMongoClient, resetMongoDemo } from "../lib/mongo";
import type { AgentProfile, DemoState, GovernancePlan, MongoWrite } from "../lib/types";

const request =
  process.argv.slice(2).join(" ") ||
  "I want to due diligence PostHog as a vendor for my B2B SaaS business in the most efficient way.";

function line(label: string, text: string) {
  console.log(`${label.padEnd(18)} ${text}`);
}

function short(text: string | undefined, max = 132) {
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function score(agent: AgentProfile) {
  return (agent.score?.matchScore ?? 0).toFixed(3);
}

function budgetBar(state: DemoState) {
  const width = 24;
  const ratio = state.budget.consumed / state.budget.total;
  const filled = Math.min(width, Math.round(ratio * width));
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}

function counts(state: DemoState) {
  return {
    blackboard: state.blackboard.length,
    subscriptions: state.subscriptions.length,
    memory: state.memoryCards.length,
    checkpoints: state.checkpoints.length,
    audit: state.audit.length,
    voice: state.voiceEvents.length
  };
}

function printDelta(state: DemoState, before: ReturnType<typeof counts>) {
  line("budget", `${budgetBar(state)} ${state.budget.consumed.toLocaleString()}/${state.budget.total.toLocaleString()} tokens`);

  if (state.timeline[0]) {
    line("trace", `[${state.timeline[0].layer}] ${state.timeline[0].label}: ${short(state.timeline[0].detail, 118)}`);
  }

  if (state.blackboard.length > before.blackboard) {
    const entry = state.blackboard[0];
    line("blackboard", `${entry.agentName} ${entry.entryType}/${entry.visibility}: ${short(entry.content)}`);
  }

  if (state.subscriptions.length > before.subscriptions) {
    const event = state.subscriptions[0];
    line("subscribe", `${event.toAgentName} pulled ${event.entryId} score=${event.vectorScore} via change stream + vector relevance`);
  }

  if (state.memoryCards.length > before.memory) {
    const card = state.memoryCards[0];
    line("memory", `${card.visibility} card owner=${card.ownerAgentId} reuse=${card.reuseCount}: ${short(card.content, 116)}`);
  }

  if (state.checkpoints.length > before.checkpoints) {
    const checkpoint = state.checkpoints[0];
    line("checkpoint", `${checkpoint.agentName} step=${checkpoint.stepIndex} outcome=${checkpoint.outcome} resume=${checkpoint.mongoChangeStreamResumeToken}`);
  }

  if (state.voiceEvents.length > before.voice) {
    line("narration", state.voiceEvents[state.voiceEvents.length - 1].text);
  }

  if (state.budget.summarizedAt90 && state.memoryCards.length > before.memory) {
    line(
      "summarizer",
      `threshold crossed at 46,800 tokens; replaced ${state.budget.summaryTokensSaved.toLocaleString()} tokens with ${state.budget.summaryReplacementTokens.toLocaleString()} team-memory tokens`
    );
  }
}

async function apply(state: DemoState, writes: MongoWrite[]) {
  await applyMongoWrites(state, writes);
  return state;
}

function printPlan(plan: GovernancePlan) {
  line("manager", `proposed plan=${plan.id} status=${plan.status}`);
  line("measure", "25% relevance + 35% history + 10% recency + 15% latency + 15% token efficiency");
  line(
    "thresholds",
    `${Math.round(plan.budgetPolicy.warningAt * 100)}% warn; ${Math.round(plan.budgetPolicy.summarizeAt * 100)}% summarize; ${Math.round(plan.budgetPolicy.hardStopAt * 100)}% ${plan.budgetPolicy.hardStopAction}`
  );
  line("manager model", `${plan.teamManager.model.model} temp=${plan.teamManager.model.temperature}: ${short(plan.teamManager.model.reason, 108)}`);
  plan.teamManager.questionsForUser.forEach((question, index) => {
    line(`question ${index + 1}`, short(question, 144));
  });
  plan.agents.forEach((agent) => {
    line(
      `plan ${agent.name}`,
      `${agent.priority}; cap=${agent.tokenBudget.toLocaleString()} tokens; model=${agent.model.model}; memory=${agent.memoryScopes.join("/")}`
    );
  });
}

async function main() {
  let state = resetDemoState();
  state.taskPrompt = request;
  await resetMongoDemo(state);

  console.log("\nTeam Manager MCP Harness");
  console.log("========================");
  line("request", request);

  const plan = buildGovernancePlan({
    runId: state.runId,
    request,
    vendor: state.vendor,
    taskType: state.taskType,
    candidates: state.candidates,
    totalTokenBudget: 50_000
  });
  state.governancePlan = plan;
  state = await apply(state, governancePlanWrites(plan));
  printPlan(plan);

  const approved = approveGovernancePlan(plan, {
    approved: true,
    userNotes: "Approved for demo: prioritize caution, source-linked claims, and visible token governance."
  });
  state.governancePlan = approved.plan;
  state.budget.total = approved.plan.totalTokenBudget;
  state = await apply(state, approved.writes);
  line("approval", `${approved.plan.status}; notes="${approved.plan.userNotes}"`);
  line("memory", "private owner-only; team room-visible; global org-visible; promotion=reused_by_3_agents");
  line("context", "blackboard topK=5; source snippets are live-fetched; checkpoint after every agent step");

  const spawn = spawnTeamRoom(state);
  const ingest = await ingestLiveSources(spawn.state);
  state = await apply(ingest.state, [...spawn.writes, ...ingest.writes]);
  line("room", `${state.taskId} in ${state.mongo.mode === "atlas" ? "MongoDB Atlas" : "local replay"} db=${state.mongo.dbName}`);
  line("agent pool", "12 candidates -> 5 selected");
  state.selectedAgents
    .filter((agent) => agent.agentId !== "agent-summarizer")
    .sort((left, right) => (left.score?.rank ?? 99) - (right.score?.rank ?? 99))
    .forEach((agent) => {
      line(
        `agent #${agent.score?.rank}`,
        `${agent.name} score=${score(agent)} history=${agent.score?.historicalSuccess.toFixed(2)} tokenEff=${agent.score?.tokenEfficiency.toFixed(2)} role=${agent.role}`
      );
    });
  line("sources", `${state.sources.filter((source) => source.status === "fetched").length}/3 fetched, ${state.sources.reduce((sum, source) => sum + (source.evidence?.length ?? 0), 0)} snippets -> MongoDB source_documents`);
  state.sources.forEach((source) => {
    line("source", `${source.status} evidence=${source.evidence?.length ?? 0} ${source.url}`);
  });

  for (let step = 1; step <= 4; step += 1) {
    const before = counts(state);
    const result = advanceDemo(state);
    state = await apply(result.state, result.writes);
    line(`advance ${step}`, `status=${state.status}; blackboard=${state.blackboard.length}; checkpoints=${state.checkpoints.length}`);
    printDelta(state, before);
  }

  let before = counts(state);
  let result = advanceDemo(state);
  state = await apply(result.state, result.writes);
  line("kill", `${state.checkpoints[0]?.agentName} checkpoint=${state.checkpoints[0]?.mongoChangeStreamResumeToken}`);
  printDelta(state, before);

  before = counts(state);
  result = advanceDemo(state);
  state = await apply(result.state, result.writes);
  line("resume", `${state.checkpoints[0]?.agentName} checkpoint=${state.checkpoints[0]?.mongoChangeStreamResumeToken}`);
  printDelta(state, before);

  before = counts(state);
  result = advanceDemo(state);
  state = await apply(result.state, result.writes);
  line("decision", `${state.finalDecision?.verdict} confidence=${state.finalDecision?.confidence}`);
  printDelta(state, before);
  line("audit", `${state.audit.length} claims linked to blackboard entries and public sources`);
  state.audit
    .slice()
    .reverse()
    .slice(0, 5)
    .forEach((event) => {
      line("claim", `${event.agentName}: ${short(event.claim, 104)}`);
      line("evidence", `${event.blackboardEntryId} -> ${event.sourceIds.join(", ") || "generated summary card"}`);
    });
  console.log("");
}

main()
  .then(() => closeMongoClient())
  .catch(async (error) => {
    await closeMongoClient();
    console.error(error);
    process.exit(1);
  });

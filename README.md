# Team Manager MCP

MongoDB-native team manager for multi-agent collaboration.

**Tagline:** Tell it the job. It proposes the team, budgets, memory rules, and models. Approve the plan, then kill any agent and watch it resume from MongoDB.

Team Manager is an MCP server for governing multi-agent work. An MCP-capable host asks it to plan a specialist room, the manager asks the human for approval or edits, and MongoDB Atlas stores the skills, assignments, shared context, memory boundaries, token budget, checkpoints, source evidence, and audit trail.

The live workflow evaluates PostHog as an analytics vendor for a B2B SaaS buyer. The vendor evaluation is just the workload; the product is the MongoDB-backed team manager underneath it.

## Primary Theme

Team Manager is built for **Multi-Agent Collaboration**:

- **Agents convey skills:** `agent_profiles` stores declared skills plus proven performance history.
- **Agents identify peers:** capability scoring ranks 12 candidates and proposes the best 5-agent room.
- **Agents share context:** `blackboard_entries` is the shared room context, with vector relevance and change-stream style subscription events.
- **Agents stay inside token limits:** `tasks` and `groups` hold the group budget, warning threshold, summarizer threshold, and hard-stop action.
- **Agents retain scoped memory:** `memory_cards` stores private, team, and global memory with filtered retrieval.
- **Agents survive interruptions:** `agent_performance_records` stores checkpoints and resume tokens.

It also touches prolonged coordination through checkpoint/resume and adaptive retrieval through source, memory, and blackboard relevance, but the submission story should lead with multi-agent collaboration.

## MCP Flow

The intended MCP sequence is collaborative:

1. `team_manager_plan_room`: proposes the measurement formula, specialist roster, token allocation, model profiles, memory visibility, priorities, and user questions.
2. `team_manager_approve_plan`: records the human's approval or revision request in MongoDB.
3. `team_manager_start_room`: dispatches the approved room and fetches live public sources.
4. `team_manager_advance`: advances blackboard posts, subscriptions, token cascade, memory promotion, and decision work.
5. `team_manager_kill_agent`: simulates killing `ContractRedFlags` after checkpoint persistence.
6. `team_manager_resume_agent`: resumes that agent from MongoDB checkpoint.
7. `team_manager_state`: returns the current room state and audit graph.

## Quick Start

```bash
npm install
npm run mcp
```

For MCP client configs, call the server directly so stdout stays protocol-clean:

```bash
./node_modules/.bin/tsx scripts/mcp-server.ts
```

Example MCP server entry:

```json
{
  "mcpServers": {
    "team-manager": {
      "command": "/Users/advaitjayant/hackathon/team-manager/node_modules/.bin/tsx",
      "args": ["/Users/advaitjayant/hackathon/team-manager/scripts/mcp-server.ts"],
      "env": {
        "MONGODB_URI": "mongodb+srv://advait:<URL_ENCODED_PASSWORD>@cluster0.1hulng.mongodb.net/?appName=Cluster0",
        "TEAM_MANAGER_DB": "team_manager"
      }
    }
  }
}
```

Terminal demo harness:

```bash
npm run harness -- "I want to due diligence PostHog as a vendor for my B2B SaaS business in the most efficient way."
```

Full demo operator notes are in [docs/mcp-demo.md](docs/mcp-demo.md).

## Atlas Sandbox

Create `.env.local` locally from `.env.example` and set:

```bash
MONGODB_URI="mongodb+srv://advait:<URL_ENCODED_PASSWORD>@cluster0.1hulng.mongodb.net/?appName=Cluster0"
TEAM_MANAGER_DB=team_manager
```

Initialize collections and indexes:

```bash
npm run atlas:init
```

Validate the filtered vector index on `memory_cards`:

```bash
npm run atlas:smoke
```

Seed a full replay into Atlas:

```bash
npm run seed
```

## MongoDB Collections

- `governance_plans`: proposed and approved room plans, questions, model profiles, token allocations, and memory policy.
- `agent_profiles`: candidate agent cards, skills, embeddings, and learned performance stats.
- `agent_performance_records`: time-series execution records and checkpoints.
- `tasks`: active work item, group assignment, token budget, and current status.
- `groups`: room membership and group-level token consumption.
- `blackboard_entries`: shared findings, decisions, requests, progress, and warnings.
- `memory_cards`: private, team, and global scoped memory cards.
- `source_documents`: live public source pages and extracted evidence snippets.
- `audit`: append-only event and claim trail.

Atlas Vector Search indexes:

- `agent_profiles.agent_description_vector_index`
- `blackboard_entries.blackboard_content_vector_index`
- `memory_cards.memory_layered_vector_index`

## Demo Evidence

The demo fetches these public source URLs live and stores extracted snippets in MongoDB before agents write findings:

- PostHog Trust Center: `https://trust.posthog.com/`
- PostHog Pricing: `https://posthog.com/pricing`
- PostHog Product OS: `https://posthog.com/`

## Submission Summary

**Project:** Team Manager MCP

**One-liner:** A MongoDB-native MCP team manager that helps a user plan, budget, dispatch, coordinate, and audit specialist agents.

**Live demo:** run `npm run mcp` from an MCP client, or use `npm run harness -- "<request>"` for the terminal walkthrough.

**MongoDB use:** Atlas organizes and oversees the collaboration: agent skills, room plan, task assignment, shared blackboard, scoped memory, group budget, checkpoints, source evidence, and audit.

**Pitch line:** This is not a vendor-selection chatbot or a dashboard. It is the MongoDB-native team manager that turns a vague task into an approved multi-agent room with explicit skills, budgets, priorities, memory boundaries, shared context, and recoverable execution.

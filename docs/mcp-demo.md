# Team Manager MCP Demo Guide

Team Manager is meant to be shown from an MCP-capable agent client or from the included terminal harness. There is no dashboard in the demo path.

## MCP Client Config

Use a stdio MCP server config like this, replacing the path and MongoDB URI with your local values:

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

The server logs governance events to stderr while keeping stdout protocol-clean for MCP JSON-RPC.

## Judge Prompt

Use this prompt in Claude Code, Claude Desktop, Hermes, Codex, or any MCP host wired to the Team Manager server:

```text
I want to due diligence PostHog as a vendor for my B2B SaaS business in the most efficient way. Use Team Manager to propose the agent room, ask me for approval on measurement weights, token budgets, memory rules, and model choices, then run the approved multi-agent workflow with MongoDB-backed shared context and audit.
```

Expected tool sequence:

1. `team_manager_plan_room`
2. The MCP host asks the user the manager's returned questions.
3. `team_manager_approve_plan`
4. `team_manager_start_room`
5. `team_manager_advance` until the 70 percent budget warning appears
6. `team_manager_advance` again to trigger the 90 percent summarizer
7. `team_manager_kill_agent`
8. `team_manager_resume_agent`
9. `team_manager_advance` for the final decision
10. `team_manager_state` with `includeFullAudit=true`

## Terminal Harness

If an MCP host is slow or unavailable, run the exact same governance path directly:

```bash
npm run harness -- "I want to due diligence PostHog as a vendor for my B2B SaaS business in the most efficient way."
```

The harness prints:

- the Team Manager's proposed questions
- agent fit measurement parameters
- model profiles and temperature settings
- per-agent token caps
- MongoDB-backed memory and context policies
- capability dispatch from 12 candidates to 5 specialists
- live source ingestion into `source_documents`
- blackboard writes and auto-subscriptions
- memory promotion and summarizer context compression
- checkpoint write, kill, and resume
- final audit links from claim to blackboard entry to source document

## What To Say

Team Manager is a MongoDB-native control plane for multi-agent collaboration. The vendor evaluation is just a legible workload for the judges. MongoDB Atlas organizes and oversees the room: skills in `agent_profiles`, assignments in `tasks` and `groups`, shared context in `blackboard_entries`, scoped memory in `memory_cards`, checkpoints in `agent_performance_records`, and source-linked claims in `audit`.

Lead with the hackathon theme:

> "This is our answer to Multi-Agent Collaboration: a Team Manager MCP server that asks the user how to run the team, initializes the right specialists, allocates token budgets, sets shared-memory boundaries, and uses MongoDB as the durable collaboration state."

Do not present it as a vendor-selection chatbot or a dashboard.

import { MongoClient, type Db } from "mongodb";
import type { DemoState, MongoWrite } from "./types";

const DEMO_SCOPE = "team-manager-demo";

declare global {
  // eslint-disable-next-line no-var
  var __team_manager_mongo_client: Promise<MongoClient> | undefined;
}

export function mongoDbName(): string {
  return process.env.TEAM_MANAGER_DB ?? process.env.BOARDROOM_DB ?? "team_manager";
}

export async function getMongoDb(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    return null;
  }

  if (!globalThis.__team_manager_mongo_client) {
    globalThis.__team_manager_mongo_client = new MongoClient(uri).connect();
  }

  const client = await globalThis.__team_manager_mongo_client;
  return client.db(mongoDbName());
}

export async function closeMongoClient(): Promise<void> {
  if (!globalThis.__team_manager_mongo_client) {
    return;
  }

  const client = await globalThis.__team_manager_mongo_client;
  await client.close();
  globalThis.__team_manager_mongo_client = undefined;
}

async function collectionExists(db: Db, name: string): Promise<boolean> {
  const existing = await db.listCollections({ name }).toArray();
  return existing.length > 0;
}

export async function ensureCoreCollectionsAndIndexes(): Promise<void> {
  const db = await getMongoDb();
  if (!db) {
    return;
  }

  if (!(await collectionExists(db, "agent_performance_records"))) {
    await db.createCollection("agent_performance_records", {
      timeseries: {
        timeField: "started_at",
        metaField: "agent_id",
        granularity: "seconds"
      }
    });
  }

  const collectionNames = [
    "agent_profiles",
    "tasks",
    "blackboard_entries",
    "memory_cards",
    "groups",
    "audit",
    "source_documents",
    "governance_plans"
  ];
  for (const name of collectionNames) {
    if (!(await collectionExists(db, name))) {
      await db.createCollection(name);
    }
  }

  await Promise.all([
    db.collection("agent_profiles").createIndex({ skills: 1 }),
    db.collection("agent_profiles").createIndex({ agent_id: 1 }, { unique: false }),
    db.collection("tasks").createIndex({ group_id: 1, status: 1 }),
    db.collection("blackboard_entries").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.collection("blackboard_entries").createIndex({ task_id: 1, visibility: 1, entry_type: 1 }),
    db.collection("memory_cards").createIndex({ visibility: 1, owner_agent_id: 1, team_id: 1 }),
    db.collection("source_documents").createIndex({ task_id: 1, source_id: 1 }),
    db.collection("source_documents").createIndex({ fetched_at: -1 }),
    db.collection("governance_plans").createIndex({ plan_id: 1 }),
    db.collection("governance_plans").createIndex({ status: 1, created_at: -1 }),
    db.collection("groups").createIndex({ team_id: 1 }),
    db.collection("audit").createIndex({ task_id: 1 }),
    db.collection("audit").createIndex({ demo_run_id: 1 })
  ]);
}

export async function createAtlasVectorSearchIndexes(): Promise<void> {
  const db = await getMongoDb();
  if (!db) {
    throw new Error("MONGODB_URI is not set; cannot create Atlas Vector Search indexes.");
  }

  await ensureCoreCollectionsAndIndexes();

  await db.command({
    createSearchIndexes: "agent_profiles",
    indexes: [
      {
        name: "agent_description_vector_index",
        type: "vectorSearch",
        definition: {
          fields: [
            {
              type: "vector",
              path: "description_embedding",
              numDimensions: 64,
              similarity: "cosine"
            },
            { type: "filter", path: "skills" }
          ]
        }
      }
    ]
  });

  await db.command({
    createSearchIndexes: "blackboard_entries",
    indexes: [
      {
        name: "blackboard_content_vector_index",
        type: "vectorSearch",
        definition: {
          fields: [
            {
              type: "vector",
              path: "content_embedding",
              numDimensions: 64,
              similarity: "cosine"
            },
            { type: "filter", path: "visibility" },
            { type: "filter", path: "task_id" },
            { type: "filter", path: "entry_type" }
          ]
        }
      }
    ]
  });

  await db.command({
    createSearchIndexes: "memory_cards",
    indexes: [
      {
        name: "memory_layered_vector_index",
        type: "vectorSearch",
        definition: {
          fields: [
            {
              type: "vector",
              path: "embedding",
              numDimensions: 64,
              similarity: "cosine"
            },
            { type: "filter", path: "visibility" },
            { type: "filter", path: "owner_agent_id" },
            { type: "filter", path: "team_id" }
          ]
        }
      }
    ]
  });
}

export async function resetMongoDemo(state: DemoState): Promise<{ connected: boolean; error?: string }> {
  try {
    const db = await getMongoDb();
    if (!db) {
      return { connected: false };
    }

    await ensureCoreCollectionsAndIndexes();
    const collections = [
      "agent_profiles",
      "tasks",
      "blackboard_entries",
      "memory_cards",
      "groups",
      "audit",
      "source_documents",
      "governance_plans"
    ];
    await Promise.all(collections.map((name) => db.collection(name).deleteMany({ demo_scope: DEMO_SCOPE })));

    state.mongo.mode = "atlas";
    state.mongo.dbName = mongoDbName();
    state.mongo.lastError = undefined;

    return { connected: true };
  } catch (error) {
    state.mongo.mode = "replay";
    state.mongo.lastError = error instanceof Error ? error.message : String(error);
    return { connected: false, error: state.mongo.lastError };
  }
}

function decorateDocument(document: Record<string, unknown>, state: DemoState): Record<string, unknown> {
  return {
    demo_scope: DEMO_SCOPE,
    demo_run_id: state.runId,
    ...document
  };
}

export async function applyMongoWrites(
  state: DemoState,
  writes: MongoWrite[]
): Promise<{ connected: boolean; error?: string }> {
  try {
    const db = await getMongoDb();
    if (!db) {
      state.mongo.mode = "replay";
      state.mongo.dbName = mongoDbName();
      return { connected: false };
    }

    await ensureCoreCollectionsAndIndexes();

    for (const write of writes) {
      const collection = db.collection(write.collection);
      if (write.operation === "insertOne" && write.document) {
        await collection.insertOne(decorateDocument(write.document, state));
      }
      if (write.operation === "insertMany" && write.documents?.length) {
        await collection.insertMany(write.documents.map((document) => decorateDocument(document, state)), { ordered: false });
      }
      if (write.operation === "updateOne" && write.filter && write.update) {
        await collection.updateOne(
          decorateDocument(write.filter, state),
          write.update,
          { upsert: false }
        );
      }
    }

    state.mongo.mode = "atlas";
    state.mongo.dbName = mongoDbName();
    state.mongo.lastError = undefined;
    return { connected: true };
  } catch (error) {
    state.mongo.mode = "replay";
    state.mongo.dbName = mongoDbName();
    state.mongo.lastError = error instanceof Error ? error.message : String(error);
    return { connected: false, error: state.mongo.lastError };
  }
}

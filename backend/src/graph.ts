// graph.ts
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { chatAgent } from "./agent.js";

// --------------------
// 1️⃣ Define Chat State
// --------------------
const ChatState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

// --------------------
// 2️⃣ Build Workflow Graph
// --------------------
const workflow = new StateGraph(ChatState)
  .addNode("agent", chatAgent)
  .addEdge(START, "agent")
  .addEdge("agent", END);

// --------------------
// 3️⃣ PostgreSQL Connection
// --------------------
const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.PG_USER || "postgres"}:${process.env.PG_PASSWORD || "postgres"}@${process.env.PG_HOST || "localhost"}:${process.env.PG_PORT || "5432"}/${process.env.PG_DATABASE || "chat_agent"}`;

// --------------------
// 4️⃣ Postgres Checkpointer (Thread State)
// --------------------
export const checkpointer = PostgresSaver.fromConnString(connectionString);
await checkpointer.setup();
console.log("✅ LangGraph PostgreSQL checkpointer ready");

// --------------------
// 5️⃣ Postgres-backed Memory Store (Persistent Cross-thread)
// --------------------
export const pool = new pg.Pool({ connectionString });

// Create user_memories table
await pool.query(`
  CREATE TABLE IF NOT EXISTS user_memories (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    fact TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_memories_namespace ON user_memories(namespace)`);

// Custom PostgreSQL-backed memory store (mimics LangGraph Store interface)
export const memoryStore = {
  async search(namespace: string[]): Promise<Array<{ value: { fact: string }; key: string }>> {
    const ns = namespace.join(":");
    const result = await pool.query(
      "SELECT id, fact FROM user_memories WHERE namespace = $1 ORDER BY created_at DESC LIMIT 50",
      [ns]
    );
    return result.rows.map((row) => ({ key: row.id, value: { fact: row.fact } }));
  },

  async put(namespace: string[], key: string, value: { fact: string; createdAt: string }): Promise<void> {
    const ns = namespace.join(":");
    await pool.query(
      "INSERT INTO user_memories (id, namespace, fact) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET fact = $3",
      [key, ns, value.fact]
    );
  },

  async delete(namespace: string[], key: string): Promise<void> {
    await pool.query("DELETE FROM user_memories WHERE id = $1", [key]);
  },
};

console.log("✅ PostgreSQL memory store ready (persistent)");

// --------------------
// 6️⃣ Compile Graph
// --------------------
export const chatGraph = workflow.compile({
  checkpointer,
});

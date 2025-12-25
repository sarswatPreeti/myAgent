// memoryStore.ts - PostgreSQL-backed persistent memory store for cross-thread memory
import pg from "pg";
import "dotenv/config";

const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.PG_USER || "postgres"}:${process.env.PG_PASSWORD || "postgres"}@${process.env.PG_HOST || "localhost"}:${process.env.PG_PORT || "5432"}/${process.env.PG_DATABASE || "chat_agent"}`;

// Create pool
const pool = new pg.Pool({ connectionString });

// Initialize table
let initialized = false;

async function ensureTable() {
  if (initialized) return;
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        fact TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_memories_namespace ON user_memories(namespace)`);
    initialized = true;
    console.log("✅ PostgreSQL memory store initialized");
  } catch (e) {
    console.error("❌ Failed to initialize memory store:", e);
  }
}

// PostgreSQL-backed memory store
export const memoryStore = {
  async search(namespace: string[]): Promise<Array<{ value: { fact: string }; key: string }>> {
    await ensureTable();
    const ns = namespace.join(":");
    try {
      const result = await pool.query(
        "SELECT id, fact FROM user_memories WHERE namespace = $1 ORDER BY created_at DESC LIMIT 50",
        [ns]
      );
      return result.rows.map((row) => ({ key: row.id, value: { fact: row.fact } }));
    } catch (e) {
      console.error("❌ Error searching memories:", e);
      return [];
    }
  },

  async put(namespace: string[], key: string, value: { fact: string; createdAt: string }): Promise<void> {
    await ensureTable();
    const ns = namespace.join(":");
    try {
      await pool.query(
        "INSERT INTO user_memories (id, namespace, fact) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET fact = $3",
        [key, ns, value.fact]
      );
    } catch (e) {
      console.error("❌ Error saving memory:", e);
    }
  },

  async delete(namespace: string[], key: string): Promise<void> {
    await ensureTable();
    try {
      await pool.query("DELETE FROM user_memories WHERE id = $1", [key]);
    } catch (e) {
      console.error("❌ Error deleting memory:", e);
    }
  },
};

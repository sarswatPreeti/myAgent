import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { chatGraph, checkpointer, pool } from "./graph.js";
import { HumanMessage } from "@langchain/core/messages";

const app = express();
app.use(cors());
app.use(express.json());

// Helper: Create thread_id with user namespace (userId:threadId)
const makeThreadId = (userId: string, threadId: string) => `${userId}:${threadId}`;
const parseThreadId = (fullThreadId: string) => {
  const [userId, ...rest] = fullThreadId.split(":");
  return { userId, threadId: rest.join(":") };
};

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============ THREAD MANAGEMENT (using LangGraph's built-in checkpointer.list) ============

// Get all threads for a user
app.get("/users/:userId/threads", async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Use LangGraph's checkpointer.list() to get all checkpoints
    // Filter by user namespace prefix
    const threads: any[] = [];
    const seenThreads = new Set<string>();
    
    // List all checkpoints and filter by user prefix
    for await (const checkpoint of checkpointer.list({})) {
      const threadId = checkpoint.config?.configurable?.thread_id;
      if (threadId?.startsWith(`${userId}:`) && !seenThreads.has(threadId)) {
        seenThreads.add(threadId);
        
        try {
          const state = await chatGraph.getState({ configurable: { thread_id: threadId } });
          const messages = state.values?.messages || [];
          const firstUserMessage = messages.find((m: any) => m._getType?.() === "human" || m.type === "human");
          
          threads.push({
            id: parseThreadId(threadId).threadId,
            fullThreadId: threadId,
            title: firstUserMessage?.content?.toString().substring(0, 50) || "New Chat",
            messageCount: messages.length,
          });
        } catch {
          threads.push({
            id: parseThreadId(threadId).threadId,
            fullThreadId: threadId,
            title: "New Chat",
            messageCount: 0,
          });
        }
      }
    }
    
    res.json(threads);
  } catch (error) {
    console.error("Error getting threads:", error);
    res.status(500).json({ error: "Failed to get threads" });
  }
});

// Create new thread for user (just returns a new ID, thread is created on first message)
app.post("/users/:userId/threads", async (req, res) => {
  try {
    const { userId } = req.params;
    const threadId = uuidv4();
    const fullThreadId = makeThreadId(userId, threadId);
    
    // Thread will be created automatically when first message is sent
    res.json({ threadId, fullThreadId, userId });
  } catch (error) {
    console.error("Error creating thread:", error);
    res.status(500).json({ error: "Failed to create thread" });
  }
});

// Get thread history
app.get("/threads/:threadId", async (req, res) => {
  try {
    const { threadId } = req.params;
    const { userId } = req.query;
    
    // Use full thread_id with user namespace if userId provided
    const fullThreadId = userId ? makeThreadId(userId as string, threadId) : threadId;
    
    // Get state from LangGraph checkpointer
    const state = await chatGraph.getState({ configurable: { thread_id: fullThreadId } });
    
    const messages = (state.values?.messages || []).map((m: any) => ({
      role: m._getType?.() === "human" || m.type === "human" ? "user" : "assistant",
      content: m.content,
    }));
    
    res.json({ threadId, messages });
  } catch (error) {
    console.error("Error getting thread:", error);
    res.status(500).json({ error: "Failed to get thread" });
  }
});

// Delete thread - Actually delete from PostgreSQL checkpointer tables
app.delete("/threads/:threadId", async (req, res) => {
  try {
    const { threadId } = req.params;
    const { userId } = req.query;
    
    // Build full thread_id with user namespace
    const fullThreadId = userId ? makeThreadId(userId as string, threadId) : threadId;
    
    // Delete from LangGraph checkpointer tables (checkpoint_writes and checkpoints)
    await pool.query("DELETE FROM checkpoint_writes WHERE thread_id = $1", [fullThreadId]);
    await pool.query("DELETE FROM checkpoints WHERE thread_id = $1", [fullThreadId]);
    
    console.log(`🗑️ Deleted thread: ${fullThreadId}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting thread:", error);
    res.status(500).json({ error: "Failed to delete thread" });
  }
});

// ============ CHAT ENDPOINT ============

app.post("/chat", async (req, res) => {
  try {
    const { message, userId, threadId } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Get or create IDs
    const actualUserId = userId || uuidv4();
    const actualThreadId = threadId || uuidv4();
    
    // Create namespaced thread_id (userId:threadId) for LangGraph
    const fullThreadId = makeThreadId(actualUserId, actualThreadId);

    // Invoke the graph with thread_id AND user_id for cross-thread memory
    // LangGraph handles all persistence automatically!
    const result = await chatGraph.invoke(
      { messages: [new HumanMessage(message)] },
      { 
        configurable: { 
          thread_id: fullThreadId,
          user_id: actualUserId,  // Used by store for cross-thread memory
        } 
      }
    );

    const lastMessage = result.messages[result.messages.length - 1];
    const reply = typeof lastMessage.content === "string" 
      ? lastMessage.content 
      : JSON.stringify(lastMessage.content);

    res.json({ 
      reply,
      userId: actualUserId,
      threadId: actualThreadId,
    });
  } catch (error) {
    console.error("Error in chat:", error);
    res.status(500).json({ error: "Failed to process chat" });
  }
});

// Start server
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`
🚀 Backend running on http://localhost:${PORT}
📦 Using LangGraph PostgreSQL checkpointer for persistence
📝 Using PostgreSQL memory store for cross-thread user memory (persistent)
  `);
});

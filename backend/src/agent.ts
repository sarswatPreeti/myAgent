import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { memoryStore } from "./graph.js";

// Use OpenRouter API (compatible with OpenAI SDK)
const llm = new ChatOpenAI({
  model: "openai/gpt-4o-mini", // OpenRouter model format
  temperature: 0.7,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
});

// Helper to extract facts about the user from conversation
async function extractUserFacts(messages: any[]): Promise<string[]> {
  const recentMessages = messages.slice(-6); // Last 3 exchanges
  const conversation = recentMessages
    .map((m) => `${m._getType?.() === "human" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  if (!conversation.trim()) return [];

  try {
    const extractionPrompt = `Extract any personal facts about the user from this conversation. 
Return ONLY a JSON array of strings with facts like name, preferences, location, job, interests, etc.
If no personal facts found, return empty array [].
Examples: ["User's name is John", "User likes pizza", "User works as a developer"]

Conversation:
${conversation}

JSON array:`;

    const result = await llm.invoke([{ role: "user", content: extractionPrompt }]);
    const content = typeof result.content === "string" ? result.content : "";
    
    // Parse JSON from response
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      const facts = JSON.parse(match[0]);
      return Array.isArray(facts) ? facts.filter((f: any) => typeof f === "string") : [];
    }
  } catch (e) {
    console.error("❌ Error extracting facts:", e);
  }
  return [];
}

export async function chatAgent(state: any, config: LangGraphRunnableConfig) {
  // Get user_id from config for cross-thread memory
  const userId = config.configurable?.user_id;
  
  console.log(`🔍 DEBUG: user_id = ${userId}`);
  
  // Namespace for this user's memories: [user_id, "memories"]
  const namespace = [userId || "anonymous", "memories"];
  
  // Get existing memories about this user from LangGraph's store
  let userMemories: string[] = [];
  if (userId) {
    try {
      const items = await memoryStore.search(namespace);
      console.log(`🔍 DEBUG: Found ${items.length} items in store for namespace ${namespace.join(":")}`);
      userMemories = items.map((item: any) => item.value?.fact).filter(Boolean);
      if (userMemories.length > 0) {
        console.log(`📚 Loaded ${userMemories.length} memories for user`);
      }
    } catch (e) {
      console.error("❌ Error loading memories:", e);
    }
  } else {
    console.log(`⚠️ DEBUG: No user_id in config!`);
  }

  // Build system message with user memories
  let systemContent = "You are a helpful AI assistant.";
  if (userMemories.length > 0) {
    systemContent += `\n\nThings you remember about this user from previous conversations:\n${userMemories.map((m) => `- ${m}`).join("\n")}\n\nUse this information naturally in your responses when relevant.`;
  }

  const messagesWithSystem = [
    new SystemMessage(systemContent),
    ...state.messages,
  ];

  const response = await llm.invoke(messagesWithSystem);

  // Extract and save new facts about the user
  if (userId) {
    extractUserFacts(state.messages).then(async (newFacts) => {
      for (const fact of newFacts) {
        // Check if we already have this fact
        const isDuplicate = userMemories.some((m) => 
          m.toLowerCase().includes(fact.toLowerCase().slice(0, 20)) ||
          fact.toLowerCase().includes(m.toLowerCase().slice(0, 20))
        );
        
        if (!isDuplicate) {
          const memoryId = `memory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await memoryStore.put(namespace, memoryId, { fact, createdAt: new Date().toISOString() });
          console.log(`💾 New memory saved: "${fact.slice(0, 50)}..."`);
        }
      }
    }).catch((e) => console.error("❌ Error saving memory:", e));
  }

  return {
    messages: [response],
  };
}

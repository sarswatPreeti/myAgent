import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, ToolMessage, AIMessage  } from "@langchain/core/messages";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { memoryStore } from "./memoryStore.ts";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const client = new MultiServerMCPClient({  
    weather: {
        transport: "http",  // HTTP-based remote server
        // Ensure you start your weather server on port 8000
        url: "http://localhost:8000/mcp",
    },
});

// Use OpenRouter API (compatible with OpenAI SDK)
const llm = new ChatOpenAI({
  model: "openai/gpt-4o-mini", // OpenRouter model format
  temperature: 0.7,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
});

const tools = await client.getTools();
const llmWithTools = llm.bindTools(tools);

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

    const result = await llm.invoke([
      new HumanMessage(extractionPrompt),
    ]);

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
  
  // Get existing memories about this user from our PostgreSQL memory store
  let userMemories: string[] = [];
  if (userId) {
    try {
      const items = await memoryStore.search(namespace);
      console.log(`🔍 DEBUG: Found ${items.length} items in PostgreSQL for namespace ${namespace.join(":")}`);
      userMemories = items.map((item: any) => item.value?.fact).filter(Boolean);
      if (userMemories.length > 0) {
        console.log(`📚 Loaded ${userMemories.length} memories for user:`, userMemories);
      }
    } catch (e) {
      console.error("❌ Error loading memories:", e);
    }
  } else {
    console.log(`⚠️ DEBUG: No user_id in config!`);
  }

  // Build system message with user memories
  let systemContent = "You are a helpful AI assistant with memory. You remember things users tell you about themselves across conversations.";
  if (userMemories.length > 0) {
    systemContent += `\n\nIMPORTANT - Things you remember about this user from previous conversations:\n${userMemories.map((m) => `- ${m}`).join("\n")}\n\nUse this information naturally in your responses. If the user asks who they are or something you know, tell them!`;
  }

  const last = state.messages[state.messages.length - 1];

  const hasSystem = state.messages.some(
    (m: any) => m._getType?.() === "system"
  );

  const baseMessages = hasSystem
    ? state.messages
    : [
        new SystemMessage(
          "You are a helpful assistant. If you receive tool results, you MUST use them to answer the user."
        ),
        ...state.messages,
      ];

  // ✅ CRITICAL: If last message is ToolMessage, FORCE the model to answer
  if (last instanceof ToolMessage) {
    const response = await llmWithTools.invoke(baseMessages);
    return { messages: [response] };
  }

  const response = await llmWithTools.invoke(baseMessages);

  // Extract and save new facts about the user (await to ensure it completes)
  if (userId) {
    try {
      const last = state.messages[state.messages.length - 1];
      if (last?.tool_calls?.length) return { messages: [response] };
      const newFacts = await extractUserFacts(state.messages);

      for (const fact of newFacts) {
        // Check if we already have this fact
        const isDuplicate = userMemories.some((m) => 
          m.toLowerCase().includes(fact.toLowerCase().slice(0, 20)) ||
          fact.toLowerCase().includes(m.toLowerCase().slice(0, 20))
        );
        
        if (!isDuplicate) {
          const memoryId = `memory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await memoryStore.put(namespace, memoryId, { fact, createdAt: new Date().toISOString() });
          console.log(`💾 New memory saved to PostgreSQL: "${fact}"`);
        }
      }
    } catch (e) {
      console.error("❌ Error saving memory:", e);
    }
  }

  return {
    messages: [response],
  };
}

export async function toolNode(state: any) {
  const lastMessage = state.messages[state.messages.length - 1];

  if (!lastMessage.tool_calls?.length) {
    return {};
  }

  const toolCall = lastMessage.tool_calls[0];
  const tool = tools.find(t => t.name === toolCall.name);

  if (!tool) {
    throw new Error(`❌ Tool not found: ${toolCall.name}`);
  }

  const result = await tool.invoke(toolCall.args);

  return {
    messages: [
      new ToolMessage({
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      }),
    ],
  };
}

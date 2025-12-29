import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { memoryStore } from "./memoryStore.ts";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// const client = new MultiServerMCPClient({  
//     weather: {
//         transport: "http",  // HTTP-based remote server
//         // Ensure you start your weather server on port 8000
//         url: "http://localhost:8000/mcp",
//     },
// });

// Get __dirname equivalent in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load server.json
const serverConfigPath = path.resolve(__dirname, "server.json");
const serverConfig = JSON.parse(fs.readFileSync(serverConfigPath, "utf-8"));

// Initialize MCP client using server.json
const client = new MultiServerMCPClient(serverConfig);

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

  const hasSystem = state.messages.some(
    (m: any) => m._getType?.() === "system"
  );

  let messages = hasSystem
    ? [...state.messages]
    : [
      new SystemMessage(systemContent),
      ...state.messages,
    ];

  let response;

  // Internal loop for tool execution
  while (true) {
    // Invoke LLM with current messages
    response = await llmWithTools.invoke(messages);

    // Check if the response has tool calls
    if (response.tool_calls && response.tool_calls.length > 0) {
      console.log(`🛠️ Executing ${response.tool_calls.length} tools internally...`);

      // Add the assistant's message with tool calls to history
      messages.push(response);

      // Execute all tools
      const toolMessages = [];
      for (const toolCall of response.tool_calls) {
        const tool = tools.find(t => t.name === toolCall.name);
        if (tool) {
          try {
            const result = await tool.invoke(toolCall.args);
            toolMessages.push(new ToolMessage({
              tool_call_id: (toolCall.id ?? "") as string,
              content: JSON.stringify(result),
            }));
          } catch (e: any) {
            console.error(`❌ Error executing tool ${toolCall.name}:`, e);
            toolMessages.push(new ToolMessage({
              tool_call_id: (toolCall.id ?? "") as string,
              content: `Error executing tool: ${e.message}`,
            }));
          }
        } else {
          toolMessages.push(new ToolMessage({
            tool_call_id: (toolCall.id ?? "") as string,
            content: `Error: Tool ${toolCall.name} not found`,
          }));
        }
      }

      // Add tool results to history
      messages.push(...toolMessages);

      // Loop continues to let LLM process tool results
    } else {
      // No more tool calls, we have the final response
      break;
    }
  }

  // Extract and save new facts about the user (await to ensure it completes)
  if (userId) {
    try {
      const newFacts = await extractUserFacts(messages);

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

  // Return only the final response to suppress intermediate tool outputs from the user view
  return {
    messages: [response],
  };
}

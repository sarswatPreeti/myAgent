// graph.ts
import { StateGraph, START, END, Annotation} from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
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
// 3️⃣ Compile Graph (LangGraph CLI handles checkpointing)
// --------------------
export const chatGraph = workflow.compile();

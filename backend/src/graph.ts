import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { chatAgent } from "./agent.js";

/* ---------------------------------- */
/* STATE */
/* ---------------------------------- */
const ChatState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

/* ---------------------------------- */
/* GRAPH */
/* ---------------------------------- */
const workflow = new StateGraph(ChatState)
  .addNode("agent", chatAgent)
  .addEdge(START, "agent")
  .addEdge("agent", END);

export const chatGraph = workflow.compile();

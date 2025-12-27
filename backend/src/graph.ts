import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { chatAgent, toolNode } from "./agent.js";

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
/* HELPER */
/* ---------------------------------- */
function getToolCalls(msg: any) {
  return msg?.additional_kwargs?.tool_calls ?? msg?.tool_calls ?? [];
}

/* ---------------------------------- */
/* GRAPH */
/* ---------------------------------- */
const workflow = new StateGraph(ChatState)
  .addNode("agent", chatAgent)
  .addNode("tool", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", (state) => {
    const last = state.messages[state.messages.length - 1];
    const toolCalls = getToolCalls(last);

    if (last instanceof AIMessage && toolCalls.length > 0) {
      return "tool";
    }
    return END;
  })
  .addEdge("tool", "agent");

export const chatGraph = workflow.compile();

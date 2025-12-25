import { useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from "react";
import { Client } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/langgraph-sdk/react";

// Error Boundary to catch runtime errors
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Error caught by boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-slate-900 text-white">
          <div className="text-center p-8">
            <h1 className="text-2xl font-bold mb-4">Something went wrong</h1>
            <p className="text-red-400 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-violet-600 rounded-lg hover:bg-violet-500"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export { ErrorBoundary };

type Thread = {
  id: string;
  title: string;
  messageCount: number;
};

// LangGraph CLI runs on port 2024 by default
const API_URL = "http://localhost:2024";
const client = new Client({ apiUrl: API_URL });
const ASSISTANT_ID = "agent"; // Must match the graph name in langgraph.json

// Get or create user ID from localStorage
function getUserId(): string {
  let userId = localStorage.getItem("chat_user_id");
  if (!userId) {
    userId = crypto.randomUUID();
    localStorage.setItem("chat_user_id", userId);
  }
  return userId;
}

// Icons as components
const PlusIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
  </svg>
);

const MenuIcon = () => (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

const SendIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
  </svg>
);

const ChatIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const SparklesIcon = () => (
  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
  </svg>
);

const UserIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </svg>
);

const BotIcon = () => (
  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2M7.5 13A1.5 1.5 0 006 14.5 1.5 1.5 0 007.5 16 1.5 1.5 0 009 14.5 1.5 1.5 0 007.5 13m9 0a1.5 1.5 0 00-1.5 1.5 1.5 1.5 0 001.5 1.5 1.5 1.5 0 001.5-1.5 1.5 1.5 0 00-1.5-1.5M9 18h6v1H9v-1z"/>
  </svg>
);

export default function App() {
  const [input, setInput] = useState("");
  const [userId] = useState(getUserId);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* ---------------- STREAM ---------------- */
  const stream = useStream({
    apiUrl: API_URL,
    assistantId: ASSISTANT_ID,
    threadId: threadId ?? undefined,
    onThreadId: (newThreadId) => {
      // Capture thread ID when useStream creates a new thread
      if (newThreadId && newThreadId !== threadId) {
        setThreadId(newThreadId);
        loadThreads();
      }
    },
  });

  const { messages = [], isLoading } = stream;

  /* ---------------- EFFECTS ---------------- */

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    loadThreads();
  }, [userId]);

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = "auto";
    inputRef.current.style.height =
      Math.min(inputRef.current.scrollHeight, 200) + "px";
  }, [input]);

  /* ---------------- THREADS ---------------- */

  async function loadThreads() {
    try {
      const results = await client.threads.search({
        metadata: { user_id: userId },
        limit: 100,
      });

      setThreads(
        results.map((t) => ({
          id: t.thread_id,
          title: (t.metadata?.title as string) ?? "New Chat",
          messageCount: (t.metadata?.message_count as number) ?? 0,
        }))
      );
    } catch (e) {
      console.error("Load threads failed", e);
    }
  }

  async function loadThread(id: string) {
    setThreadId(id);
  }

  async function deleteThread(id: string) {
    await client.threads.delete(id);
    if (id === threadId) setThreadId(null);
    loadThreads();
  }

  /* ---------------- SEND MESSAGE ---------------- */

  async function sendMessage() {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");

    try {
      stream.submit(
        { messages: [{ type: "human", content: userMessage }] },
        {
          threadId: threadId ?? undefined,
          config: {
            configurable: {
              user_id: userId,
            },
          },
          metadata: {
            user_id: userId,
            title: userMessage.slice(0, 50), // Use first message as thread title
          },
        }
      );
    } catch (e) {
      console.error("Send failed", e);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="flex h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Sidebar */}
      <div
        className={`${
          showSidebar ? "w-72" : "w-0"
        } transition-all duration-300 ease-in-out overflow-hidden`}
      >
        <div className="w-72 h-full bg-slate-950/50 backdrop-blur-xl border-r border-slate-700/50 flex flex-col">
          {/* Sidebar Header */}
          <div className="p-4">
            <button
              onClick={() => setThreadId(null)}
              className="w-full py-3 px-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 rounded-xl font-medium transition-all duration-200 flex items-center justify-center gap-2 shadow-lg shadow-violet-500/20 hover:shadow-violet-500/30"
            >
              <PlusIcon />
              New Chat
            </button>
          </div>

          {/* Threads List */}
          <div className="flex-1 overflow-y-auto px-3 space-y-1">
            {threads.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                <ChatIcon />
                <p className="mt-2 text-sm">No conversations yet</p>
              </div>
            ) : (
              threads.map((thread) => (
                <div
                  key={thread.id}
                  className={`group p-3 rounded-xl cursor-pointer transition-all duration-200 flex items-center gap-3 ${
                    threadId === thread.id
                      ? "bg-slate-700/50 shadow-lg"
                      : "hover:bg-slate-800/50"
                  }`}
                  onClick={() => loadThread(thread.id)}
                >
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500/20 to-indigo-500/20 flex items-center justify-center text-violet-400">
                    <ChatIcon />
                  </div>
                  <span className="truncate flex-1 text-sm text-slate-300">
                    {thread.title || "New Chat"}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteThread(thread.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-all"
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* User Info */}
          <div className="p-4 border-t border-slate-700/50">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/50">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
                <UserIcon />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200 truncate">User</p>
                <p className="text-xs text-slate-500 truncate">{userId.substring(0, 12)}...</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="h-16 px-4 flex items-center gap-4 bg-slate-900/50 backdrop-blur-xl border-b border-slate-700/50">
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className="p-2 rounded-lg hover:bg-slate-800/50 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <MenuIcon />
          </button>
          
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <BotIcon />
            </div>
            <div>
              <h1 className="font-semibold text-slate-100">AI Assistant</h1>
              <p className="text-xs text-slate-500">Powered by LangGraph</p>
            </div>
          </div>

          {threadId && (
            <div className="ml-auto px-3 py-1.5 rounded-full bg-slate-800/50 text-xs text-slate-400 font-mono">
              {threadId.substring(0, 8)}
            </div>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-4 py-8">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center mb-6 shadow-2xl shadow-violet-500/30">
                  <SparklesIcon />
                </div>
                <h2 className="text-2xl font-bold text-slate-100 mb-2">How can I help you today?</h2>
                <p className="text-slate-400 max-w-md">
                  Start a conversation with me. I'm here to help answer your questions and assist with various tasks.
                </p>
                <div className="mt-8 grid grid-cols-2 gap-3">
                  {["Explain quantum computing", "Write a poem", "Help me code", "Brainstorm ideas"].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setInput(suggestion)}
                      className="px-4 py-3 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 text-sm transition-colors border border-slate-700/50 hover:border-slate-600/50"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {messages.map((m, i) => {
                  const role = m.type === "human" ? "user" : "assistant";

                  return (
                    <div
                      key={i}
                      className={`flex gap-4 ${role === "user" ? "flex-row-reverse" : ""}`}
                    >
                      <div
                        className={`w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center ${
                          role === "user"
                            ? "bg-gradient-to-br from-emerald-500 to-teal-600"
                            : "bg-gradient-to-br from-violet-500 to-indigo-600"
                        }`}
                      >
                        {role === "user" ? <UserIcon /> : <BotIcon />}
                      </div>

                      <div
                        className={`flex-1 max-w-[80%] ${
                          role === "user" ? "flex justify-end" : ""
                        }`}
                      >
                        <div
                          className={`inline-block px-4 py-3 rounded-2xl ${
                            role === "user"
                              ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-tr-md"
                              : "bg-slate-800/80 text-slate-200 rounded-tl-md border border-slate-700/50"
                          }`}
                        >
                          <pre className="whitespace-pre-wrap font-sans text-[15px] leading-relaxed">
                            {typeof m.content === "string"
                              ? m.content
                              : JSON.stringify(m.content, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {isLoading && (
                  <div className="flex gap-4">
                    <div className="w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center bg-gradient-to-br from-violet-500 to-indigo-600">
                      <BotIcon />
                    </div>
                    <div className="bg-slate-800/80 border border-slate-700/50 px-4 py-3 rounded-2xl rounded-tl-md">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" />
                        <div className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                        <div className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                      </div>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Input Area */}
        <div className="p-4 bg-slate-900/50 backdrop-blur-xl border-t border-slate-700/50">
          <div className="max-w-4xl mx-auto">
            <div className="relative flex items-end gap-3 bg-slate-800/50 rounded-2xl border border-slate-700/50 p-2 focus-within:border-violet-500/50 focus-within:shadow-lg focus-within:shadow-violet-500/10 transition-all">
              <textarea
                ref={inputRef}
                className="flex-1 bg-transparent px-3 py-2 text-slate-100 placeholder-slate-500 resize-none focus:outline-none max-h-[200px]"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Message AI Assistant..."
                disabled={isLoading}
                rows={1}
              />
              <button
                onClick={sendMessage}
                disabled={isLoading || !input.trim()}
                className="p-3 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-violet-500/20 disabled:shadow-none"
              >
                <SendIcon />
              </button>
            </div>
            <p className="text-center text-xs text-slate-500 mt-3">
              AI can make mistakes. Consider checking important information.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

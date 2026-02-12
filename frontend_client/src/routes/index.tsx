import {
  $,
  component$,
  noSerialize,
  useSignal,
  useStore,
  useTask$,
} from "@builder.io/qwik";
import type { DocumentHead } from "@builder.io/qwik-city";
import { connectAssistantWs, fetchHealth } from "../lib/api";

type Role = "user" | "assistant" | "system";

type ChatMessage = {
  id: string;
  role: Role;
  text: string;
  ts: number;
};

const nowId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const formatTime = (ts: number) => {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const DEFAULT_SUGGESTIONS = [
  "Summarize my last message",
  "Give me 3 smart replies",
  "Draft a friendly email response",
  "Turn this into a checklist",
  "Explain like I'm 5",
];

// PUBLIC_INTERFACE
export default component$(() => {
  const backend = useStore({
    health: "unknown" as "unknown" | "ok" | "error",
    statusCode: 0,
    ws: "closed" as "connecting" | "open" | "closed" | "error",
  });

  const wsRef = useSignal<ReturnType<typeof noSerialize<WebSocket>> | null>(
    null,
  );
  const pendingToSend = useSignal<string | null>(null);
  const input = useSignal("");
  const isListening = useSignal(false);

  const history = useStore<{
    sessions: { id: string; title: string; items: ChatMessage[] }[];
  }>({
    sessions: [
      {
        id: "default",
        title: "Tonight's Run",
        items: [
          {
            id: nowId(),
            role: "system",
            text:
              "Retro Assistant ready. Tip: click VOX to dictate (browser support required).",
            ts: Date.now(),
          },
        ],
      },
    ],
  });

  const activeSessionId = useSignal("default");

  const getActiveSession = () =>
    history.sessions.find((s) => s.id === activeSessionId.value)!;

  const appendMessage$ = $((role: Role, text: string) => {
    // NOTE: keep this function only touching serializable stores/signals.
    const msg: ChatMessage = { id: nowId(), role, text, ts: Date.now() };
    const sess = history.sessions.find((s) => s.id === activeSessionId.value);
    if (!sess) return;
    sess.items = [...sess.items, msg];
  });

  const clearSession$ = $(() => {
    const sess = history.sessions.find((s) => s.id === activeSessionId.value);
    if (!sess) return;
    sess.items = [
      {
        id: nowId(),
        role: "system",
        text: "Session cleared. Awaiting your next prompt.",
        ts: Date.now(),
      },
    ];
  });

  const sendMessage$ = $(() => {
    const text = input.value.trim();
    if (!text) return;

    void appendMessage$("user", text);
    input.value = "";

    // Actual WS send happens in useTask$ (imperative, non-serializable)
    pendingToSend.value = text;
  });

  const startStopListening$ = $(async () => {
    // Web Speech API is browser-only; in SSR it won't exist.
    const SpeechRecognitionCtor =
      (globalThis as any).SpeechRecognition ||
      (globalThis as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      void appendMessage$(
        "system",
        "Voice input not supported in this browser (SpeechRecognition unavailable).",
      );
      return;
    }

    if (isListening.value) {
      // We don't keep a global instance; toggling off just flips state.
      isListening.value = false;
      return;
    }

    isListening.value = true;

    const recog = new SpeechRecognitionCtor();
    recog.continuous = false;
    recog.interimResults = true;
    recog.lang = "en-US";

    let finalTranscript = "";

    recog.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0]?.transcript ?? "";
        if (res.isFinal) finalTranscript += transcript;
        else interim += transcript;
      }
      input.value = (finalTranscript + " " + interim).trim();
    };

    recog.onerror = () => {
      isListening.value = false;
      void appendMessage$("system", "Voice input error. Try again.");
    };

    recog.onend = () => {
      isListening.value = false;
    };

    recog.start();
  });

  useTask$(async ({ track, cleanup }) => {
    // Run once on mount (track reads to react to later changes)
    track(() => pendingToSend.value);

    // REST health check (safe to do here)
    try {
      const res = await fetchHealth();
      backend.health = res.ok ? "ok" : "error";
      backend.statusCode = res.status;
    } catch {
      backend.health = "error";
      backend.statusCode = 0;
    }

    // Connect WS (imperative, non-serializable)
    if (!wsRef.value) {
      const ws = connectAssistantWs({
        onStatus: (s) => (backend.ws = s),
        onMessage: (text) => {
          const trimmed = String(text).trim();
          if (!trimmed) return;
          // Qwik event handler can be called from here; it only updates serializable stores.
          void appendMessage$("assistant", trimmed);
        },
      });

      wsRef.value = noSerialize(ws);

      cleanup(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    }

    // Send pending message if WS is ready
    const toSend = pendingToSend.value;
    if (!toSend) return;

    const ws = wsRef.value as unknown as WebSocket | null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(toSend);
    } else {
      void appendMessage$(
        "assistant",
        "WS not connected yet. Please retry in a second.",
      );
    }
    pendingToSend.value = null;
  });

  const suggestionClick$ = $((s: string) => {
    input.value = s;
  });

  const newSession$ = $(() => {
    const id = nowId();
    const title = `Session ${history.sessions.length + 1}`;
    history.sessions = [
      ...history.sessions,
      {
        id,
        title,
        items: [
          {
            id: nowId(),
            role: "system",
            text: "New session created. Say hello.",
            ts: Date.now(),
          },
        ],
      },
    ];
    activeSessionId.value = id;
  });

  return (
    <>
      <header class="topbar">
        <div class="brandRow">
          <div class="brand" aria-label="Retro Voice Assistant">
            <div class="logoMark" aria-hidden="true" />
            <div class="brandText">
              <div class="brandTitle">Neon Voice Assistant</div>
              <div class="brandSubtitle">
                Web + Mobile-ready UI • REST health • WebSocket stream
              </div>
            </div>
          </div>

          <div class="statusPill" role="status" aria-live="polite">
            <span
              class={[
                "dot",
                backend.health === "ok" ? "" : "dotOffline",
              ]}
              aria-hidden="true"
            />
            <span class="mono">
              API {backend.health.toUpperCase()}
              {backend.statusCode ? `:${backend.statusCode}` : ""}
              {"  "}• WS {backend.ws.toUpperCase()}
            </span>
          </div>
        </div>
      </header>

      <div class="shell">
        {/* Main assistant panel */}
        <section class="panel" aria-label="Assistant chat">
          <div class="panelHeader">
            <div>
              <h1 class="panelTitle">Console</h1>
              <p class="panelHint">
                Type a prompt, or press <kbd>Enter</kbd>. Use <kbd>Shift</kbd>+
                <kbd>Enter</kbd> for a newline.
              </p>
            </div>

            <div style="display:flex; gap:10px; align-items:center;">
              <span class="badge">
                <span class="mono">Session</span>
                <span class="mono">{activeSession().title}</span>
              </span>
              <button class="btn btnDanger focus-ring" onClick$={clearSession$}>
                Clear
              </button>
            </div>
          </div>

          <div class="panelBody">
            <div class="chatLog" aria-label="Chat messages">
              {activeSession().items.map((m) => (
                <div key={m.id} class="msgRow">
                  <div class="avatar" aria-hidden="true">
                    {m.role === "user" ? "YOU" : m.role === "assistant" ? "AI" : "SYS"}
                  </div>
                  <div
                    class={[
                      "bubble",
                      m.role === "user"
                        ? "bubbleUser"
                        : m.role === "assistant"
                          ? "bubbleAssistant"
                          : "",
                    ]}
                  >
                    <div class="bubbleMeta">
                      <div class="bubbleRole">{m.role}</div>
                      <div class="bubbleTime">{formatTime(m.ts)}</div>
                    </div>
                    <p class="bubbleText">{m.text}</p>
                  </div>
                </div>
              ))}
            </div>

            <div class="divider" />

            <div>
              <h2 class="panelTitle" style="margin:0 0 10px;">
                Smart Replies
              </h2>
              <div class="suggestions" aria-label="Smart reply suggestions">
                {DEFAULT_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    class="chip focus-ring"
                    onClick$={() => suggestionClick$(s)}
                    type="button"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div class="divider" />

            <div class="footerRow" aria-label="Input area">
              <textarea
                class="input focus-ring"
                rows={3}
                value={input.value}
                placeholder="Ask the assistant…"
                onInput$={(e) =>
                  (input.value = (e.target as HTMLTextAreaElement).value)
                }
                onKeyDown$={(e) => {
                  const ev = e as unknown as KeyboardEvent;
                  if (ev.key === "Enter" && !ev.shiftKey) {
                    ev.preventDefault();
                    void sendMessage$();
                  }
                }}
              />

              <button
                class={["voiceBtn", isListening.value ? "voiceBtnActive" : ""].join(" ")}
                onClick$={startStopListening$}
                type="button"
                aria-pressed={isListening.value}
                aria-label={isListening.value ? "Stop voice input" : "Start voice input"}
              >
                VOX
              </button>
            </div>

            <div style="margin-top:10px; display:flex; gap:10px; justify-content:flex-end;">
              <button class="btn btnPrimary focus-ring" onClick$={sendMessage$}>
                Send
              </button>
            </div>

            <p class="small" style="margin:10px 0 0;">
              Backend endpoints detected from schema: <span class="mono">GET /api/health/</span> and WebSocket URL from <span class="mono">VITE_WS_URL</span>.
            </p>
          </div>
        </section>

        {/* History panel */}
        <aside class="panel" aria-label="History">
          <div class="panelHeader">
            <div>
              <h2 class="panelTitle">History</h2>
              <p class="panelHint">Your local sessions (frontend-only for now).</p>
            </div>
            <button class="btn focus-ring" onClick$={newSession$}>
              New
            </button>
          </div>

          <div class="panelBody">
            <div class="list" role="list">
              {history.sessions.map((s) => {
                const isActive = s.id === activeSessionId.value;
                const last = s.items[s.items.length - 1];
                return (
                  <button
                    key={s.id}
                    class="listItem focus-ring"
                    type="button"
                    onClick$={() => (activeSessionId.value = s.id)}
                    style={
                      isActive
                        ? "border-color: rgba(255,79,216,0.45); box-shadow: 0 0 0 6px rgba(255,79,216,0.08); text-align:left;"
                        : "text-align:left;"
                    }
                  >
                    <div class="listItemTitle">{s.title}</div>
                    <div class="listItemBody">
                      {last.role ? `[${last.role}] ` : ""}
                      {last.text}
                    </div>
                  </button>
                );
              })}
            </div>

            <div class="divider" />

            <p class="small">
              Next step (backend integration): persist sessions + messages via REST once backend exposes endpoints beyond health.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
});

export const head: DocumentHead = {
  title: "Neon Voice Assistant",
  meta: [
    {
      name: "description",
      content:
        "Retro-themed AI voice assistant UI with WebSocket streaming and smart reply chips.",
    },
  ],
};

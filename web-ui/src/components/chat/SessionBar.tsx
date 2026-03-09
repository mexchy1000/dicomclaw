import { useState, useRef, useEffect } from "react";
import type { Session } from "../../types";

interface Props {
  sessions: Session[];
  currentSessionId: string;
  currentSessionTitle: string | null;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string, deleteFiles?: boolean) => void;
}

export default function SessionBar({
  sessions,
  currentSessionId,
  currentSessionTitle,
  onNewSession,
  onSelectSession,
  onDeleteSession,
}: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-secondary)",
        flexShrink: 0,
        minHeight: 32,
      }}
    >
      {/* Current session name */}
      <span
        style={{
          flex: 1,
          fontSize: 11,
          color: "var(--text-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {currentSessionId.startsWith("batch-") && (
          <span style={{
            fontSize: 8,
            fontWeight: 700,
            padding: "1px 4px",
            borderRadius: 3,
            background: "var(--accent)",
            color: "#fff",
            textTransform: "uppercase" as const,
            letterSpacing: 0.5,
            flexShrink: 0,
          }}>BATCH</span>
        )}
        {currentSessionTitle || currentSessionId.slice(0, 20)}
      </span>

      {/* New Chat button */}
      <button
        onClick={onNewSession}
        title="New Chat"
        style={{
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 4,
          fontSize: 16,
          color: "var(--text-muted)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        +
      </button>

      {/* Session list dropdown */}
      <div ref={dropdownRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          title="Session list"
          style={{
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            fontSize: 14,
            color: "var(--text-muted)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          &#x2261;
        </button>

        {dropdownOpen && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              width: 240,
              maxHeight: 300,
              overflowY: "auto",
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
              zIndex: 100,
              marginTop: 4,
            }}
          >
            {sessions.length === 0 && (
              <div style={{ padding: "12px", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
                No sessions
              </div>
            )}
            {sessions.filter((s) => s.message_count > 0 || s.id === currentSessionId).map((session) => {
              const isActive = session.id === currentSessionId;
              return (
                <div
                  key={session.id}
                  onClick={() => {
                    onSelectSession(session.id);
                    setDropdownOpen(false);
                  }}
                  style={{
                    padding: "6px 10px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: isActive ? "var(--accent-dim)" : "transparent",
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--text-primary)",
                      fontWeight: isActive ? 600 : 400,
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                  >
                    {session.id.startsWith("batch-") && (
                      <span style={{
                        fontSize: 7,
                        fontWeight: 700,
                        padding: "0px 3px",
                        borderRadius: 2,
                        background: "var(--accent)",
                        color: "#fff",
                        flexShrink: 0,
                      }}>B</span>
                    )}
                    {session.title || session.id.slice(0, 20)}
                  </span>
                  {session.message_count > 0 && (
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                      ({session.message_count})
                    </span>
                  )}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      // Check if session has files
                      let hasFiles = false;
                      try {
                        const res = await fetch(`/api/sessions/${session.id}/files`);
                        const files = await res.json();
                        hasFiles = Array.isArray(files) && files.length > 0;
                      } catch { /* ignore */ }

                      if (hasFiles) {
                        const ok = window.confirm(
                          `Session "${session.title || session.id.slice(0, 20)}" has result files.\nDelete session and all associated files?`
                        );
                        if (!ok) return;
                        onDeleteSession(session.id, true);
                      } else {
                        onDeleteSession(session.id);
                      }
                    }}
                    style={{
                      color: "var(--error, #f44)",
                      fontSize: 11,
                      padding: "0 3px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    x
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  sessionTitle?: string | null;
  agentStatus?: "idle" | "busy" | "queued";
  queueSize?: number;
  onCancelAgent?: () => void;
  selectedStudy?: string | null;
  onOpenSettings?: () => void;
}

export default function Header({
  sidebarOpen,
  onToggleSidebar,
  sessionTitle,
  agentStatus = "idle",
  queueSize = 0,
  onCancelAgent,
  selectedStudy,
  onOpenSettings,
}: Props) {
  return (
    <header
      style={{
        height: "var(--header-height)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 8,
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      {/* Sidebar toggle */}
      <button
        onClick={onToggleSidebar}
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--radius-sm)",
          color: "var(--text-secondary)",
        }}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
      >
        {"\u2630"}
      </button>

      {/* Brand */}
      <span style={{ fontWeight: 700, color: "var(--accent)", fontSize: 15 }}>
        DICOMclaw
      </span>

      {/* Session / Study info */}
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--text-secondary)",
          fontSize: 13,
        }}
      >
        {selectedStudy && (
          <span style={{ marginRight: 8, color: "var(--text-muted)" }}>
            Study: {selectedStudy}
          </span>
        )}
        {sessionTitle && (
          <span>{sessionTitle}</span>
        )}
      </span>

      {/* Agent status */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {agentStatus !== "idle" && (
          <>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: agentStatus === "busy" ? "var(--accent)" : "var(--warning)",
                animation: agentStatus === "busy" ? "statusPulse 1.5s infinite" : "none",
              }}
            />
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {agentStatus === "busy" ? "Working..." : `Queued (${queueSize})`}
            </span>
            {onCancelAgent && (
              <button
                onClick={onCancelAgent}
                style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--error)",
                  border: "1px solid var(--error)",
                }}
              >
                Cancel
              </button>
            )}
          </>
        )}
      </div>

      {/* Settings */}
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          title="Settings"
          style={{
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-muted)",
            fontSize: 18,
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          &#x2699;
        </button>
      )}
    </header>
  );
}

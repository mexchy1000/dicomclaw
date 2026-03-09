import { useState, useEffect } from "react";
import type { AppSettings } from "../../types";

interface Props {
  settings: AppSettings;
  onUpdate: (partial: Partial<AppSettings>) => void;
  onClose: () => void;
}

export default function SettingsPanel({ settings, onUpdate, onClose }: Props) {
  const [apiKey, setApiKey] = useState(settings.openrouterApiKey);
  const [model, setModel] = useState(settings.openrouterModel);
  const [visionModel, setVisionModel] = useState(settings.visionModel);
  const [chatModel, setChatModel] = useState(settings.chatModel);

  useEffect(() => {
    setApiKey(settings.openrouterApiKey);
    setModel(settings.openrouterModel);
    setVisionModel(settings.visionModel);
    setChatModel(settings.chatModel);
  }, [settings]);

  const handleSave = () => {
    onUpdate({
      openrouterApiKey: apiKey,
      openrouterModel: model,
      visionModel: visionModel,
      chatModel: chatModel,
    });
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    background: "var(--bg-input)",
    border: "1px solid var(--border-light)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text-primary)",
    fontSize: 13,
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
    marginBottom: 4,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--bg-primary)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 24,
          width: 420,
          maxHeight: "80vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>Settings</h2>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>OpenRouter API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-or-..."
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Text Model</label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="anthropic/claude-sonnet-4"
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Vision Model (Agent skill)</label>
          <input
            value={visionModel}
            onChange={(e) => setVisionModel(e.target.value)}
            placeholder="moonshotai/kimi-k2.5"
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Chat Model (Chat mode)</label>
          <input
            value={chatModel}
            onChange={(e) => setChatModel(e.target.value)}
            placeholder="google/gemini-3.1-flash-lite-preview"
            style={inputStyle}
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 20px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-light)",
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              handleSave();
              onClose();
            }}
            style={{
              padding: "8px 20px",
              borderRadius: "var(--radius-sm)",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

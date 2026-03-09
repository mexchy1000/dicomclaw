import { useState, useRef, useEffect, useMemo } from "react";
import type { Skill } from "../../types";

export type ChatMode = "agent" | "chat";

interface VoiItem {
  id: number;
  label: string;
  color: string;
  suvMax?: number;
  detail?: string; // e.g., organ/lesion name for overlay VOIs
}

interface StudyItem {
  label: string;
  detail: string;
  value: string; // what gets inserted
}

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  skills?: Skill[];
  chatMode?: ChatMode;
  onToggleMode?: () => void;
  /** Available VOIs for @ mention */
  voiItems?: VoiItem[];
  /** Study info for @ mention */
  studyItems?: StudyItem[];
}

interface MentionItem {
  key: string;
  label: string;
  detail: string;
  value: string;
  color?: string;
  group: string;
}

export default function InputArea({ onSend, disabled, skills = [], chatMode = "agent", onToggleMode, voiItems = [], studyItems = [] }: Props) {
  const [text, setText] = useState("");
  const [showSkills, setShowSkills] = useState(false);
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skillsRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "24px";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    }
  }, [text]);

  // Close skills on outside click
  useEffect(() => {
    if (!showSkills) return;
    const handler = (e: MouseEvent) => {
      if (skillsRef.current && !skillsRef.current.contains(e.target as Node)) {
        setShowSkills(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSkills]);

  // Build mention items from VOIs + study
  const mentionItems = useMemo((): MentionItem[] => {
    const items: MentionItem[] = [];
    // Study items
    for (const s of studyItems) {
      items.push({
        key: `study-${s.label}`,
        label: s.label,
        detail: s.detail,
        value: s.value,
        group: "Study",
      });
    }
    // VOI items
    for (const v of voiItems) {
      const detailParts: string[] = [];
      if (v.detail) detailParts.push(v.detail);
      if (v.suvMax !== undefined) detailParts.push(`SUVmax ${v.suvMax.toFixed(1)}`);
      items.push({
        key: `voi-${v.id}`,
        label: v.label,
        detail: detailParts.join(" | ") || "",
        value: v.label,
        color: v.color,
        group: "VOI",
      });
    }
    return items;
  }, [voiItems, studyItems]);

  // Show mention menu when @ is typed
  useEffect(() => {
    if (mentionItems.length === 0) { setShowMentionMenu(false); return; }
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, cursorPos);
    const atMatch = before.match(/@(\w*)$/);
    if (atMatch) {
      setMentionFilter(atMatch[1].toLowerCase());
      setShowMentionMenu(true);
    } else {
      setShowMentionMenu(false);
    }
  }, [text, mentionItems]);

  // Close mention menu on outside click
  useEffect(() => {
    if (!showMentionMenu) return;
    const handler = (e: MouseEvent) => {
      if (mentionMenuRef.current && !mentionMenuRef.current.contains(e.target as Node)) {
        setShowMentionMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMentionMenu]);

  // Filter mention items by typed text after @
  const filteredMentions = useMemo(() => {
    if (!mentionFilter) return mentionItems;
    return mentionItems.filter((m) =>
      m.label.toLowerCase().includes(mentionFilter) ||
      m.group.toLowerCase().includes(mentionFilter)
    );
  }, [mentionItems, mentionFilter]);

  const insertMention = (value: string) => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, cursorPos);
    const after = text.slice(cursorPos);
    const atIdx = before.lastIndexOf("@");
    const newText = before.slice(0, atIdx) + `@${value} ` + after;
    setText(newText);
    setShowMentionMenu(false);
    textareaRef.current?.focus();
  };

  const handleSend = () => {
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
          padding: "8px 12px",
          background: "var(--bg-input)",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--border)",
        }}
      >
        {/* Agent/Chat toggle */}
        {onToggleMode && (
          <button
            onClick={onToggleMode}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              padding: "2px 3px",
              borderRadius: 10,
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border)",
              fontSize: 10,
              fontWeight: 600,
              cursor: "pointer",
              flexShrink: 0,
              height: 24,
            }}
            title={chatMode === "agent" ? "Agent mode: full ReAct analysis" : "Chat mode: direct VLM with viewer images"}
          >
            <span style={{
              padding: "2px 6px",
              borderRadius: 8,
              background: chatMode === "agent" ? "var(--accent)" : "transparent",
              color: chatMode === "agent" ? "#fff" : "var(--text-muted)",
              transition: "all 0.15s",
            }}>A</span>
            <span style={{
              padding: "2px 6px",
              borderRadius: 8,
              background: chatMode === "chat" ? "var(--accent)" : "transparent",
              color: chatMode === "chat" ? "#fff" : "var(--text-muted)",
              transition: "all 0.15s",
            }}>C</span>
          </button>
        )}

        {/* Skills button */}
        {skills.length > 0 && (
          <div ref={skillsRef} style={{ position: "relative" }}>
            <button
              onClick={() => setShowSkills(!showSkills)}
              style={{
                width: 28,
                height: 28,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "50%",
                color: "var(--text-muted)",
                fontSize: 16,
              }}
              title="Skills"
            >
              /
            </button>
            {showSkills && (
              <div
                style={{
                  position: "absolute",
                  bottom: 36,
                  left: 0,
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-light)",
                  borderRadius: "var(--radius-md)",
                  padding: 4,
                  width: 220,
                  maxHeight: 200,
                  overflowY: "auto",
                  zIndex: 100,
                }}
              >
                {skills.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setText((prev) => prev + `/${s.id} `);
                      setShowSkills(false);
                      textareaRef.current?.focus();
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "6px 8px",
                      textAlign: "left",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 13,
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>/{s.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* @ mention popup */}
        {showMentionMenu && filteredMentions.length > 0 && (
          <div ref={mentionMenuRef} style={{ position: "relative" }}>
            <div
              style={{
                position: "absolute",
                bottom: 36,
                left: 0,
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-light)",
                borderRadius: "var(--radius-md)",
                padding: 4,
                width: 240,
                maxHeight: 240,
                overflowY: "auto",
                zIndex: 100,
              }}
            >
              {/* Group headers */}
              {["Study", "VOI"].map((group) => {
                const items = filteredMentions.filter((m) => m.group === group);
                if (items.length === 0) return null;
                return (
                  <div key={group}>
                    <div style={{ fontSize: 9, color: "var(--text-muted)", padding: "4px 8px 2px", fontWeight: 700, textTransform: "uppercase" as const }}>
                      {group}
                    </div>
                    {items.map((m) => (
                      <button
                        key={m.key}
                        onClick={() => insertMention(m.value)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          width: "100%",
                          padding: "4px 8px",
                          textAlign: "left",
                          borderRadius: "var(--radius-sm)",
                          fontSize: 11,
                          background: "transparent",
                          border: "none",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                        }}
                      >
                        {m.color && (
                          <span style={{
                            width: 8, height: 8, borderRadius: "50%",
                            background: m.color, flexShrink: 0,
                          }} />
                        )}
                        {!m.color && (
                          <span style={{ fontSize: 10, flexShrink: 0, opacity: 0.5 }}>@</span>
                        )}
                        <span style={{ fontWeight: 600 }}>{m.label}</span>
                        {m.detail && (
                          <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>
                            {m.detail}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={chatMode === "chat" ? "Ask about the current view..." : "Ask DICOMclaw to analyze... (@ to mention)"}
          disabled={disabled}
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--text-primary)",
            fontSize: 14,
            lineHeight: "24px",
            minHeight: 24,
            maxHeight: 160,
          }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!text.trim() || disabled}
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: text.trim() && !disabled ? "var(--accent)" : "var(--bg-tertiary)",
            color: text.trim() && !disabled ? "#fff" : "var(--text-muted)",
            flexShrink: 0,
            transition: "background 0.15s",
          }}
        >
          &#x2191;
        </button>
      </div>

      <div style={{ textAlign: "center", fontSize: 10, color: "var(--text-muted)", marginTop: 5, lineHeight: 1.4 }}>
        <span style={{ fontWeight: 600 }}>A</span> Agent — multi-step analysis with tools &nbsp;&middot;&nbsp;
        <span style={{ fontWeight: 600 }}>C</span> Chat — quick VLM response from current view &nbsp;&middot;&nbsp;
        <span style={{ fontWeight: 600 }}>@</span> Mention study/VOI
      </div>
    </div>
  );
}

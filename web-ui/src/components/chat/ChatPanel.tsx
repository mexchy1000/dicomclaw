import { useRef, useEffect } from "react";
import type { Message, ReactStep, Skill, Session } from "../../types";
import MessageBubble from "./MessageBubble";
import InputArea, { type ChatMode } from "./InputArea";
import type { UserVoi } from "../../hooks/useViewerMarkers";
import type { OverlayData } from "../../hooks/useOverlays";
import ThinkingBlock from "./ThinkingBlock";
import PlanApproval from "./PlanApproval";
import SessionBar from "./SessionBar";

interface Props {
  messages: Message[];
  isTyping: boolean;
  onSendMessage: (text: string) => void;
  reactSteps: ReactStep[];
  currentIteration: string;
  isReactActive: boolean;
  plan: string | null;
  onApprovePlan: () => void;
  onModifyPlan: (feedback: string) => void;
  onRejectPlan: () => void;
  skills: Skill[];
  onImageClick: (src: string) => void;
  // Session management props
  sessions: Session[];
  currentSessionId: string;
  currentSessionTitle: string | null;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  chatMode?: ChatMode;
  onToggleMode?: () => void;
  userVois?: UserVoi[];
  overlayVois?: OverlayData[];
  studyInfo?: { label: string; detail: string; value: string }[];
}

export default function ChatPanel({
  messages,
  isTyping,
  onSendMessage,
  reactSteps,
  currentIteration,
  isReactActive,
  plan,
  onApprovePlan,
  onModifyPlan,
  onRejectPlan,
  skills,
  onImageClick,
  sessions,
  currentSessionId,
  currentSessionTitle,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  chatMode,
  onToggleMode,
  userVois = [],
  overlayVois = [],
  studyInfo = [],
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, reactSteps.length, isTyping, plan]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        background: "var(--bg-primary)",
      }}
    >
      {/* Session management bar */}
      <SessionBar
        sessions={sessions}
        currentSessionId={currentSessionId}
        currentSessionTitle={currentSessionTitle}
        onNewSession={onNewSession}
        onSelectSession={onSelectSession}
        onDeleteSession={onDeleteSession}
      />

      {/* Messages area */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 0", minHeight: 0 }}>
        <div style={{ maxWidth: "var(--max-chat-width)", margin: "0 auto", padding: "0 16px" }}>
          {messages.length === 0 && !isTyping && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "80px 20px",
                color: "var(--text-muted)",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 48, marginBottom: 16 }}>D</div>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: "var(--text-secondary)" }}>
                DICOMclaw
              </div>
              <div style={{ fontSize: 13, maxWidth: 400, lineHeight: 1.6 }}>
                Select a study from the worklist and ask me to analyze it.
                I can calculate SUV, detect lesions, segment organs, generate MIPs, and more.
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={i} role={msg.role} content={msg.content} timestamp={msg.timestamp} onImageClick={onImageClick} />
          ))}

          {/* Plan approval */}
          {plan && (
            <PlanApproval plan={plan} onApprove={onApprovePlan} onModify={onModifyPlan} onReject={onRejectPlan} />
          )}

          {/* Thinking indicator */}
          {(isReactActive || isTyping) && reactSteps.length > 0 && (
            <ThinkingBlock steps={reactSteps} currentIteration={currentIteration} isActive={isReactActive} />
          )}

          {/* Typing dots */}
          {isTyping && reactSteps.length === 0 && (
            <div style={{ display: "flex", gap: 4, padding: "12px 0" }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "var(--text-muted)",
                    animation: `dotPulse 1.4s infinite ease-in-out ${i * 0.16}s`,
                  }}
                />
              ))}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div style={{ maxWidth: "var(--max-chat-width)", margin: "0 auto", width: "100%", padding: "0 16px 12px" }}>
        <InputArea
          onSend={onSendMessage}
          disabled={isTyping}
          skills={skills}
          chatMode={chatMode}
          onToggleMode={onToggleMode}
          voiItems={[
            // Manual VOIs
            ...userVois.map((v) => ({
              id: v.id,
              label: v.label,
              color: v.color,
              suvMax: v.stats?.suvMax,
            })),
            // Overlay VOIs (from AutoPET, TotalSegmentator, etc.)
            ...overlayVois.flatMap((ov) =>
              ov.labels.map((l) => ({
                id: l.voiIndex ?? 0,
                label: `VOI${l.voiIndex ?? 0}`,
                color: l.color,
                suvMax: ov.metadata?.find((m) => m.name === l.name)?.suv_max,
                detail: l.name,
              })),
            ),
          ]}
          studyItems={studyInfo}
        />
      </div>
    </div>
  );
}

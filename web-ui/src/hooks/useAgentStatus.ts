import { useState, useEffect, useCallback } from "react";
import type { Socket } from "socket.io-client";

interface AgentStatusData {
  status: "idle" | "busy" | "queued";
  queueSize: number;
  currentSessionId: string | null;
}

export function useAgentStatus(socket: Socket | null) {
  const [status, setStatus] = useState<"idle" | "busy" | "queued">("idle");
  const [queueSize, setQueueSize] = useState(0);

  useEffect(() => {
    if (!socket) return;
    const handler = (data: AgentStatusData) => {
      setStatus(data.status);
      setQueueSize(data.queueSize);
    };
    socket.on("agent-status", handler);
    return () => {
      socket.off("agent-status", handler);
    };
  }, [socket]);

  const cancelAgent = useCallback(
    (sessionId?: string) => {
      socket?.emit("cancel-agent", { sessionId: sessionId || "" });
    },
    [socket],
  );

  return { status, queueSize, cancelAgent };
}

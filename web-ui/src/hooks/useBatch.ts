import { useState, useEffect, useCallback } from "react";
import type { Socket } from "socket.io-client";

export interface BatchState {
  isRunning: boolean;
  batchSessionId: string | null;
  startBatch: (prompt: string, studyUids: string[]) => void;
}

export function useBatch(socket: Socket | null): BatchState {
  const [isRunning, setIsRunning] = useState(false);
  const [batchSessionId, setBatchSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!socket) return;

    const handleBatchStarted = (data: { sessionId: string }) => {
      setBatchSessionId(data.sessionId);
      setIsRunning(true);
    };

    const handleComplete = () => {
      setIsRunning(false);
    };

    socket.on("batch-started", handleBatchStarted);
    socket.on("batch-complete", handleComplete);

    return () => {
      socket.off("batch-started", handleBatchStarted);
      socket.off("batch-complete", handleComplete);
    };
  }, [socket]);

  const startBatch = useCallback((prompt: string, studyUids: string[]) => {
    fetch("/api/batch/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, studyUids }),
    }).catch(() => setIsRunning(false));
  }, []);

  return { isRunning, batchSessionId, startBatch };
}

import { useState, useEffect, useCallback } from "react";
import type { Socket } from "socket.io-client";
import type { SessionFile } from "../types";

export function useSessionFiles(socket: Socket | null, sessionId: string) {
  const [files, setFiles] = useState<SessionFile[]>([]);

  const fetchFiles = useCallback(() => {
    if (!sessionId) return;
    fetch(`/api/sessions/${sessionId}/files`)
      .then((r) => r.json())
      .then((data: SessionFile[]) => setFiles(data))
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  useEffect(() => {
    if (!socket) return;
    const handleFilesUpdated = (data: { sessionId: string; files: SessionFile[] }) => {
      if (data.sessionId === sessionId) setFiles(data.files);
    };
    socket.on("agent-files-updated", handleFilesUpdated);
    return () => {
      socket.off("agent-files-updated", handleFilesUpdated);
    };
  }, [socket, sessionId]);

  return { files, refreshFiles: fetchFiles };
}

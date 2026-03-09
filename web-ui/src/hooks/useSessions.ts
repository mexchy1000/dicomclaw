import { useState, useEffect, useCallback, useRef } from "react";
import type { Socket } from "socket.io-client";
import type { Session } from "../types";

export function useSessions(socket: Socket | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(
    () => `session-${Date.now()}`,
  );
  const unknownCounter = useRef(0);

  const fetchSessions = useCallback(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data: Session[]) => setSessions(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (!socket) return;
    const joinCurrent = () => {
      socket.emit("join-session", currentSessionId);
    };
    if (socket.connected) joinCurrent();
    socket.on("connect", joinCurrent);

    const handleTitleUpdate = (data: { sessionId: string; title: string }) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === data.sessionId ? { ...s, title: data.title } : s,
        ),
      );
    };
    socket.on("agent-session-title", handleTitleUpdate);
    return () => {
      socket.off("connect", joinCurrent);
      socket.off("agent-session-title", handleTitleUpdate);
    };
  }, [socket, currentSessionId]);

  const createSession = useCallback((label?: string) => {
    let newId: string;
    let title: string;
    if (label) {
      newId = `pt-${label}-${Date.now()}`;
      title = label;
    } else {
      unknownCounter.current += 1;
      title = `UNKNOWN${unknownCounter.current}`;
      newId = `session-${Date.now()}`;
    }
    setCurrentSessionId(newId);
    if (socket) socket.emit("join-session", newId);
    // Rename with title after creation
    fetch(`/api/sessions/${newId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => {});
    setTimeout(fetchSessions, 500);
    return newId;
  }, [socket, fetchSessions]);

  const selectSession = useCallback(
    (id: string) => {
      setCurrentSessionId(id);
      if (socket) socket.emit("join-session", id);
    },
    [socket],
  );

  const renameSession = useCallback((id: string, title: string) => {
    fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).then(() => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title } : s)),
      );
    });
  }, []);

  const deleteSessionById = useCallback(
    (id: string, deleteFiles?: boolean) => {
      const params = deleteFiles ? "?deleteFiles=true" : "";
      fetch(`/api/sessions/${id}${params}`, { method: "DELETE" }).then(() => {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (id === currentSessionId) {
          const newId = `session-${Date.now()}`;
          setCurrentSessionId(newId);
          if (socket) socket.emit("join-session", newId);
        }
      });
    },
    [socket, currentSessionId],
  );

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  const findSessionByTitle = useCallback(
    (title: string) => sessions.find((s) => s.title === title),
    [sessions],
  );

  return {
    sessions,
    currentSessionId,
    currentSession,
    createSession,
    selectSession,
    renameSession,
    deleteSession: deleteSessionById,
    refreshSessions: fetchSessions,
    findSessionByTitle,
  };
}

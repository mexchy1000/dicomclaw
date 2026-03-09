import { useState, useEffect, useCallback } from "react";
import type { Socket } from "socket.io-client";
import type { Message } from "../types";

export function useChat(socket: Socket | null, sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    setMessages([]);
    fetch(`/api/sessions/${sessionId}/messages`)
      .then((r) => r.json())
      .then((msgs: Message[]) => setMessages(msgs))
      .catch(() => setMessages([]));
  }, [sessionId]);

  useEffect(() => {
    if (!socket) return;
    const handleMessage = (data: { text: string; timestamp: number }) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: data.text,
          timestamp: new Date(data.timestamp).toISOString(),
        },
      ]);
      setIsTyping(false);
    };
    const handleTyping = (typing: boolean) => setIsTyping(typing);
    const handleError = (errMsg: string) => {
      setMessages((prev) => [
        ...prev,
        { role: "system" as const, content: `Error: ${errMsg}`, timestamp: new Date().toISOString() },
      ]);
      setIsTyping(false);
    };

    socket.on("agent-message", handleMessage);
    socket.on("agent-typing", handleTyping);
    socket.on("agent-error", handleError);
    return () => {
      socket.off("agent-message", handleMessage);
      socket.off("agent-typing", handleTyping);
      socket.off("agent-error", handleError);
    };
  }, [socket]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim() || !socket) return;
      setMessages((prev) => [
        ...prev,
        { role: "user" as const, content: text.trim(), timestamp: new Date().toISOString() },
      ]);
      socket.emit("send-message", { sessionId, text: text.trim() });
    },
    [socket, sessionId],
  );

  const addLocalMessage = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  return { messages, isTyping, sendMessage, addLocalMessage };
}

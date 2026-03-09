import { useState, useEffect, useCallback } from "react";
import type { Socket } from "socket.io-client";
import type { ReactStep } from "../types";

export function useReactSteps(socket: Socket | null, sessionId: string) {
  const [steps, setSteps] = useState<ReactStep[]>([]);
  const [currentIteration, setCurrentIteration] = useState<string>("");
  const [plan, setPlan] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    setSteps([]);
    setCurrentIteration("");
    setPlan(null);
    setIsActive(false);
  }, [sessionId]);

  useEffect(() => {
    if (!socket) return;

    const handleStep = (data: ReactStep & { sessionId: string }) => {
      if (data.sessionId !== sessionId) return;
      setIsActive(true);

      if (data.type === "iteration") {
        setCurrentIteration(data.content);
      } else if (data.type === "plan") {
        setPlan(data.content);
      } else if (data.type === "final") {
        setIsActive(false);
      }

      setSteps((prev) => [...prev, data]);
    };

    const handleTyping = (typing: boolean) => {
      if (typing) {
        setSteps([]);
        setIsActive(true);
      } else {
        setIsActive(false);
      }
    };

    const handleCancelled = (data: { sessionId: string }) => {
      if (data.sessionId !== sessionId) return;
      setPlan(null);
      setIsActive(false);
      setSteps([]);
      setCurrentIteration("");
    };

    socket.on("agent-react-step", handleStep);
    socket.on("agent-typing", handleTyping);
    socket.on("agent-cancelled", handleCancelled);
    return () => {
      socket.off("agent-react-step", handleStep);
      socket.off("agent-typing", handleTyping);
      socket.off("agent-cancelled", handleCancelled);
    };
  }, [socket, sessionId]);

  const approvePlan = useCallback(() => {
    if (socket) {
      socket.emit("approve-plan", { sessionId });
      setPlan(null);
    }
  }, [socket, sessionId]);

  const modifyPlan = useCallback(
    (feedback: string) => {
      if (socket) {
        socket.emit("approve-plan", { sessionId, feedback });
        setPlan(null);
      }
    },
    [socket, sessionId],
  );

  const rejectPlan = useCallback(() => {
    if (socket) {
      socket.emit("approve-plan", {
        sessionId,
        feedback: "REJECT: User rejected this plan. Provide a Final Answer summarizing what was proposed and that it was not approved.",
      });
      setPlan(null);
    }
  }, [socket, sessionId]);

  return { steps, currentIteration, plan, isActive, approvePlan, modifyPlan, rejectPlan };
}

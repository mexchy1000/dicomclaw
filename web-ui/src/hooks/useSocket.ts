import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL || window.location.origin;

let globalSocket: Socket | null = null;

function getSocket(): Socket {
  if (!globalSocket) {
    globalSocket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });
  }
  return globalSocket;
}

export function useSocket() {
  const [socket] = useState<Socket>(() => getSocket());
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    if (socket.connected) setConnected(true);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [socket]);

  return { socket, connected };
}

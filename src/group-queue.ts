import pino from "pino";

const logger = pino({ name: "group-queue" });

interface QueuedMessage {
  sessionId: string;
  text: string;
  timestamp: number;
}

type MessageHandler = (sessionId: string, text: string) => Promise<void>;

export class GroupQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private handler: MessageHandler;

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  async enqueue(sessionId: string, text: string): Promise<void> {
    const groupKey = "main";

    if (!this.queues.has(groupKey)) {
      this.queues.set(groupKey, []);
    }

    this.queues.get(groupKey)!.push({
      sessionId,
      text,
      timestamp: Date.now(),
    });

    if (!this.processing.has(groupKey)) {
      await this.processQueue(groupKey);
    }
  }

  private async processQueue(groupKey: string): Promise<void> {
    if (this.processing.has(groupKey)) return;
    this.processing.add(groupKey);

    try {
      while (true) {
        const queue = this.queues.get(groupKey);
        if (!queue || queue.length === 0) break;

        const msg = queue.shift()!;
        try {
          await this.handler(msg.sessionId, msg.text);
        } catch (err) {
          logger.error({ sessionId: msg.sessionId, err }, "Failed to process queued message");
        }
      }
    } finally {
      this.processing.delete(groupKey);
    }
  }

  isProcessing(groupKey = "main"): boolean {
    return this.processing.has(groupKey);
  }

  getQueueSize(groupKey = "main"): number {
    return this.queues.get(groupKey)?.length || 0;
  }

  clearQueue(groupKey = "main"): number {
    const queue = this.queues.get(groupKey);
    const count = queue?.length || 0;
    this.queues.set(groupKey, []);
    return count;
  }
}

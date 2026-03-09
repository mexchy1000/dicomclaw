/**
 * Node.js OpenRouter Vision API client for direct VLM chat (no Python agent).
 */
import pino from "pino";

const logger = pino({ name: "vlm-client" });

interface VlmConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export async function queryVlm(
  systemPrompt: string,
  userMessage: string,
  images: string[],
  config: VlmConfig,
  history?: Array<{ role: string; content: string }>,
): Promise<string> {
  if (!config.apiKey) {
    return "Error: No API key configured. Set OpenRouter API key in Settings.";
  }

  // Build multimodal user message
  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  for (const img of images) {
    userContent.push({
      type: "image_url",
      image_url: { url: img.startsWith("data:") ? img : `data:image/png;base64,${img}` },
    });
  }

  userContent.push({ type: "text", text: userMessage });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add conversation history (text-only, before current message)
  if (history) {
    for (const msg of history) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
      }
    }
  }

  // Current user message with images
  messages.push({ role: "user", content: userContent });

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: 2048,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error({ status: resp.status, body: body.slice(0, 500) }, "VLM API error");
      return `API Error (${resp.status}): ${body.slice(0, 300)}`;
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content || "(empty response)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "VLM request failed");
    return `Error: ${msg}`;
  }
}

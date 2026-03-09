import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";

interface Props {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  onImageClick?: (src: string) => void;
}

export default function MessageBubble({ role, content, timestamp, onImageClick }: Props) {
  const roleColor = role === "user" ? "var(--accent)" : role === "system" ? "var(--error)" : "var(--purple)";
  const roleLabel = role === "user" ? "You" : role === "system" ? "System" : "DICOMclaw";

  const mdComponents: Components = {
    code({ className, children, ...rest }) {
      const match = /language-(\w+)/.exec(className || "");
      if (match) {
        return (
          <div style={{ margin: "8px 0", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "4px 12px",
                background: "var(--bg-tertiary)",
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              <span>{match[1]}</span>
            </div>
            <pre style={{ margin: 0 }}>
              <code className={className} {...rest}>
                {children}
              </code>
            </pre>
          </div>
        );
      }
      return (
        <code
          style={{
            background: "var(--bg-tertiary)",
            padding: "1px 5px",
            borderRadius: 4,
            fontSize: 13,
          }}
          {...rest}
        >
          {children}
        </code>
      );
    },
    table({ children }) {
      return (
        <div style={{ overflowX: "auto", margin: "8px 0" }}>
          <table
            style={{
              borderCollapse: "collapse",
              width: "100%",
              fontSize: 13,
            }}
          >
            {children}
          </table>
        </div>
      );
    },
    th({ children }) {
      return (
        <th
          style={{
            padding: "6px 10px",
            borderBottom: "2px solid var(--border-light)",
            textAlign: "left",
            fontWeight: 600,
          }}
        >
          {children}
        </th>
      );
    },
    td({ children }) {
      return (
        <td
          style={{
            padding: "6px 10px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {children}
        </td>
      );
    },
    img({ src, alt }) {
      const resolvedSrc = src?.startsWith("http") || src?.startsWith("data:")
        ? src
        : `/api/outputs/${src}`;
      return (
        <img
          src={resolvedSrc}
          alt={alt || ""}
          style={{ maxWidth: "100%", borderRadius: "var(--radius-sm)", cursor: "pointer", margin: "8px 0" }}
          onClick={() => onImageClick?.(resolvedSrc)}
        />
      );
    },
    blockquote({ children }) {
      return (
        <blockquote
          style={{
            borderLeft: "3px solid var(--accent)",
            paddingLeft: 12,
            margin: "8px 0",
            color: "var(--text-secondary)",
          }}
        >
          {children}
        </blockquote>
      );
    },
  };

  const formatTime = (ts?: string) => {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div style={{ marginBottom: 16, animation: "fadeIn 0.2s ease" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: roleColor }}>{roleLabel}</span>
        {timestamp && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{formatTime(timestamp)}</span>
        )}
      </div>

      {/* Content */}
      <div style={{ fontSize: 12.5, lineHeight: 1.65, color: "var(--text-primary)" }}>
        {role === "user" ? (
          <div style={{ whiteSpace: "pre-wrap" }}>{content}</div>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={mdComponents}
          >
            {content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import type { SessionFile } from "../../types";

interface Props {
  files: SessionFile[];
  sessionId: string;
  onClose: () => void;
  onImageClick: (src: string) => void;
}

type FilterType = "all" | "plots" | "documents" | "tables" | "data";

const TYPE_LABELS: Record<string, FilterType> = {
  png: "plots",
  jpg: "plots",
  jpeg: "plots",
  svg: "plots",
  gif: "plots",
  md: "documents",
  txt: "documents",
  pdf: "documents",
  csv: "tables",
  tsv: "tables",
  xlsx: "tables",
  nii: "data",
  "nii.gz": "data",
  dcm: "data",
};

function getFileCategory(name: string): FilterType {
  const lower = name.toLowerCase();
  for (const [ext, cat] of Object.entries(TYPE_LABELS)) {
    if (lower.endsWith(`.${ext}`)) return cat;
  }
  return "data";
}

function getFileIcon(name: string): string {
  const cat = getFileCategory(name);
  switch (cat) {
    case "plots": return "\uD83D\uDDBC";
    case "documents": return "\uD83D\uDCC4";
    case "tables": return "\uD83D\uDCCA";
    default: return "\uD83D\uDCC1";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function ResultsPanel({ files, sessionId, onClose, onImageClick }: Props) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const filtered = filter === "all" ? files : files.filter((f) => getFileCategory(f.file_name) === filter);
  const isImage = (name: string) => /\.(png|jpg|jpeg|gif|svg)$/i.test(name);

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((f) => f.id)));
    }
  };

  const downloadSelected = () => {
    for (const id of selected) {
      const a = document.createElement("a");
      a.href = `/api/sessions/${sessionId}/files/${id}/download`;
      a.download = "";
      a.click();
    }
  };

  return (
    <div style={styles.wrapper}>
      {/* Header */}
      <div style={styles.header}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Results</span>
        <button onClick={onClose} style={{ color: "var(--text-muted)", fontSize: 16, background: "none", border: "none", cursor: "pointer" }}>
          &times;
        </button>
      </div>

      {/* Filters */}
      <div style={styles.filters}>
        {(["all", "plots", "documents", "tables", "data"] as FilterType[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              ...styles.filterBtn,
              fontWeight: filter === f ? 600 : 400,
              background: filter === f ? "var(--accent-dim)" : "var(--bg-tertiary)",
              color: filter === f ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Select / Download bar */}
      {filtered.length > 0 && (
        <div style={styles.selectBar}>
          <label style={styles.selectAllLabel}>
            <input
              type="checkbox"
              checked={selected.size === filtered.length && filtered.length > 0}
              onChange={selectAll}
              style={{ accentColor: "var(--accent)" }}
            />
            <span style={{ fontSize: 10 }}>
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </span>
          </label>
          {selected.size > 0 && (
            <button onClick={downloadSelected} style={styles.dlBtn}>
              Download ({selected.size})
            </button>
          )}
        </div>
      )}

      {/* File list — scrollable */}
      <div style={styles.fileList}>
        {filtered.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            No files yet
          </div>
        )}
        {filtered.map((file) => (
          <div
            key={file.id}
            style={{
              ...styles.fileRow,
              background: selected.has(file.id) ? "rgba(74,158,255,0.08)" : "transparent",
            }}
          >
            <div style={styles.fileCheckCol}>
              <input
                type="checkbox"
                checked={selected.has(file.id)}
                onChange={() => toggleSelect(file.id)}
                style={{ accentColor: "var(--accent)" }}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Thumbnail */}
              {isImage(file.file_name) && (
                <img
                  src={file.url}
                  alt={file.file_name}
                  style={styles.thumb}
                  onClick={() => onImageClick(file.url)}
                />
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span>{getFileIcon(file.file_name)}</span>
                <span style={styles.fileName}>{file.file_name}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
                  {formatSize(file.size)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                {isImage(file.file_name) && (
                  <button onClick={() => onImageClick(file.url)} style={styles.actionBtn}>
                    View
                  </button>
                )}
                <a
                  href={`/api/sessions/${sessionId}/files/${file.id}/download`}
                  style={styles.actionLink}
                >
                  Download
                </a>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={styles.footer}>
        {files.length} file{files.length !== 1 ? "s" : ""}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-secondary)",
    minHeight: 0,
    flex: 1,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  filters: {
    display: "flex",
    gap: 4,
    padding: "8px 12px",
    flexWrap: "wrap" as const,
    flexShrink: 0,
  },
  filterBtn: {
    padding: "3px 10px",
    borderRadius: 12,
    fontSize: 11,
    textTransform: "capitalize" as const,
    border: "none",
    cursor: "pointer",
  },
  selectBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 12px",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  selectAllLabel: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    cursor: "pointer",
    color: "var(--text-muted)",
  },
  dlBtn: {
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: 4,
    background: "var(--accent, #4a9eff)",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    fontWeight: 600,
  },
  fileList: {
    flex: 1,
    overflowY: "auto" as const,
    minHeight: 0,
  },
  fileRow: {
    padding: "8px 12px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    gap: 8,
  },
  fileCheckCol: {
    display: "flex",
    alignItems: "flex-start",
    paddingTop: 2,
    flexShrink: 0,
  },
  thumb: {
    width: "100%",
    height: 140,
    objectFit: "cover" as const,
    borderRadius: "var(--radius-sm)",
    marginBottom: 6,
    cursor: "pointer",
  },
  fileName: {
    flex: 1,
    fontSize: 13,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  actionBtn: {
    fontSize: 11,
    color: "var(--accent)",
    padding: "2px 6px",
    background: "none",
    border: "none",
    cursor: "pointer",
  },
  actionLink: {
    fontSize: 11,
    color: "var(--text-muted)",
    padding: "2px 6px",
    textDecoration: "none",
  },
  footer: {
    padding: "8px 12px",
    borderTop: "1px solid var(--border)",
    fontSize: 11,
    color: "var(--text-muted)",
    textAlign: "center" as const,
    flexShrink: 0,
  },
};

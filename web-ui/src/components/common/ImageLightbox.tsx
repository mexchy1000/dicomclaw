interface Props {
  src: string;
  onClose: () => void;
}

export default function ImageLightbox({ src, onClose }: Props) {
  const resolvedSrc = src.startsWith("http") || src.startsWith("/api") || src.startsWith("data:")
    ? src
    : `/api/outputs/${src}`;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        cursor: "pointer",
      }}
      onClick={onClose}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.2)",
          color: "#fff",
          fontSize: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        &times;
      </button>

      <img
        src={resolvedSrc}
        alt=""
        style={{
          maxWidth: "90vw",
          maxHeight: "90vh",
          objectFit: "contain",
          borderRadius: "var(--radius-md)",
          cursor: "default",
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

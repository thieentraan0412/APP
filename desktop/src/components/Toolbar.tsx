import type { Tool } from "../types";

interface Props {
  tool: Tool;
  setTool: (t: Tool) => void;
  onDelete: () => void;
  canDelete: boolean;
  onBack: () => void;
  onSave: () => void;
  saving: boolean;
}

export function Toolbar(props: Props) {
  const { tool, setTool, onDelete, canDelete, onBack, onSave, saving } = props;
  return (
    <div className="toolbar">
      <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>
        ↖ Chọn
      </button>
      <button className={tool === "box" ? "active" : ""} onClick={() => setTool("box")}>
        ▭ Khung
      </button>
      <button className={tool === "note" ? "active" : ""} onClick={() => setTool("note")}>
        🏷 Ghi chú
      </button>
      <button onClick={onDelete} disabled={!canDelete}>
        🗑 Xoá
      </button>
      <span style={{ flex: 1 }} />
      <button onClick={onBack}>← Quay lại</button>
      <button className="primary" onClick={onSave} disabled={saving}>
        {saving ? "Đang lưu…" : "💾 Lưu"}
      </button>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { AnnotateCanvas } from "../components/AnnotateCanvas";
import { Toolbar } from "../components/Toolbar";
import { flattenStage, dataUrlToBlob } from "../lib/flatten";
import type { Annotations, Box, Note, Tool } from "../types";

const COLOR = "#ff2d2d"; // màu khung + note (đỏ)
const TOOLBAR_H = 56;
const PADDING = 24;

interface Props {
  imageDataUrl: string;
  initialAnnotations?: Annotations | null;
  onBack: () => void;
  onSaved: (flattened: Blob, original: Blob, annotations: Annotations) => void;
}

export function EditorScreen({ imageDataUrl, initialAnnotations, onBack, onSaved }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const stageRef = useRef<Konva.Stage>(null);
  const appliedInit = useRef(false);

  // Tải ảnh từ data URL
  useEffect(() => {
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = imageDataUrl;
  }, [imageDataUrl]);

  // Theo dõi kích thước cửa sổ để vừa khít ảnh
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Phím Delete → xoá phần tử đang chọn
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Tính tỉ lệ hiển thị vừa khít khung
  const fit = useMemo(() => {
    if (!img) return { scale: 1, w: 0, h: 0 };
    const maxW = viewport.w - PADDING * 2;
    const maxH = viewport.h - TOOLBAR_H - PADDING * 2;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    return { scale, w: img.width * scale, h: img.height * scale };
  }, [img, viewport]);

  // Nạp annotate cũ khi mở để SỬA (toạ độ gốc → toạ độ hiển thị)
  useEffect(() => {
    if (!img || appliedInit.current) return;
    if (initialAnnotations) {
      const s = fit.scale;
      setBoxes(initialAnnotations.boxes.map((b) => ({ ...b, x: b.x * s, y: b.y * s, w: b.w * s, h: b.h * s })));
      setNotes(initialAnnotations.notes.map((n) => ({ ...n, x: n.x * s, y: n.y * s })));
    }
    appliedInit.current = true;
  }, [img, fit.scale, initialAnnotations]);

  function deleteSelected() {
    if (!selectedId) return;
    setBoxes((prev) => prev.filter((b) => b.id !== selectedId));
    setNotes((prev) => prev.filter((n) => n.id !== selectedId));
    setSelectedId(null);
  }

  async function handleSave() {
    if (!stageRef.current || !img) return;
    setSaving(true);
    // Bỏ chọn để Transformer không bị vẽ vào ảnh xuất ra
    setSelectedId(null);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const pixelRatio = 1 / fit.scale; // xuất đúng độ phân giải gốc
    const blob = flattenStage(stageRef.current, pixelRatio);

    // Quy đổi toạ độ về kích thước ảnh gốc
    const s = fit.scale;
    const annotations: Annotations = {
      imageW: img.width,
      imageH: img.height,
      boxes: boxes.map((b) => ({ ...b, x: b.x / s, y: b.y / s, w: b.w / s, h: b.h / s })),
      notes: notes.map((n) => ({ ...n, x: n.x / s, y: n.y / s })),
    };

    // Ảnh gốc (để sau này sửa lại annotate)
    const original = dataUrlToBlob(imageDataUrl);

    setSaving(false);
    onSaved(blob, original, annotations);
  }

  return (
    <div className="editor">
      <Toolbar
        tool={tool}
        setTool={setTool}
        onDelete={deleteSelected}
        canDelete={!!selectedId}
        onBack={onBack}
        onSave={handleSave}
        saving={saving}
      />
      <div className="canvas-area">
        {img && (
          <AnnotateCanvas
            image={img}
            width={fit.w}
            height={fit.h}
            color={COLOR}
            tool={tool}
            setTool={setTool}
            boxes={boxes}
            setBoxes={setBoxes}
            notes={notes}
            setNotes={setNotes}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            stageRef={stageRef}
          />
        )}
      </div>
      <p className="hint editor-hint">
        Mẹo: chọn <b>Khung</b> rồi kéo chuột để kẻ ô; chọn <b>Ghi chú</b> rồi bấm để thêm chữ.
        Bấm đúp ghi chú để sửa. Chọn phần tử rồi nhấn <b>Delete</b> để xoá.
      </p>
    </div>
  );
}

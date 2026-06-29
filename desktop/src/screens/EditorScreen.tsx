import { useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { AnnotateCanvas } from "../components/AnnotateCanvas";
import { Toolbar } from "../components/Toolbar";
import { flattenStage, dataUrlToBlob } from "../lib/flatten";
import type { Annotations, Arrow, Box, Note, StepMarker, Tool } from "../types";

const COLOR = "#ff2d2d"; // màu khung + note (đỏ)
const TOOLBAR_H = 56;
const PADDING = 24;

interface Props {
  imageDataUrl: string;
  initialAnnotations?: Annotations | null;
  initialTitle?: string;
  onBack: () => void;
  onSaved: (flattened: Blob, original: Blob, annotations: Annotations, title: string) => void;
}

export function EditorScreen({ imageDataUrl, initialAnnotations, initialTitle, onBack, onSaved }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [steps, setSteps] = useState<StepMarker[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(initialTitle ?? "");
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

  // Phím tắt trong editor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
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
      setArrows((initialAnnotations.arrows ?? []).map((a) => ({ ...a, x1: a.x1 * s, y1: a.y1 * s, x2: a.x2 * s, y2: a.y2 * s })));
      setSteps((initialAnnotations.steps ?? []).map((st) => ({ ...st, x: st.x * s, y: st.y * s })));
      setNotes(initialAnnotations.notes.map((n) => ({ ...n, x: n.x * s, y: n.y * s })));
    }
    appliedInit.current = true;
  }, [img, fit.scale, initialAnnotations]);

  function deleteSelected() {
    if (!selectedId) return;
    setBoxes((prev) => prev.filter((b) => b.id !== selectedId));
    setArrows((prev) => prev.filter((a) => a.id !== selectedId));
    setSteps((prev) => prev.filter((st) => st.id !== selectedId));
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
      arrows: arrows.map((a) => ({ ...a, x1: a.x1 / s, y1: a.y1 / s, x2: a.x2 / s, y2: a.y2 / s })),
      steps: steps.map((st) => ({ ...st, x: st.x / s, y: st.y / s })),
      notes: notes.map((n) => ({ ...n, x: n.x / s, y: n.y / s })),
    };

    // Ảnh gốc (để sau này sửa lại annotate)
    const original = dataUrlToBlob(imageDataUrl);

    setSaving(false);
    onSaved(blob, original, annotations, title.trim());
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
        title={title}
        setTitle={setTitle}
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
            arrows={arrows}
            setArrows={setArrows}
            steps={steps}
            setSteps={setSteps}
            notes={notes}
            setNotes={setNotes}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            stageRef={stageRef}
          />
        )}
      </div>
      <p className="hint editor-hint">
        Mẹo: <b>Khung</b> kéo vẽ ô · <b>Mũi tên</b> kéo vẽ · <b>Bước</b> bấm để đặt số thứ tự · <b>Ghi chú</b> bấm để thêm chữ (đúp để sửa).
        Chọn phần tử rồi nhấn <b>Delete</b> để xoá.
      </p>
    </div>
  );
}

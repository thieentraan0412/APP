import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KImage, Rect, Text, Transformer } from "react-konva";
import type Konva from "konva";
import { nanoid } from "nanoid";
import type { Box, Note, Tool } from "../types";

interface Props {
  image: HTMLImageElement;
  width: number;
  height: number;
  color: string;
  tool: Tool;
  setTool: (t: Tool) => void;
  boxes: Box[];
  setBoxes: React.Dispatch<React.SetStateAction<Box[]>>;
  notes: Note[];
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  stageRef: React.RefObject<Konva.Stage | null>;
}

export function AnnotateCanvas(props: Props) {
  const {
    image, width, height, color, tool, setTool,
    boxes, setBoxes, notes, setNotes, selectedId, setSelectedId, stageRef,
  } = props;

  const trRef = useRef<Konva.Transformer>(null);
  const boxRefs = useRef<Map<string, Konva.Rect>>(new Map());
  const drawing = useRef<{ id: string; sx: number; sy: number } | null>(null);

  // Sửa ghi chú trực tiếp tại vị trí note (thay cho prompt)
  const [editing, setEditing] = useState<{ id: string; left: number; top: number } | null>(null);
  const [draft, setDraft] = useState("");
  const editingRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openedAt = useRef(0);

  // Mở ô nhập ngay tại toạ độ note (theo vị trí màn hình)
  function openNoteEditor(id: string, stageX: number, stageY: number, text: string) {
    const rect = stageRef.current?.container().getBoundingClientRect();
    if (!rect) return;
    editingRef.current = id;
    openedAt.current = performance.now();
    setDraft(text);
    setEditing({ id, left: rect.left + stageX, top: rect.top + stageY });
  }

  // Bảo đảm ô nhập được focus sau khi hiện (autoFocus có thể bị click trên canvas cướp mất)
  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [editing]);

  // Kết thúc sửa: lưu (text rỗng → xoá note) hoặc huỷ (note mới rỗng → xoá)
  function finishNote(save: boolean) {
    const id = editingRef.current;
    if (!id) return;
    editingRef.current = null;
    setEditing(null);
    const text = draft.trim();
    if (save) {
      if (!text) {
        setNotes((prev) => prev.filter((x) => x.id !== id));
        setSelectedId(null);
      } else {
        setNotes((prev) => prev.map((x) => (x.id === id ? { ...x, text } : x)));
      }
    } else {
      // huỷ: bỏ note nếu nó vẫn đang rỗng (note vừa thêm)
      setNotes((prev) => prev.filter((x) => !(x.id === id && x.text === "")));
    }
  }

  // Gắn Transformer vào khung đang chọn
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = selectedId ? boxRefs.current.get(selectedId) : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, boxes]);

  function onMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage();
    if (!stage) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;

    if (tool === "box") {
      const id = nanoid(6);
      drawing.current = { id, sx: pos.x, sy: pos.y };
      setBoxes((prev) => [...prev, { id, x: pos.x, y: pos.y, w: 0, h: 0, color }]);
      setSelectedId(null);
      return;
    }

    if (tool === "note") {
      const id = nanoid(6);
      setNotes((prev) => [...prev, { id, x: pos.x, y: pos.y, text: "", color }]);
      setSelectedId(id);
      setTool("select");
      openNoteEditor(id, pos.x, pos.y, "");
      return;
    }

    // select: bấm nền trống → bỏ chọn
    if (e.target === stage || e.target.name() === "bg") {
      setSelectedId(null);
    }
  }

  function onMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!drawing.current) return;
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;
    const { id, sx, sy } = drawing.current;
    const x = Math.min(sx, pos.x), y = Math.min(sy, pos.y);
    const w = Math.abs(pos.x - sx), h = Math.abs(pos.y - sy);
    setBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, x, y, w, h } : b)));
  }

  function onMouseUp() {
    if (!drawing.current) return;
    const id = drawing.current.id;
    drawing.current = null;
    setBoxes((prev) => {
      const b = prev.find((x) => x.id === id);
      if (b && (b.w < 5 || b.h < 5)) return prev.filter((x) => x.id !== id); // bỏ khung quá nhỏ
      return prev;
    });
    setSelectedId(id);
    setTool("select");
  }

  return (
    <>
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      style={{ cursor: tool === "select" ? "default" : "crosshair" }}
    >
      <Layer>
        <KImage image={image} width={width} height={height} name="bg" />

        {boxes.map((b) => (
          <Rect
            key={b.id}
            ref={(node) => {
              if (node) boxRefs.current.set(b.id, node);
              else boxRefs.current.delete(b.id);
            }}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            stroke={b.color}
            strokeWidth={3}
            strokeScaleEnabled={false}
            fill={b.color + "22"}
            draggable={tool === "select"}
            onMouseDown={(e) => {
              if (tool === "select") {
                e.cancelBubble = true;
                setSelectedId(b.id);
              }
            }}
            onDragEnd={(e) => {
              const { x, y } = e.target.position();
              setBoxes((prev) => prev.map((x2) => (x2.id === b.id ? { ...x2, x, y } : x2)));
            }}
            onTransformEnd={(e) => {
              const node = e.target as Konva.Rect;
              const sx = node.scaleX(), sy = node.scaleY();
              node.scaleX(1);
              node.scaleY(1);
              setBoxes((prev) =>
                prev.map((x2) =>
                  x2.id === b.id
                    ? {
                        ...x2,
                        x: node.x(),
                        y: node.y(),
                        w: Math.max(5, node.width() * sx),
                        h: Math.max(5, node.height() * sy),
                      }
                    : x2
                )
              );
            }}
          />
        ))}

        {notes.map((n) =>
          editing?.id === n.id ? null : (
          <Text
            key={n.id}
            x={n.x}
            y={n.y}
            text={n.text}
            fontSize={18}
            fontStyle="bold"
            fill={n.color}
            shadowColor="white"
            shadowBlur={2}
            draggable={tool === "select"}
            onMouseDown={(e) => {
              if (tool === "select") {
                e.cancelBubble = true;
                setSelectedId(n.id);
              }
            }}
            onDblClick={() => openNoteEditor(n.id, n.x, n.y, n.text)}
            onDragEnd={(e) => {
              const { x, y } = e.target.position();
              setNotes((prev) => prev.map((x2) => (x2.id === n.id ? { ...x2, x, y } : x2)));
            }}
          />
          )
        )}

        <Transformer
          ref={trRef}
          rotateEnabled={false}
          keepRatio={false}
          ignoreStroke
          boundBoxFunc={(oldBox, newBox) =>
            newBox.width < 5 || newBox.height < 5 ? oldBox : newBox
          }
        />
      </Layer>
    </Stage>

    {editing && (
      <input
        ref={inputRef}
        className="note-edit-input"
        value={draft}
        placeholder="Nhập ghi chú…"
        style={{ left: editing.left, top: editing.top, color }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finishNote(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finishNote(false);
          }
        }}
        onBlur={() => {
          // Bỏ qua blur "giả" ngay sau khi mở (do click trên canvas) — giữ lại focus
          if (performance.now() - openedAt.current < 300) {
            inputRef.current?.focus();
            return;
          }
          finishNote(true);
        }}
      />
    )}
    </>
  );
}

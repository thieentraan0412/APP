import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KImage, Rect, Text, Arrow as KArrow, Circle, Group, Transformer } from "react-konva";
import type Konva from "konva";
import { nanoid } from "nanoid";
import type { Arrow, Box, Note, StepMarker, Tool } from "../types";

interface Props {
  image: HTMLImageElement;
  width: number;
  height: number;
  color: string;
  tool: Tool;
  setTool: (t: Tool) => void;
  boxes: Box[];
  setBoxes: React.Dispatch<React.SetStateAction<Box[]>>;
  arrows: Arrow[];
  setArrows: React.Dispatch<React.SetStateAction<Arrow[]>>;
  steps: StepMarker[];
  setSteps: React.Dispatch<React.SetStateAction<StepMarker[]>>;
  notes: Note[];
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  stageRef: React.RefObject<Konva.Stage | null>;
}

export function AnnotateCanvas(props: Props) {
  const {
    image, width, height, color, tool, setTool,
    boxes, setBoxes, arrows, setArrows, steps, setSteps, notes, setNotes, selectedId, setSelectedId, stageRef,
  } = props;

  const trRef = useRef<Konva.Transformer>(null);
  const boxRefs = useRef<Map<string, Konva.Rect>>(new Map());
  const drawing = useRef<{ id: string; sx: number; sy: number } | null>(null);
  const arrowDrawing = useRef<{ id: string } | null>(null);

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

    if (tool === "arrow") {
      const id = nanoid(6);
      arrowDrawing.current = { id };
      setArrows((prev) => [...prev, { id, x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y, color }]);
      setSelectedId(null);
      return;
    }

    if (tool === "step") {
      // chỉ đặt khi click vào nền, không vào element đang có
      if (e.target !== stage && e.target.name() !== "bg") return;
      const id = nanoid(6);
      const nextStep = Math.max(0, ...steps.map((s) => s.step)) + 1;
      setSteps((prev) => [...prev, { id, x: pos.x, y: pos.y, step: nextStep, color }]);
      setSelectedId(id);
      setTool("select");
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
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    if (drawing.current) {
      const { id, sx, sy } = drawing.current;
      const x = Math.min(sx, pos.x), y = Math.min(sy, pos.y);
      const w = Math.abs(pos.x - sx), h = Math.abs(pos.y - sy);
      setBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, x, y, w, h } : b)));
    }

    if (arrowDrawing.current) {
      const { id } = arrowDrawing.current;
      setArrows((prev) => prev.map((a) => (a.id === id ? { ...a, x2: pos.x, y2: pos.y } : a)));
    }
  }

  function onMouseUp() {
    if (drawing.current) {
      const id = drawing.current.id;
      drawing.current = null;
      setBoxes((prev) => {
        const b = prev.find((x) => x.id === id);
        if (b && (b.w < 5 || b.h < 5)) return prev.filter((x) => x.id !== id);
        return prev;
      });
      setSelectedId(id);
      setTool("select");
    }

    if (arrowDrawing.current) {
      const id = arrowDrawing.current.id;
      arrowDrawing.current = null;
      setArrows((prev) => {
        const a = prev.find((x) => x.id === id);
        if (a && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 10) return prev.filter((x) => x.id !== id);
        return prev;
      });
      setSelectedId(id);
      setTool("select");
    }
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
            fill="transparent"
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

        {arrows.map((a) => (
          <KArrow
            key={a.id}
            x={a.x1}
            y={a.y1}
            points={[0, 0, a.x2 - a.x1, a.y2 - a.y1]}
            stroke={a.color}
            strokeWidth={a.id === selectedId ? 5 : 3}
            fill={a.color}
            pointerLength={14}
            pointerWidth={10}
            strokeScaleEnabled={false}
            opacity={a.id === selectedId ? 1 : 0.85}
            draggable={tool === "select"}
            onMouseDown={(e) => {
              if (tool === "select") {
                e.cancelBubble = true;
                setSelectedId(a.id);
              }
            }}
            onDragEnd={(e) => {
              const newX1 = e.target.x();
              const newY1 = e.target.y();
              setArrows((prev) =>
                prev.map((a2) => {
                  if (a2.id !== a.id) return a2;
                  const dx = newX1 - a2.x1;
                  const dy = newY1 - a2.y1;
                  return { ...a2, x1: newX1, y1: newY1, x2: a2.x2 + dx, y2: a2.y2 + dy };
                })
              );
            }}
          />
        ))}

        {steps.map((s) => (
          <Group
            key={s.id}
            x={s.x}
            y={s.y}
            draggable={tool === "select"}
            onMouseDown={(e) => {
              if (tool === "select") {
                e.cancelBubble = true;
                setSelectedId(s.id);
              }
            }}
            onDragEnd={(e) => {
              const { x, y } = e.target.position();
              setSteps((prev) => prev.map((s2) => (s2.id === s.id ? { ...s2, x, y } : s2)));
            }}
          >
            <Circle
              radius={18}
              fill={s.color}
              stroke="white"
              strokeWidth={s.id === selectedId ? 3 : 0}
              shadowColor="rgba(0,0,0,0.4)"
              shadowBlur={4}
              shadowOffsetY={2}
            />
            <Text
              text={String(s.step)}
              fontSize={s.step > 9 ? 13 : 15}
              fontStyle="bold"
              fill="white"
              width={36}
              height={36}
              offsetX={18}
              offsetY={18}
              align="center"
              verticalAlign="middle"
              listening={false}
            />
          </Group>
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

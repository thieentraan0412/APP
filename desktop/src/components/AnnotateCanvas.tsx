import { useEffect, useRef } from "react";
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
      const px = pos.x, py = pos.y;
      const text = window.prompt("Nội dung ghi chú:", "");
      if (text && text.trim()) {
        setNotes((prev) => [...prev, { id: nanoid(6), x: px, y: py, text: text.trim(), color }]);
      }
      setTool("select");
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

        {notes.map((n) => (
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
            onDblClick={() => {
              const t = window.prompt("Sửa ghi chú:", n.text);
              if (t === null) return;
              if (!t.trim()) {
                setNotes((prev) => prev.filter((x) => x.id !== n.id));
                setSelectedId(null);
              } else {
                setNotes((prev) => prev.map((x) => (x.id === n.id ? { ...x, text: t.trim() } : x)));
              }
            }}
            onDragEnd={(e) => {
              const { x, y } = e.target.position();
              setNotes((prev) => prev.map((x2) => (x2.id === n.id ? { ...x2, x, y } : x2)));
            }}
          />
        ))}

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
  );
}

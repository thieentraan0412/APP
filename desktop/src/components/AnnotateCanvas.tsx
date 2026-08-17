import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KImage, Rect, Text, Arrow as KArrow, Circle, Ellipse, Group, Line, Transformer } from "react-konva";
// Nhập dạng GIÁ TRỊ (không phải `import type`) vì cần Konva.Filters.Blur cho vùng che mờ.
import Konva from "konva";
import { nanoid } from "nanoid";
import type { Arrow, Box, Highlight, Measure, Note, Shape, StepMarker, Tool } from "../types";

interface Props {
  image: HTMLImageElement;
  width: number;
  height: number;
  color: string;
  tool: Tool;
  setTool: (t: Tool) => void;
  /** Số sẽ đóng cho mốc Bước tiếp theo (đóng xong tự tăng) */
  stepNext: number;
  setStepNext: (n: number) => void;
  /** true = đặt mốc xong mở ô nhập chữ luôn */
  stepWithText: boolean;
  /** Bán kính làm mờ cho vùng che sắp vẽ */
  blurStrength: number;
  /** Hút màu: trả mã hex của pixel vừa bấm (theo ảnh gốc, không tính chú thích vẽ đè) */
  onPickColor: (hex: string) => void;
  shapes: Shape[];
  setShapes: React.Dispatch<React.SetStateAction<Shape[]>>;
  measures: Measure[];
  setMeasures: React.Dispatch<React.SetStateAction<Measure[]>>;
  /** Tỉ lệ hiển thị ảnh (fit.scale) — để đổi số đo về pixel ảnh GỐC */
  scale: number;
  /** Màu + độ dày + độ đậm của bút tô sáng đang chọn trên thanh công cụ */
  highlightColor: string;
  highlightThickness: number;
  highlightOpacity: number;
  highlights: Highlight[];
  setHighlights: React.Dispatch<React.SetStateAction<Highlight[]>>;
  boxes: Box[];
  setBoxes: React.Dispatch<React.SetStateAction<Box[]>>;
  arrows: Arrow[];
  setArrows: React.Dispatch<React.SetStateAction<Arrow[]>>;
  steps: StepMarker[];
  setSteps: React.Dispatch<React.SetStateAction<StepMarker[]>>;
  notes: Note[];
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  /** Các phần tử đang chọn. Một cái = chỉnh sửa được (kéo, co giãn); nhiều cái = chọn để
   *  xoá cả loạt bằng cách kéo tô một vùng trống. */
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  stageRef: React.RefObject<Konva.Stage | null>;
}

// Đủ mờ để đọc được chữ bên dưới, đủ đậm để nhìn là thấy ngay.
export const HIGHLIGHT_OPACITY = 0.38;

// Chữ của mốc Bước đặt cách tâm vòng tròn ngần này pixel (bán kính vòng là 18) để không
// đè lên con số.
const STEP_TEXT_DX = 25;

// Bán kính vòng tròn của mốc Bước. Dùng chung cho lúc vẽ và lúc tính vùng chọn — để rời
// nhau thì kéo tô trúng vòng tròn mà không chọn được.
const STEP_RADIUS = 18;

// Kéo dọc phải vượt mép dải THÊM ngần này pixel mới coi là muốn tô cả khối. Trước đây
// ngưỡng lấy đúng bằng độ dày: đặt bút mảnh 8px thì tay rung hơn 8px là đã nhảy sang tô
// khối, nên chỉnh độ dày như không có tác dụng — mọi vệt đều phình thành khối.
const BLOCK_MARGIN = 26;

// Độ dày nét bút vẽ tay.
const PEN_WIDTH = 3;

/** Mã hex của một pixel trên ảnh gốc. Vẽ đúng 1×1 pixel ra canvas tạm nên rất nhẹ. */
function pixelHex(img: HTMLImageElement, ix: number, iy: number): string | null {
  const x = Math.floor(ix);
  const y = Math.floor(iy);
  if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null;
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
  } catch {
    return null; // ảnh chéo origin (không xảy ra với data URL) → bỏ qua thay vì nổ
  }
}

// Màu thước đo: xanh, để không lẫn với khung/mũi tên/ghi chú (đỏ) trên cùng một ảnh.
export const MEASURE_COLOR = "#0b63f6";
// Nét gạch vuông góc ở hai đầu thước, dài (mỗi bên) ngần này pixel hiển thị.
const CAP = 7;

/** Số đo theo pixel ẢNH GỐC + nhãn hiện trên ảnh. `scale` là tỉ lệ đang hiển thị. */
export function measureInfo(m: Measure, scale: number) {
  const s = scale > 0 ? scale : 1;
  const dx = m.x2 - m.x1;
  const dy = m.y2 - m.y1;
  const w = Math.round(Math.abs(dx) / s);
  const h = Math.round(Math.abs(dy) / s);
  const dist = Math.round(Math.hypot(dx, dy) / s);
  // Gần như nằm ngang/dọc (lệch dưới 4px hiển thị) thì chỉ hiện một chiều cho gọn —
  // "320 px" đọc nhanh hơn "320 × 1 px".
  const horizontal = Math.abs(dy) < 4;
  const vertical = Math.abs(dx) < 4;
  const label = horizontal ? `${w} px` : vertical ? `${h} px` : `${w} × ${h} px`;
  return { w, h, dist, label, horizontal, vertical };
}

/** Toạ độ pixel ảnh gốc của một điểm trên canvas. */
export function toImagePoint(x: number, y: number, scale: number) {
  const s = scale > 0 ? scale : 1;
  return { x: Math.round(x / s), y: Math.round(y / s) };
}

// ── Khung bao của phần tử (để biết nó có nằm trong vùng kéo tô hay không) ──
// Tính thẳng từ dữ liệu chứ không hỏi Konva `getClientRect`: khỏi lệ thuộc bóng đổ, độ dày
// nét, và khỏi cần node đã vẽ xong. Phép kiểm tra là GIAO NHAU (không đòi bao trọn), nên
// quét chổi qua là dính — sai lệch vài pixel ở ước lượng chữ không thành vấn đề.
export interface Bounds { x: number; y: number; w: number; h: number }

function spanBounds(x1: number, y1: number, x2: number, y2: number): Bounds {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

// Konva.Text không cho biết kích thước trước khi vẽ → ước lượng theo cỡ chữ 18 đậm.
function noteBounds(n: Note): Bounds {
  const lines = (n.text || "").split("\n");
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return { x: n.x, y: n.y, w: Math.max(12, longest * 9.5), h: Math.max(18, lines.length * 22) };
}

function shapeBounds(s: Shape): Bounds {
  if (s.kind === "line") return spanBounds(s.x1, s.y1, s.x2, s.y2);
  if (s.kind === "pen") {
    if (s.points.length < 2) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < s.points.length; i += 2) {
      const px = s.points[i], py = s.points[i + 1];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return { x: s.x, y: s.y, w: s.w, h: s.h }; // ellipse | blur
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

// Chữ đi kèm mốc Bước. Tự bọc dòng trong khoảng trống còn lại, và nhảy sang bên trái khi
// mốc nằm sát mép phải — để nguyên bên phải thì chữ chạy ra ngoài ảnh và bị cắt mất lúc xuất.
// Viền trắng quanh chữ (stroke + fillAfterStrokeEnabled) để đọc được cả trên nền tối.
function StepText({ s, stageWidth }: { s: StepMarker; stageWidth: number }) {
  const roomRight = stageWidth - s.x - STEP_TEXT_DX - 6;
  const roomLeft = s.x - STEP_TEXT_DX - 6;
  const onRight = roomRight >= 140 || roomRight >= roomLeft;
  const boxW = Math.max(60, onRight ? roomRight : roomLeft);
  return (
    <Text
      text={s.text ?? ""}
      x={onRight ? STEP_TEXT_DX : -(STEP_TEXT_DX + boxW)}
      width={boxW}
      align={onRight ? "left" : "right"}
      wrap="word"
      offsetY={9}
      fontSize={17}
      fontStyle="bold"
      fill={s.color}
      stroke="white"
      strokeWidth={2.5}
      fillAfterStrokeEnabled
      lineHeight={1.25}
      listening={false}
    />
  );
}

// Vùng che mờ: vẽ lại đúng miếng ảnh nền đó rồi áp bộ lọc Blur lên trên.
// Konva chỉ áp filter cho node ĐÃ cache, nên phải gọi cache() lại mỗi khi vùng hoặc độ mờ
// đổi — thiếu bước này vùng hiện ra sắc nét như không có gì.
// `crop` phải tính theo pixel ảnh GỐC (chia tỉ lệ hiển thị), còn x/y/width/height là toạ độ
// trên canvas — lẫn hai hệ này là miếng ảnh lấy sai chỗ.
function BlurRegion({
  image, s, scale, interactive, onSelect, onMove,
}: {
  image: HTMLImageElement;
  s: Extract<Shape, { kind: "blur" }>;
  scale: number;
  interactive: boolean;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const ref = useRef<Konva.Image>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || s.w < 1 || s.h < 1) return;
    node.cache();
    node.getLayer()?.batchDraw();
  }, [s.x, s.y, s.w, s.h, s.strength, scale, image]);

  const sc = scale > 0 ? scale : 1;
  return (
    <KImage
      ref={ref}
      image={image}
      x={s.x}
      y={s.y}
      width={s.w}
      height={s.h}
      crop={{ x: s.x / sc, y: s.y / sc, width: s.w / sc, height: s.h / sc }}
      filters={[Konva.Filters.Blur]}
      blurRadius={s.strength}
      draggable={interactive}
      listening={interactive}
      onMouseDown={(e) => {
        if (!interactive) return;
        e.cancelBubble = true;
        onSelect();
      }}
      onDragEnd={(e) => onMove(e.target.x(), e.target.y())}
    />
  );
}

// Một thước đo: mũi hai đầu + gạch vuông góc chặn hai đầu + nhãn số đo.
// KHÔNG kéo thả được — thước gắn với đúng chỗ đã đo, xê dịch đi là nhãn nói dối. Nhưng
// phải bấm chọn được (hitStrokeWidth nới rộng vì nét chỉ 2px) để còn xoá được về sau.
function MeasureShape({
  m, scale, selected, interactive, onSelect,
}: {
  m: Measure;
  scale: number;
  selected: boolean;
  interactive: boolean;
  onSelect: () => void;
}) {
  const { label } = measureInfo(m, scale);
  const dx = m.x2 - m.x1;
  const dy = m.y2 - m.y1;
  const len = Math.hypot(dx, dy) || 1;
  // Pháp tuyến đơn vị — dùng để vẽ gạch chặn hai đầu và đẩy nhãn ra khỏi thân thước.
  const nx = -dy / len;
  const ny = dx / len;
  const mid = { x: (m.x1 + m.x2) / 2, y: (m.y1 + m.y2) / 2 };
  const width = selected ? 2.5 : 2;
  return (
    <>
      <KArrow
        points={[m.x1, m.y1, m.x2, m.y2]}
        stroke={m.color}
        fill={m.color}
        strokeWidth={width}
        pointerAtBeginning
        pointerLength={9}
        pointerWidth={7}
        strokeScaleEnabled={false}
        dash={selected ? [7, 4] : undefined}
        listening={interactive}
        hitStrokeWidth={14}
        onMouseDown={(e) => {
          if (!interactive) return;
          e.cancelBubble = true;
          onSelect();
        }}
      />
      {[[m.x1, m.y1], [m.x2, m.y2]].map(([px, py], i) => (
        <Line
          key={i}
          points={[px - nx * CAP, py - ny * CAP, px + nx * CAP, py + ny * CAP]}
          stroke={m.color}
          strokeWidth={width}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
      <Text
        text={label}
        x={mid.x + nx * 13}
        y={mid.y + ny * 13}
        offsetX={label.length * 4.2}
        offsetY={8}
        fontSize={15}
        fontStyle="bold"
        fill={m.color}
        stroke="white"
        strokeWidth={2.5}
        fillAfterStrokeEnabled
        listening={false}
      />
    </>
  );
}

export function AnnotateCanvas(props: Props) {
  const {
    image, width, height, color, tool, setTool,
    stepNext, setStepNext, stepWithText, blurStrength, onPickColor,
    shapes, setShapes, measures, setMeasures, scale,
    highlightColor, highlightThickness, highlightOpacity, highlights, setHighlights,
    boxes, setBoxes, arrows, setArrows, steps, setSteps, notes, setNotes, selectedIds, setSelectedIds, stageRef,
  } = props;

  // Chỉnh sửa (kéo, co giãn, đổi màu vệt tô, đọc số đo) chỉ có nghĩa khi đúng MỘT phần tử
  // đang chọn — nên phần lớn code bên dưới vẫn hỏi `selectedId` như trước, còn chọn nhiều
  // chỉ phục vụ việc xoá cả loạt.
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const setSelectedId = (id: string | null) => setSelectedIds(id ? [id] : []);

  const trRef = useRef<Konva.Transformer>(null);
  // Kéo tô một vùng trống để chọn nhiều phần tử. `rect` giữ trong ref (không chỉ trong
  // state) để lúc thả chuột đọc được vùng mới nhất, khỏi phụ thuộc React đã render kịp chưa.
  const marquee = useRef<{ sx: number; sy: number; moved: boolean; rect: Bounds } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<Bounds | null>(null);
  const boxRefs = useRef<Map<string, Konva.Rect>>(new Map());
  const drawing = useRef<{ id: string; sx: number; sy: number } | null>(null);
  const arrowDrawing = useRef<{ id: string } | null>(null);
  // Bút tô sáng: giữ mốc x đầu và tâm y của dải — kéo ngang thì dải chạy theo, còn độ dày
  // lấy từ thanh công cụ chứ không phụ thuộc kéo dọc (đúng kiểu bút dạ quang).
  // `block` = đã chuyển sang chế độ tô cả khối cho nét này (xem BLOCK_MARGIN).
  const hlDrawing = useRef<{ id: string; sx: number; cy: number; block: boolean } | null>(null);
  const measureDrawing = useRef<{ id: string; sx: number; sy: number } | null>(null);
  // Hình tròn / đường thẳng: giữ điểm bắt đầu. Nét bút: chỉ cần id, điểm cộng dồn vào state.
  const shapeDrawing = useRef<{ id: string; kind: Shape["kind"]; sx: number; sy: number } | null>(null);

  // Sửa chữ trực tiếp tại chỗ (thay cho prompt) — dùng cho cả Ghi chú và nội dung mốc Bước
  type EditKind = "note" | "step";
  const [editing, setEditing] = useState<{ id: string; kind: EditKind; left: number; top: number } | null>(null);
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");          // luôn giữ giá trị mới nhất — tránh stale closure
  const editingRef = useRef<{ id: string; kind: EditKind } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openedAt = useRef(0);

  // Mở ô nhập ngay tại toạ độ phần tử (theo vị trí màn hình)
  function openEditor(kind: EditKind, id: string, stageX: number, stageY: number, text: string) {
    const rect = stageRef.current?.container().getBoundingClientRect();
    if (!rect) return;
    // Đang gõ dở ở một ô khác (vd bấm đặt mốc kế tiếp khi chưa Ctrl+Enter) → CHỐT chữ đó
    // trước. Chromium chạy mousedown xong mới chạy blur, nên nếu không chốt ở đây thì
    // editingRef/draftRef đã bị ghi đè sang mốc mới; blur sau đó commit chuỗi rỗng và chữ
    // vừa gõ mất trắng.
    if (editingRef.current && editingRef.current.id !== id) finishEdit(true);
    editingRef.current = { id, kind };
    openedAt.current = performance.now();
    setDraft(text);
    draftRef.current = text;
    setEditing({ id, kind, left: rect.left + stageX, top: rect.top + stageY });
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
  // Dùng draftRef.current thay vì draft để tránh stale closure trong concurrent mode
  function finishEdit(save: boolean) {
    const cur = editingRef.current;
    if (!cur) return;
    const { id, kind } = cur;
    editingRef.current = null;
    setEditing(null);
    const text = draftRef.current.trim();

    // Mốc Bước: chữ rỗng thì chỉ bỏ chữ, KHÔNG xoá mốc — con số đứng một mình vẫn có nghĩa.
    // (Ghi chú thì khác: không có chữ là không còn gì để hiện, nên xoá luôn.)
    if (kind === "step") {
      if (save) setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)));
      return;
    }

    if (save) {
      if (!text) {
        setNotes((prev) => prev.filter((x) => x.id !== id));
        setSelectedId(null);
      } else {
        setNotes((prev) => prev.map((x) => (x.id === id ? { ...x, text } : x)));
      }
    } else {
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
  }, [selectedId, boxes, highlights]);

  // Chốt vùng kéo tô ở cấp CỬA SỔ, không phải trên Stage: Konva chỉ báo mouseup khi nhả
  // chuột bên trong ảnh, mà quét chọn thì rất hay kéo lố ra mép rồi mới nhả. Nghe trên
  // stage thôi là vùng chọn không bao giờ được chốt — khung nét đứt dính lại trên ảnh và
  // cả lượt chọn đó mất trắng.
  // Không đặt mảng phụ thuộc: hàm đăng ký lại mỗi lần render nên luôn nhìn thấy danh sách
  // phần tử mới nhất.
  useEffect(() => {
    const onUp = () => {
      if (!marquee.current) return;
      const { moved, rect } = marquee.current;
      marquee.current = null;
      setMarqueeRect(null);
      // Bấm nhả tại chỗ (không kéo) = chỉ bỏ chọn, đã làm lúc nhấn xuống.
      if (moved) {
        setSelectedIds(allBounds().filter(({ b }) => overlaps(b, rect)).map(({ id }) => id));
      }
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  });

  /** Khung bao của MỌI phần tử đang có trên ảnh, kèm id — dùng cho vùng kéo tô và cho
   *  viền báo hiệu khi đang chọn nhiều. */
  function allBounds(): { id: string; b: Bounds }[] {
    return [
      ...boxes.map((b) => ({ id: b.id, b: { x: b.x, y: b.y, w: b.w, h: b.h } })),
      ...highlights.map((h) => ({ id: h.id, b: { x: h.x, y: h.y, w: h.w, h: h.h } })),
      ...shapes.map((s) => ({ id: s.id, b: shapeBounds(s) })),
      ...arrows.map((a) => ({ id: a.id, b: spanBounds(a.x1, a.y1, a.x2, a.y2) })),
      ...measures.map((m) => ({ id: m.id, b: spanBounds(m.x1, m.y1, m.x2, m.y2) })),
      ...steps.map((s) => ({
        id: s.id,
        b: { x: s.x - STEP_RADIUS, y: s.y - STEP_RADIUS, w: STEP_RADIUS * 2, h: STEP_RADIUS * 2 },
      })),
      ...notes.map((n) => ({ id: n.id, b: noteBounds(n) })),
    ];
  }

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

    if (tool === "highlight") {
      const id = nanoid(6);
      const h = highlightThickness;
      hlDrawing.current = { id, sx: pos.x, cy: pos.y, block: false };
      // Dải bám theo tâm là điểm bấm chuột → kéo dọc dòng chữ thì chữ nằm giữa vệt tô.
      setHighlights((prev) => [
        ...prev,
        { id, x: pos.x, y: pos.y - h / 2, w: 0, h, color: highlightColor, opacity: highlightOpacity },
      ]);
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

    // Hút màu: lấy màu ngay tại pixel bấm vào, đọc từ ảnh GỐC nên chú thích vẽ đè lên
    // không làm sai màu. Không tạo phần tử nào trên ảnh.
    if (tool === "eyedrop") {
      const hex = pixelHex(image, pos.x / (scale > 0 ? scale : 1), pos.y / (scale > 0 ? scale : 1));
      if (hex) onPickColor(hex);
      return;
    }

    if (tool === "ellipse" || tool === "line" || tool === "pen" || tool === "blur") {
      const id = nanoid(6);
      shapeDrawing.current = { id, kind: tool, sx: pos.x, sy: pos.y };
      const next: Shape =
        tool === "ellipse"
          ? { kind: "ellipse", id, x: pos.x, y: pos.y, w: 0, h: 0, color }
          : tool === "line"
            ? { kind: "line", id, x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y, color }
            : tool === "blur"
              ? { kind: "blur", id, x: pos.x, y: pos.y, w: 0, h: 0, strength: blurStrength }
              : { kind: "pen", id, points: [pos.x, pos.y], color, width: PEN_WIDTH };
      setShapes((prev) => [...prev, next]);
      setSelectedId(null);
      return;
    }

    if (tool === "measure") {
      const id = nanoid(6);
      measureDrawing.current = { id, sx: pos.x, sy: pos.y };
      setMeasures((prev) => [
        ...prev,
        { id, x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y, color: MEASURE_COLOR },
      ]);
      setSelectedId(null);
      return;
    }

    if (tool === "step") {
      // chỉ đặt khi click vào nền, không vào element đang có
      if (e.target !== stage && e.target.name() !== "bg") return;
      const id = nanoid(6);
      setSteps((prev) => [...prev, { id, x: pos.x, y: pos.y, step: stepNext, color, text: "" }]);
      setStepNext(stepNext + 1);
      // Giữ nguyên công cụ Bước để bấm tiếp ra ②③④… Trước đây tự nhảy về Chọn nên đánh
      // một luồng 5 bước phải bấm lại nút Bước 5 lần.
      // Không chọn mốc vừa đặt: vòng viền trắng của mốc đang chọn cứ nhảy theo từng lần
      // bấm, nhìn rối mà chẳng để làm gì khi đang đánh số liên tiếp.
      setSelectedId(null);
      // Bật "nhập chữ ngay" thì mở ô nhập luôn — bấm, gõ, bấm chỗ tiếp, gõ… Tắt thì chỉ
      // đóng số cho nhanh, chữ thêm sau bằng cách bấm đúp vào mốc.
      if (stepWithText) openEditor("step", id, pos.x + STEP_TEXT_DX, pos.y - 12, "");
      return;
    }

    if (tool === "note") {
      const id = nanoid(6);
      setNotes((prev) => [...prev, { id, x: pos.x, y: pos.y, text: "", color }]);
      setSelectedId(id);
      setTool("select");
      openEditor("note", id, pos.x, pos.y, "");
      return;
    }

    // select: bấm nền trống → bỏ chọn, đồng thời mở vùng kéo tô. Bấm nhả tại chỗ thì chỉ là
    // bỏ chọn như trước; kéo đi thì quét được nhiều phần tử một lượt để xoá cả loạt.
    if (e.target === stage || e.target.name() === "bg") {
      marquee.current = { sx: pos.x, sy: pos.y, moved: false, rect: { x: pos.x, y: pos.y, w: 0, h: 0 } };
      setMarqueeRect(null);
      setSelectedIds([]);
    }
  }

  function onMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    // Đang kéo tô chọn vùng: không có nét vẽ nào chạy song song nên xử lý xong là thoát.
    // Ngưỡng 3px để rung tay lúc bấm bỏ chọn không biến thành một vùng chọn tí hon.
    if (marquee.current) {
      const { sx, sy } = marquee.current;
      if (!marquee.current.moved && Math.hypot(pos.x - sx, pos.y - sy) > 3) marquee.current.moved = true;
      const rect = spanBounds(sx, sy, pos.x, pos.y);
      marquee.current.rect = rect;
      if (marquee.current.moved) setMarqueeRect(rect);
      return;
    }

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

    if (shapeDrawing.current) {
      const { id, sx, sy } = shapeDrawing.current;
      setShapes((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          if (s.kind === "ellipse") {
            // Giữ Shift = tròn đều (bán kính hai chiều bằng nhau).
            let w = Math.abs(pos.x - sx);
            let h = Math.abs(pos.y - sy);
            if (e.evt.shiftKey) { const r = Math.max(w, h); w = r; h = r; }
            return { ...s, x: Math.min(sx, pos.x), y: Math.min(sy, pos.y), w, h };
          }
          if (s.kind === "blur") {
            return {
              ...s,
              x: Math.min(sx, pos.x),
              y: Math.min(sy, pos.y),
              w: Math.abs(pos.x - sx),
              h: Math.abs(pos.y - sy),
            };
          }
          if (s.kind === "line") {
            let x2 = pos.x, y2 = pos.y;
            if (e.evt.shiftKey) {
              if (Math.abs(pos.x - sx) >= Math.abs(pos.y - sy)) y2 = sy;
              else x2 = sx;
            }
            return { ...s, x2, y2 };
          }
          // Nét bút: chỉ ghi thêm điểm khi con trỏ đi đủ xa, nếu không mỗi giây có hàng
          // trăm điểm trùng nhau làm nét nặng và file annotate phình vô ích.
          const n = s.points.length;
          const lastX = s.points[n - 2], lastY = s.points[n - 1];
          if (Math.hypot(pos.x - lastX, pos.y - lastY) < 2.5) return s;
          return { ...s, points: [...s.points, pos.x, pos.y] };
        })
      );
    }

    if (measureDrawing.current) {
      const { id, sx, sy } = measureDrawing.current;
      // Giữ Shift = khoá theo trục trội hơn. Đo chiều rộng/chiều cao thật khó kéo thẳng
      // tay, lệch vài pixel là nhãn đổi thành "320 × 3 px" — Shift cho số sạch.
      let x2 = pos.x;
      let y2 = pos.y;
      if (e.evt.shiftKey) {
        if (Math.abs(pos.x - sx) >= Math.abs(pos.y - sy)) y2 = sy;
        else x2 = sx;
      }
      setMeasures((prev) => prev.map((m) => (m.id === id ? { ...m, x2, y2 } : m)));
    }

    if (hlDrawing.current) {
      const { id, sx, cy } = hlDrawing.current;
      const x = Math.min(sx, pos.x);
      const w = Math.abs(pos.x - sx);
      // Kéo dọc ra HẲN ngoài dải mới coi là muốn tô cả khối; rung tay trong lúc kéo ngang
      // không đủ để kích hoạt. Và đã vào chế độ khối thì giữ nguyên tới hết nét — nếu để
      // nó tự nhảy qua nhảy lại, dải sẽ giật liên tục quanh ngưỡng.
      const dy = Math.abs(pos.y - cy);
      if (!hlDrawing.current.block && dy > highlightThickness / 2 + BLOCK_MARGIN) {
        hlDrawing.current.block = true;
      }
      const block = hlDrawing.current.block;
      const h = block ? Math.max(dy, highlightThickness) : highlightThickness;
      const y = block ? Math.min(cy, pos.y) : cy - highlightThickness / 2;
      setHighlights((prev) => prev.map((hl) => (hl.id === id ? { ...hl, x, y, w, h } : hl)));
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

    if (shapeDrawing.current) {
      const { id, kind } = shapeDrawing.current;
      shapeDrawing.current = null;
      setShapes((prev) =>
        prev.filter((s) => {
          if (s.id !== id) return true;
          // Bấm nhầm không kéo → bỏ, khỏi để lại hình 0px hoặc nét bút một điểm.
          if (s.kind === "ellipse" || s.kind === "blur") return s.w >= 5 && s.h >= 5;
          if (s.kind === "line") return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 6;
          return s.points.length >= 6;
        })
      );
      // Nét bút và che mờ giữ nguyên công cụ (thường làm nhiều chỗ liền: che email, che số
      // điện thoại, che số tài khoản); hình tròn/đường thẳng vẽ lẻ nên trả về Chọn như
      // Khung/Mũi tên để chỉnh ngay.
      if (kind === "pen" || kind === "blur") {
        setSelectedId(null);
      } else {
        setSelectedId(id);
        setTool("select");
      }
    }

    if (measureDrawing.current) {
      const id = measureDrawing.current.id;
      measureDrawing.current = null;
      setMeasures((prev) => {
        const m = prev.find((x) => x.id === id);
        // Bấm nhầm không kéo → bỏ, khỏi để lại thước 0px.
        if (m && Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 6) return prev.filter((x) => x.id !== id);
        return prev;
      });
      // Chọn thước vừa đo để thanh công cụ hiện đủ số (toạ độ, W, H, khoảng cách), nhưng
      // GIỮ công cụ để đo tiếp chỗ khác — đo thường đo vài chỗ liền nhau.
      setSelectedId(id);
    }

    if (hlDrawing.current) {
      const id = hlDrawing.current.id;
      hlDrawing.current = null;
      // Bấm nhầm một cái không kéo → bỏ, tránh để lại vệt tí hon vô nghĩa.
      setHighlights((prev) => prev.filter((h) => !(h.id === id && h.w < 5)));
      // Giữ nguyên bút tô sáng: tô lỗi thường tô nhiều dòng liên tiếp, bắt chọn lại
      // công cụ sau mỗi vệt thì rất phiền (khác Khung/Mũi tên vốn vẽ lẻ).
      // Cũng KHÔNG chọn vệt vừa tô: tay cầm của khung chọn sẽ nằm đè lên vùng sắp tô
      // tiếp, kéo phát nữa là thành co giãn vệt cũ chứ không phải vẽ vệt mới.
      setSelectedId(null);
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

        {/* Che mờ vẽ ngay sau ảnh nền: nó phải phủ được ảnh, nhưng phải nằm DƯỚI mọi chú
            thích — che mờ đè lên khung/mũi tên/chữ thì làm nhoè luôn chú thích. */}
        {shapes.map((s) =>
          s.kind === "blur" ? (
            <BlurRegion
              key={s.id}
              image={image}
              s={s}
              scale={scale}
              interactive={tool === "select"}
              onSelect={() => setSelectedId(s.id)}
              onMove={(x, y) =>
                setShapes((prev) => prev.map((s2) => (s2.id === s.id && s2.kind === "blur" ? { ...s2, x, y } : s2)))
              }
            />
          ) : null
        )}

        {/* Vẽ trước mọi thứ khác: dải mờ nằm DƯỚI khung/mũi tên/chữ, nếu không nó phủ
            một lớp màu lên chúng và làm chú thích bị xỉn màu. */}
        {highlights.map((h) => (
          <Rect
            key={h.id}
            ref={(node) => {
              if (node) boxRefs.current.set(h.id, node);
              else boxRefs.current.delete(h.id);
            }}
            x={h.x}
            y={h.y}
            width={h.w}
            height={h.h}
            fill={h.color}
            opacity={h.opacity}
            stroke={h.id === selectedId ? "#1f2937" : undefined}
            strokeWidth={h.id === selectedId ? 1 : 0}
            dash={h.id === selectedId ? [4, 3] : undefined}
            strokeScaleEnabled={false}
            draggable={tool === "select"}
            onMouseDown={(e) => {
              if (tool === "select") {
                e.cancelBubble = true;
                setSelectedId(h.id);
              }
            }}
            onDragEnd={(e) => {
              const { x, y } = e.target.position();
              setHighlights((prev) => prev.map((h2) => (h2.id === h.id ? { ...h2, x, y } : h2)));
            }}
            onTransformEnd={(e) => {
              const node = e.target as Konva.Rect;
              const sx = node.scaleX(), sy = node.scaleY();
              node.scaleX(1);
              node.scaleY(1);
              setHighlights((prev) =>
                prev.map((h2) =>
                  h2.id === h.id
                    ? {
                        ...h2,
                        x: node.x(),
                        y: node.y(),
                        w: Math.max(5, node.width() * sx),
                        h: Math.max(4, node.height() * sy),
                      }
                    : h2
                )
              );
            }}
          />
        ))}

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

        {shapes.map((s) => {
          if (s.kind === "blur") return null; // đã vẽ ở lớp dưới, ngay trên ảnh nền
          const pick = (e: Konva.KonvaEventObject<MouseEvent>) => {
            if (tool !== "select") return;
            e.cancelBubble = true;
            setSelectedId(s.id);
          };
          const selected = s.id === selectedId;
          const stroke = selected ? 4 : 3;

          if (s.kind === "ellipse") {
            return (
              <Ellipse
                key={s.id}
                x={s.x + s.w / 2}
                y={s.y + s.h / 2}
                radiusX={s.w / 2}
                radiusY={s.h / 2}
                stroke={s.color}
                strokeWidth={stroke}
                strokeScaleEnabled={false}
                draggable={tool === "select"}
                onMouseDown={pick}
                onDragEnd={(e) => {
                  // Konva cho toạ độ TÂM, còn state lưu góc trên-trái → trừ lại nửa cạnh.
                  const { x, y } = e.target.position();
                  setShapes((prev) =>
                    prev.map((s2) =>
                      s2.id === s.id && s2.kind === "ellipse"
                        ? { ...s2, x: x - s2.w / 2, y: y - s2.h / 2 }
                        : s2
                    )
                  );
                }}
              />
            );
          }

          // Đường thẳng và nét bút cùng là Line, chỉ khác tập điểm và độ dày.
          const points = s.kind === "line" ? [s.x1, s.y1, s.x2, s.y2] : s.points;
          return (
            <Line
              key={s.id}
              points={points}
              stroke={s.color}
              strokeWidth={s.kind === "pen" ? (selected ? s.width + 1 : s.width) : stroke}
              lineCap="round"
              lineJoin="round"
              // Làm mượt nét vẽ tay; đường thẳng phải để 0 nếu không hai đầu bị uốn.
              tension={s.kind === "pen" ? 0.35 : 0}
              strokeScaleEnabled={false}
              // Nét mảnh 3px gần như không bấm trúng → nới vùng bắt chuột.
              hitStrokeWidth={14}
              draggable={tool === "select"}
              onMouseDown={pick}
              onDragEnd={(e) => {
                // Line kéo xong nằm ở offset (x,y); dồn offset đó vào chính toạ độ điểm rồi
                // đưa node về 0 — nếu không, lần render sau React vẽ lại theo points cũ và
                // hình nhảy về chỗ ban đầu.
                const node = e.target;
                const dx = node.x();
                const dy = node.y();
                node.position({ x: 0, y: 0 });
                setShapes((prev) =>
                  prev.map((s2) => {
                    if (s2.id !== s.id) return s2;
                    if (s2.kind === "line") {
                      return { ...s2, x1: s2.x1 + dx, y1: s2.y1 + dy, x2: s2.x2 + dx, y2: s2.y2 + dy };
                    }
                    if (s2.kind === "pen") {
                      return { ...s2, points: s2.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) };
                    }
                    return s2;
                  })
                );
              }}
            />
          );
        })}

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
            onDblClick={() => openEditor("step", s.id, s.x + STEP_TEXT_DX, s.y - 12, s.text ?? "")}
            onDragEnd={(e) => {
              const { x, y } = e.target.position();
              setSteps((prev) => prev.map((s2) => (s2.id === s.id ? { ...s2, x, y } : s2)));
            }}
          >
            <Circle
              radius={STEP_RADIUS}
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
            {/* Nội dung bước, nằm cạnh con số. Đang sửa thì ẩn đi để không thấy hai lần
                (một trên canvas, một trong ô nhập đè lên). Viền trắng mảnh quanh chữ để
                đọc được cả khi nền ảnh tối. */}
            {!!s.text && editing?.id !== s.id && <StepText s={s} stageWidth={width} />}
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
            onDblClick={() => openEditor("note", n.id, n.x, n.y, n.text)}
            onDragEnd={(e) => {
              const { x, y } = e.target.position();
              setNotes((prev) => prev.map((x2) => (x2.id === n.id ? { ...x2, x, y } : x2)));
            }}
          />
          )
        )}

        {/* Thước đo vẽ sau cùng: nhãn số là thứ phải đọc được, không để khung/vệt tô che. */}
        {measures.map((m) => (
          <MeasureShape
            key={m.id}
            m={m}
            scale={scale}
            selected={m.id === selectedId}
            interactive={tool === "select"}
            onSelect={() => setSelectedId(m.id)}
          />
        ))}

        {/* Viền báo hiệu khi đang chọn NHIỀU phần tử. Lúc chọn một cái thì mỗi loại phần tử
            đã có cách tự làm nổi riêng (Transformer, nét đậm hơn…) nên không vẽ chồng.
            name="ui-overlay" để lúc xuất ảnh ẩn đi — xem buildFlattenedPng. */}
        {selectedIds.length > 1 &&
          allBounds()
            .filter(({ id }) => selectedSet.has(id))
            .map(({ id, b }) => (
              <Rect
                key={`sel-${id}`}
                name="ui-overlay"
                x={b.x - 3}
                y={b.y - 3}
                width={b.w + 6}
                height={b.h + 6}
                stroke="#0b63f6"
                strokeWidth={1.5}
                dash={[5, 3]}
                strokeScaleEnabled={false}
                listening={false}
              />
            ))}

        {marqueeRect && (
          <Rect
            name="ui-overlay"
            x={marqueeRect.x}
            y={marqueeRect.y}
            width={marqueeRect.w}
            height={marqueeRect.h}
            fill="rgba(11,99,246,0.12)"
            stroke="#0b63f6"
            strokeWidth={1}
            dash={[4, 3]}
            strokeScaleEnabled={false}
            listening={false}
          />
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
      <textarea
        ref={inputRef}
        className="note-edit-input"
        value={draft}
        placeholder=""
        rows={3}
        style={{ left: editing.left, top: editing.top, color, resize: "both", minWidth: 200, minHeight: 70 }}
        onChange={(e) => {
          setDraft(e.target.value);
          draftRef.current = e.target.value;
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            finishEdit(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finishEdit(false);
          }
          // Enter đơn thuần = xuống dòng (textarea default)
        }}
        onBlur={() => {
          if (performance.now() - openedAt.current < 300) {
            inputRef.current?.focus();
            return;
          }
          finishEdit(true);
        }}
      />
    )}
    </>
  );
}

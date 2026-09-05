import { useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { AnnotateCanvas, HIGHLIGHT_OPACITY, measureInfo, toImagePoint } from "../components/AnnotateCanvas";
import { Toolbar, HIGHLIGHT_COLORS } from "../components/Toolbar";
import { flattenStage, dataUrlToBlob, imageToWebpBlob, webpQuality } from "../lib/flatten";
import type { Annotations, Arrow, Box, Highlight, Measure, Note, Shape, StepMarker, Tool } from "../types";
import { nanoid } from "nanoid";
import jsQR from "jsqr";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

/** 5 -> "05" (dựng mốc thời gian cho tên file lưu về máy) */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

type ClipItem =
  | { kind: "box"; data: Box }
  | { kind: "arrow"; data: Arrow }
  | { kind: "step"; data: StepMarker }
  | { kind: "note"; data: Note }
  | { kind: "highlight"; data: Highlight }
  | { kind: "measure"; data: Measure }
  | { kind: "shape"; data: Shape };

const COLOR = "#ff2d2d"; // màu khung + note (đỏ)
const PADDING = 24; // khớp padding của .canvas-area trong App.css
const DEFAULT_HL_THICKNESS = 20;
// Bán kính làm mờ mặc định: đủ để chữ cỡ thường không đọc lại được.
const DEFAULT_BLUR = 14;

interface Props {
  imageDataUrl: string;
  initialAnnotations?: Annotations | null;
  initialTitle?: string;
  onBack: () => void;
  onSaved: (flattened: Blob, original: Blob, annotations: Annotations, title: string) => void;
  /** Mức chất lượng ảnh đang chọn (chiều cao tối đa) — quyết định mức nén khi xuất. */
  imageQuality: number;
}

export function EditorScreen({ imageDataUrl, initialAnnotations, initialTitle, onBack, onSaved, imageQuality }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [steps, setSteps] = useState<StepMarker[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0].value);
  const [highlightThickness, setHighlightThickness] = useState(DEFAULT_HL_THICKNESS);
  const [highlightOpacity, setHighlightOpacity] = useState(HIGHLIGHT_OPACITY);
  // Số cho mốc Bước kế tiếp. Là con dấu đếm, KHÔNG suy ra từ các mốc đang có: có vậy mới
  // đặt lại về ① để đánh một luồng mới, hoặc bắt đầu từ số bất kỳ.
  const [stepNext, setStepNext] = useState(1);
  // Mặc định BẬT: đặt mốc là mở ô nhập luôn. Mốc Bước gần như lúc nào cũng cần chữ đi kèm
  // ("① Chọn sản phẩm"), số trơ trọi ít dùng — ai chỉ cần số thì tắt ô này.
  const [stepWithText, setStepWithText] = useState(true);
  const [blurStrength, setBlurStrength] = useState(DEFAULT_BLUR);
  // Màu vừa hút (hex) — hiện trên thanh công cụ và đã copy vào clipboard.
  const [pickedColor, setPickedColor] = useState<string | null>(null);
  // Danh sách phần tử đang chọn. Kéo tô một vùng trống trên ảnh chọn được nhiều cái để xoá
  // cả loạt. Các thao tác chỉnh MỘT phần tử (co giãn, đổi màu vệt tô, đọc số đo, copy) chỉ
  // có nghĩa khi đúng một cái đang chọn — nên selectedId suy ra từ đây, không giữ state riêng
  // (hai nguồn sự thật thì sớm muộn cũng lệch nhau).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [saving, setSaving] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [savingLocal, setSavingLocal] = useState(false);
  const [title, setTitle] = useState(initialTitle ?? "");
  // Kích thước vùng canvas, do ResizeObserver đo được (0 = chưa đo lần nào)
  const [area, setArea] = useState({ w: 0, h: 0 });
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const appliedInit = useRef(false);
  const lastScale = useRef<number | null>(null); // tỉ lệ hiển thị lần trước, để rescale khi resize (H6)
  const clipboard = useRef<ClipItem | null>(null);

  // ── Undo/Redo ──────────────────────────────────────────────
  // Lưu lịch sử "ảnh chụp" trạng thái annotate. Ghi theo debounce 300ms để gộp
  // các thay đổi liên tục (kéo vẽ khung/mũi tên, kéo thả) thành 1 bước undo.
  // stepNext nằm trong ảnh chụp để hoàn tác một mốc Bước thì con dấu đếm lùi về theo,
  // không để tình trạng vừa undo mất mốc ③ mà lần đóng sau đã nhảy sang ④.
  type Snapshot = { boxes: Box[]; arrows: Arrow[]; steps: StepMarker[]; notes: Note[]; highlights: Highlight[]; measures: Measure[]; shapes: Shape[]; stepNext: number };
  const history = useRef<Snapshot[]>([]);
  const histIndex = useRef(-1);
  // Lịch sử nằm trong ref (không gây render lại), nên nút Hoàn tác/Làm lại phải có cờ state
  // riêng — dựa trực tiếp vào ref thì trạng thái bật/tắt của nút luôn chậm một nhịp.
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const skipRecord = useRef(false); // true = trạng thái đổi do undo/redo → không ghi history
  const pendingRec = useRef<number | null>(null);

  type QrState = { found: true; text: string; isUrl: boolean } | { found: false } | null;
  const [qrResult, setQrResult] = useState<QrState>(null);

  function isHttpUrl(s: string): boolean {
    try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
  }

  function runQrDecode(source: HTMLImageElement, silent: boolean) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { if (!silent) setQrResult({ found: false }); return; }
      ctx.drawImage(source, 0, 0);
      const imageData = ctx.getImageData(0, 0, source.width, source.height);
      const code = jsQR(imageData.data, source.width, source.height);
      if (code) {
        setQrResult({ found: true, text: code.data, isUrl: isHttpUrl(code.data) });
      } else if (!silent) {
        setQrResult({ found: false });
      }
    } catch { if (!silent) setQrResult({ found: false }); }
  }

  function scanQr() {
    // Người dùng chủ động bấm "Quét QR" → báo rõ cả khi không tìm thấy (silent = false).
    const img = new Image();
    img.onload = () => runQrDecode(img, false);
    img.onerror = () => {};
    img.src = imageDataUrl;
  }

  // Tải ảnh từ data URL. KHÔNG tự quét QR ở đây: modal "Mã QR" chỉ hiện khi người dùng
  // chủ động bấm nút Quét QR — tránh popup QR khi chỉ chụp/sửa ảnh bình thường.
  useEffect(() => {
    setQrResult(null);
    const image = new Image();
    image.onload = () => {
      setImg(image);
    };
    image.src = imageDataUrl;
  }, [imageDataUrl]);

  // Theo dõi kích thước THẬT của vùng canvas (đổi khi resize cửa sổ, khi hàng tuỳ chọn
  // hiện/ẩn, khi dòng gợi ý xuống hai dòng…). Bỏ qua chênh lệch dưới 1px để tránh vòng lặp
  // với thanh cuộn của chính vùng đó.
  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setArea((prev) => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Phím tắt trong editor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = !!(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));

      // Ctrl/Cmd+S: LUÔN lưu (flatten → upload R2 → cấp link), kể cả khi con trỏ đang ở
      // ô "Tiêu đề". Trước đây phím tắt bị chặn khi focus trong input nên bấm Ctrl+S lúc
      // đang gõ tiêu đề sẽ không lưu gì → người dùng tưởng app không tự lưu.
      if ((e.ctrlKey || e.metaKey) && (e.code === "KeyS" || e.key.toLowerCase() === "s")) {
        e.preventDefault();
        handleSave();
        return;
      }

      // Đang gõ trong ô nhập (ghi chú / tiêu đề)? Bỏ qua các phím tắt còn lại,
      // nếu không Backspace/Delete/Escape sẽ xoá luôn nội dung đang soạn.
      if (inField) return;

      if (e.key === "Escape") {
        // Đang chọn dở (nhất là vừa kéo tô trúng cả chục phần tử) thì Esc bỏ chọn trước.
        // Thoát hẳn trình sửa là việc của lần nhấn sau — nếu không, lỡ tay Esc là mất luôn
        // ảnh đang chú thích.
        if (selectedIds.length > 0) {
          setSelectedIds([]);
          return;
        }
        onBack();
        return;
      }
      // Hoàn tác / Làm lại (e.code không lệ thuộc layout bàn phím)
      if ((e.ctrlKey || e.metaKey) && (e.code === "KeyZ" || e.key.toLowerCase() === "z")) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.code === "KeyY" || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && !selectedId) {
        e.preventDefault();
        copyImage();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && selectedId) {
        e.preventDefault();
        const box = boxes.find((b) => b.id === selectedId);
        if (box) { clipboard.current = { kind: "box", data: box }; return; }
        const arrow = arrows.find((a) => a.id === selectedId);
        if (arrow) { clipboard.current = { kind: "arrow", data: arrow }; return; }
        const step = steps.find((s) => s.id === selectedId);
        if (step) { clipboard.current = { kind: "step", data: step }; return; }
        const note = notes.find((n) => n.id === selectedId);
        if (note) { clipboard.current = { kind: "note", data: note }; return; }
        const hl = highlights.find((h) => h.id === selectedId);
        if (hl) { clipboard.current = { kind: "highlight", data: hl }; return; }
        const me = measures.find((m) => m.id === selectedId);
        if (me) { clipboard.current = { kind: "measure", data: me }; return; }
        const sh = shapes.find((x) => x.id === selectedId);
        if (sh) { clipboard.current = { kind: "shape", data: sh }; return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        e.preventDefault();
        e.stopPropagation();
        const clip = clipboard.current;
        if (!clip) return;
        const D = 15;
        const newId = nanoid();
        if (clip.kind === "box") {
          setBoxes((prev) => [...prev, { ...clip.data, id: newId, x: clip.data.x + D, y: clip.data.y + D }]);
        } else if (clip.kind === "arrow") {
          setArrows((prev) => [...prev, { ...clip.data, id: newId, x1: clip.data.x1 + D, y1: clip.data.y1 + D, x2: clip.data.x2 + D, y2: clip.data.y2 + D }]);
        } else if (clip.kind === "step") {
          setSteps((prev) => [...prev, { ...clip.data, id: newId, x: clip.data.x + D, y: clip.data.y + D }]);
        } else if (clip.kind === "note") {
          setNotes((prev) => [...prev, { ...clip.data, id: newId, x: clip.data.x + D, y: clip.data.y + D }]);
        } else if (clip.kind === "highlight") {
          setHighlights((prev) => [...prev, { ...clip.data, id: newId, x: clip.data.x + D, y: clip.data.y + D }]);
        } else if (clip.kind === "shape") {
          const d = clip.data;
          setShapes((prev) => [
            ...prev,
            d.kind === "ellipse" || d.kind === "blur"
              ? { ...d, id: newId, x: d.x + D, y: d.y + D }
              : d.kind === "line"
                ? { ...d, id: newId, x1: d.x1 + D, y1: d.y1 + D, x2: d.x2 + D, y2: d.y2 + D }
                : { ...d, id: newId, points: d.points.map((v) => v + D) },
          ]);
        } else if (clip.kind === "measure") {
          setMeasures((prev) => [...prev, { ...clip.data, id: newId, x1: clip.data.x1 + D, y1: clip.data.y1 + D, x2: clip.data.x2 + D, y2: clip.data.y2 + D }]);
        }
        setSelectedIds([newId]);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length > 0) {
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Tỉ lệ hiển thị vừa khít khung. ĐO vùng canvas thật thay vì lấy kích thước cửa sổ trừ
  // đi các hằng số chiều cao: trước đây TOOLBAR_H = 56 trong khi thanh công cụ thật cao
  // 60px, lại không trừ dòng gợi ý phía dưới, nên ảnh luôn hơi quá khổ và sinh thanh cuộn
  // — càng lộ khi cửa sổ nhỏ. Đo trực tiếp thì mọi hàng phụ hiện/ẩn đều tự vào đúng chỗ.
  const fit = useMemo(() => {
    if (!img || area.w === 0 || area.h === 0) return { scale: 1, w: 0, h: 0 };
    const maxW = area.w - PADDING * 2;
    const maxH = area.h - PADDING * 2;
    if (maxW <= 0 || maxH <= 0) return { scale: 1, w: 0, h: 0 };
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    return { scale, w: img.width * scale, h: img.height * scale };
  }, [img, area]);

  // Nạp annotate cũ khi mở để SỬA (toạ độ gốc → toạ độ hiển thị)
  useEffect(() => {
    if (!img || appliedInit.current) return;
    let base: Snapshot = { boxes: [], arrows: [], steps: [], notes: [], highlights: [], measures: [], shapes: [], stepNext: 1 };
    if (initialAnnotations) {
      const s = fit.scale;
      const b = initialAnnotations.boxes.map((x) => ({ ...x, x: x.x * s, y: x.y * s, w: x.w * s, h: x.h * s }));
      const a = (initialAnnotations.arrows ?? []).map((x) => ({ ...x, x1: x.x1 * s, y1: x.y1 * s, x2: x.x2 * s, y2: x.y2 * s }));
      const st = (initialAnnotations.steps ?? []).map((x) => ({ ...x, x: x.x * s, y: x.y * s }));
      const n = initialAnnotations.notes.map((x) => ({ ...x, x: x.x * s, y: x.y * s }));
      // Bản lưu trước khi có bút tô sáng không có trường này → mặc định rỗng.
      const hl = (initialAnnotations.highlights ?? []).map((x) => ({
        ...x,
        x: x.x * s, y: x.y * s, w: x.w * s, h: x.h * s,
        opacity: x.opacity ?? HIGHLIGHT_OPACITY,
      }));
      const sh = (initialAnnotations.shapes ?? []).map((x) =>
        x.kind === "ellipse"
          ? { ...x, x: x.x * s, y: x.y * s, w: x.w * s, h: x.h * s }
            : x.kind === "blur"
              ? { ...x, x: x.x * s, y: x.y * s, w: x.w * s, h: x.h * s, strength: x.strength * s }
          : x.kind === "line"
            ? { ...x, x1: x.x1 * s, y1: x.y1 * s, x2: x.x2 * s, y2: x.y2 * s }
            : { ...x, points: x.points.map((v) => v * s), width: x.width }
      );
      const ms = (initialAnnotations.measures ?? []).map((x) => ({
        ...x,
        x1: x.x1 * s, y1: x.y1 * s, x2: x.x2 * s, y2: x.y2 * s,
      }));
      setBoxes(b); setArrows(a); setSteps(st); setNotes(n); setHighlights(hl); setMeasures(ms); setShapes(sh);
      // Mở ảnh cũ ra sửa thì đánh tiếp từ sau mốc lớn nhất, không quay về ① đè số cũ.
      const next = st.length > 0 ? Math.max(...st.map((x) => x.step)) + 1 : 1;
      setStepNext(next);
      base = { boxes: b, arrows: a, steps: st, notes: n, highlights: hl, measures: ms, shapes: sh, stepNext: next };
      skipRecord.current = true; // nạp ban đầu không tính là 1 bước undo
    }
    // Seed baseline: undo sẽ dừng ở trạng thái mở ban đầu, không lùi quá
    history.current = [cloneSnap(base)];
    histIndex.current = 0;
    appliedInit.current = true;
    lastScale.current = fit.scale; // mốc tỉ lệ ban đầu để rescale khi resize (H6)
  }, [img, fit.scale, initialAnnotations]);

  // H6: khi cửa sổ resize/phóng to → fit.scale đổi → rescale MỌI annotation theo tỉ lệ mới
  // để không lệch khỏi ảnh nền, và Lưu vẫn ra đúng toạ độ gốc (annotation lưu theo toạ độ
  // hiển thị nên phải co giãn cùng nền).
  useEffect(() => {
    if (!img) return;
    const s = fit.scale;
    if (lastScale.current === null) { lastScale.current = s; return; }
    if (s === lastScale.current || s === 0) return;
    const r = s / lastScale.current;
    lastScale.current = s;
    skipRecord.current = true; // rescale không tính là 1 bước undo
    setBoxes((prev) => prev.map((b) => ({ ...b, x: b.x * r, y: b.y * r, w: b.w * r, h: b.h * r })));
    setArrows((prev) => prev.map((a) => ({ ...a, x1: a.x1 * r, y1: a.y1 * r, x2: a.x2 * r, y2: a.y2 * r })));
    setSteps((prev) => prev.map((st) => ({ ...st, x: st.x * r, y: st.y * r })));
    setNotes((prev) => prev.map((n) => ({ ...n, x: n.x * r, y: n.y * r })));
    setHighlights((prev) => prev.map((h) => ({ ...h, x: h.x * r, y: h.y * r, w: h.w * r, h: h.h * r })));
    setMeasures((prev) => prev.map((m) => ({ ...m, x1: m.x1 * r, y1: m.y1 * r, x2: m.x2 * r, y2: m.y2 * r })));
    setShapes((prev) =>
      prev.map((sh) =>
        sh.kind === "ellipse"
          ? { ...sh, x: sh.x * r, y: sh.y * r, w: sh.w * r, h: sh.h * r }
            : sh.kind === "blur"
              ? { ...sh, x: sh.x * r, y: sh.y * r, w: sh.w * r, h: sh.h * r, strength: sh.strength * r }
          : sh.kind === "line"
            ? { ...sh, x1: sh.x1 * r, y1: sh.y1 * r, x2: sh.x2 * r, y2: sh.y2 * r }
            : { ...sh, points: sh.points.map((v) => v * r) }
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit.scale, img]);

  // Vệt tô đang được chọn (nếu có) — để thanh công cụ chỉnh thẳng vào nó.
  const selectedHighlight = highlights.find((h) => h.id === selectedId) ?? null;

  // Số đo của thước đang chọn, quy về pixel ảnh gốc để hiện trên thanh công cụ.
  const selectedMeasure = measures.find((m) => m.id === selectedId) ?? null;
  const measureReadout = selectedMeasure
    ? (() => {
        const info = measureInfo(selectedMeasure, fit.scale);
        return {
          w: info.w,
          h: info.h,
          dist: info.dist,
          from: toImagePoint(selectedMeasure.x1, selectedMeasure.y1, fit.scale),
          to: toImagePoint(selectedMeasure.x2, selectedMeasure.y2, fit.scale),
        };
      })()
    : null;

  // Đổi độ dày: áp cho vệt đang chọn luôn. Dải mỏng khiến hai tay cầm trên/dưới của khung
  // chọn nằm sát nhau, kéo rất khó trúng — chỉnh bằng thanh trượt thì chắc tay hơn nhiều.
  // Giữ nguyên tâm dọc để vệt dày lên/mỏng đi tại chỗ, không trôi khỏi dòng chữ.
  function changeHighlightThickness(n: number) {
    setHighlightThickness(n);
    if (!selectedHighlight) return;
    setHighlights((prev) =>
      prev.map((h) => (h.id === selectedHighlight.id ? { ...h, y: h.y + (h.h - n) / 2, h: n } : h))
    );
  }

  function changeHighlightColor(c: string) {
    setHighlightColor(c);
    if (!selectedHighlight) return;
    setHighlights((prev) => prev.map((h) => (h.id === selectedHighlight.id ? { ...h, color: c } : h)));
  }

  // Hút màu: copy luôn mã hex vào clipboard — lấy màu ra là để dán vào chỗ khác.
  async function handlePickColor(hex: string) {
    setPickedColor(hex);
    try {
      await writeText(hex);
      setCopyMsg(`Đã copy ${hex}`);
    } catch {
      setCopyMsg(hex); // copy hỏng thì vẫn hiện mã để người dùng tự ghi lại
    }
    window.setTimeout(() => setCopyMsg(null), 1800);
  }

  // Đổi độ mờ: áp cho vùng che đang chọn luôn, giống cách thanh độ dày làm với vệt tô sáng.
  function changeBlurStrength(n: number) {
    setBlurStrength(n);
    if (!selectedId) return;
    setShapes((prev) =>
      prev.map((s) => (s.id === selectedId && s.kind === "blur" ? { ...s, strength: n } : s))
    );
  }

  function changeHighlightOpacity(o: number) {
    setHighlightOpacity(o);
    if (!selectedHighlight) return;
    setHighlights((prev) => prev.map((h) => (h.id === selectedHighlight.id ? { ...h, opacity: o } : h)));
  }

  function deleteSelected() {
    if (selectedIds.length === 0) return;
    const gone = new Set(selectedIds);
    setBoxes((prev) => prev.filter((b) => !gone.has(b.id)));
    setArrows((prev) => prev.filter((a) => !gone.has(a.id)));
    setSteps((prev) => prev.filter((st) => !gone.has(st.id)));
    setNotes((prev) => prev.filter((n) => !gone.has(n.id)));
    setHighlights((prev) => prev.filter((h) => !gone.has(h.id)));
    setMeasures((prev) => prev.filter((m) => !gone.has(m.id)));
    setShapes((prev) => prev.filter((s) => !gone.has(s.id)));
    setSelectedIds([]);
  }

  // ── Undo/Redo helpers ──────────────────────────────────────
  function cloneSnap(s: Snapshot): Snapshot {
    return {
      boxes: s.boxes.map((x) => ({ ...x })),
      arrows: s.arrows.map((x) => ({ ...x })),
      steps: s.steps.map((x) => ({ ...x })),
      notes: s.notes.map((x) => ({ ...x })),
      highlights: s.highlights.map((x) => ({ ...x })),
      measures: s.measures.map((x) => ({ ...x })),
      shapes: s.shapes.map((x) => ({ ...x })),
      stepNext: s.stepNext,
    };
  }
  // So sánh dedup CHỈ theo hình vẽ: đổi mỗi con số sắp đóng thì không đáng một bước undo.
  function snapKey(s: Snapshot): string {
    return JSON.stringify([s.boxes, s.arrows, s.steps, s.notes, s.highlights, s.measures, s.shapes]);
  }
  // Ghi ngay trạng thái hiện tại vào history (bỏ qua nếu trùng bước trước đó)
  function recordNow() {
    const snap = cloneSnap({ boxes, arrows, steps, notes, highlights, measures, shapes, stepNext });
    const cur = history.current[histIndex.current];
    if (cur && snapKey(cur) === snapKey(snap)) return;
    history.current = history.current.slice(0, histIndex.current + 1);
    history.current.push(snap);
    histIndex.current = history.current.length - 1;
    syncHistFlags();
  }
  // Đồng bộ cờ bật/tắt cho nút Hoàn tác/Làm lại sau mỗi lần lịch sử thay đổi.
  function syncHistFlags() {
    setCanUndo(histIndex.current > 0);
    setCanRedo(histIndex.current < history.current.length - 1);
  }
  // Ghi ngay nếu còn bản chờ debounce — gọi trước undo/redo để không sót thao tác vừa làm
  function flushRecord() {
    if (pendingRec.current != null) {
      window.clearTimeout(pendingRec.current);
      pendingRec.current = null;
      recordNow();
    }
  }
  function restoreSnap(snap: Snapshot) {
    skipRecord.current = true; // các set* dưới đây là khôi phục, không tính thành bước mới
    setBoxes(snap.boxes.map((x) => ({ ...x })));
    setArrows(snap.arrows.map((x) => ({ ...x })));
    setSteps(snap.steps.map((x) => ({ ...x })));
    setNotes(snap.notes.map((x) => ({ ...x })));
    setHighlights(snap.highlights.map((x) => ({ ...x })));
    setMeasures(snap.measures.map((x) => ({ ...x })));
    setShapes(snap.shapes.map((x) => ({ ...x })));
    setStepNext(snap.stepNext);
    setSelectedIds([]);
  }
  function undo() {
    flushRecord();
    if (histIndex.current <= 0) return;
    histIndex.current -= 1;
    restoreSnap(history.current[histIndex.current]);
    syncHistFlags();
  }
  function redo() {
    flushRecord();
    if (histIndex.current >= history.current.length - 1) return;
    histIndex.current += 1;
    restoreSnap(history.current[histIndex.current]);
    syncHistFlags();
  }

  // Xuất ảnh đã gộp (nền + khung + mũi tên + bước + ghi chú) ra PNG.
  // Ẩn khung chọn (Transformer) tạm thời để không bị vẽ vào ảnh — nhưng KHÔNG bỏ chọn
  // để người dùng giữ nguyên phần tử đang chọn.
  function buildFlattenedPng(): Blob | null {
    const dataUrl = buildFlattenedPngDataUrl();
    return dataUrl ? dataUrlToBlob(dataUrl) : null;
  }

  /** Như trên nhưng trả thẳng data URL — lưu ra máy cần chuỗi base64, đổi sang Blob rồi
   *  mã hoá ngược lại là thừa một vòng với ảnh vài MB. */
  function buildFlattenedPngDataUrl(): string | null {
    const stage = stageRef.current;
    if (!stage || !img) return null;
    const tr = stage.findOne("Transformer") as Konva.Transformer | undefined;
    const trVisible = tr?.visible() ?? false;
    if (tr && trVisible) tr.visible(false);
    // Viền chọn nhiều + khung kéo tô: chỉ là chỉ dẫn trên màn hình, không phải chú thích.
    // Hàm này KHÔNG bỏ chọn (copy ảnh giữa chừng vẫn giữ nguyên phần tử đang chọn), nên
    // phải tự ẩn — thiếu bước này thì ảnh copy dính mấy nét đứt màu xanh.
    const overlays = Array.from(stage.find(".ui-overlay"));
    overlays.forEach((n) => n.visible(false));
    if (tr || overlays.length) stage.getLayers().forEach((l) => l.batchDraw());
    try {
      const pixelRatio = 1 / fit.scale; // xuất đúng độ phân giải gốc
      return stage.toDataURL({ mimeType: "image/png", pixelRatio });
    } finally {
      if (tr && trVisible) tr.visible(true);
      overlays.forEach((n) => n.visible(true));
      if (tr || overlays.length) stage.getLayers().forEach((l) => l.batchDraw());
    }
  }

  async function copyImage() {
    const blob = buildFlattenedPng();
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopyMsg("Đã copy ảnh ✓");
    } catch {
      setCopyMsg("Copy thất bại");
    } finally {
      window.setTimeout(() => setCopyMsg(null), 1800);
    }
  }

  /** Lưu ảnh (đã gộp chú thích) thành file trên máy, KHÔNG đăng lên cloud và không cấp
   *  link. Dùng cho lúc chỉ cần cái file: đính vào mail, gửi Zalo, kẹp vào tài liệu. */
  async function saveToDisk() {
    if (savingLocal) return;
    const dataUrl = buildFlattenedPngDataUrl();
    if (!dataUrl) return;
    setSavingLocal(true);
    try {
      // Tiêu đề thành tên file, bỏ các ký tự Windows không cho đặt tên; trống thì lấy
      // mốc thời gian để hai lần lưu liên tiếp không đè lên nhau.
      const clean = title.trim().replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").slice(0, 60).trim();
      const d = new Date();
      const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
      const dst = await saveDialog({
        defaultPath: `${clean || "anh-chup"}-${stamp}.png`,
        filters: [{ name: "Ảnh PNG", extensions: ["png"] }],
      });
      if (!dst) return; // người dùng bấm Huỷ — không phải lỗi, đừng báo gì
      await invoke("save_image_to_path", { dataUrl, dst });
      setCopyMsg("Đã lưu ảnh về máy ✓");
    } catch (err) {
      setCopyMsg("Lưu thất bại: " + String(err));
    } finally {
      setSavingLocal(false);
      window.setTimeout(() => setCopyMsg(null), 2200);
    }
  }

  // Tự đồng bộ clipboard hệ thống với ảnh đã chú thích.
  // Khi chụp xong, Rust copy ảnh GỐC vào clipboard; mỗi khi thêm/sửa khung, mũi tên,
  // bước, ghi chú… ta ghi đè bằng ảnh đã gộp để Ctrl+V ở app khác ra đúng ảnh có chú thích
  // (không cần bấm Ctrl+C thủ công). Debounce để tránh ghi clipboard liên tục khi đang vẽ.
  useEffect(() => {
    if (!img) return;
    const t = window.setTimeout(async () => {
      try {
        const blob = buildFlattenedPng();
        if (!blob) return;
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      } catch {
        // Bỏ qua: thường do cửa sổ mất focus — vẫn còn nút/Ctrl+C để copy thủ công.
      }
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, boxes, arrows, steps, notes, highlights, measures, shapes, fit.scale]);

  // Ghi history mỗi khi annotate đổi (debounce 300ms → gộp thao tác kéo/vẽ thành 1 bước)
  useEffect(() => {
    if (!img) return;
    if (skipRecord.current) { skipRecord.current = false; return; }
    if (pendingRec.current != null) window.clearTimeout(pendingRec.current);
    pendingRec.current = window.setTimeout(() => {
      pendingRec.current = null;
      recordNow();
    }, 300);
    return () => {
      if (pendingRec.current != null) { window.clearTimeout(pendingRec.current); pendingRec.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, boxes, arrows, steps, notes, highlights, measures, shapes]);

  async function handleSave() {
    if (!stageRef.current || !img) return;
    // H7: commit ghi chú đang gõ trước khi xuất ảnh. Blur ô note → onBlur gọi finishNote,
    // đưa chữ vào state; nếu không (vd bấm Ctrl+S khi con trỏ ở ô note) note sẽ bị bỏ
    // khỏi ảnh xuất và mất chữ vừa gõ.
    (document.activeElement as HTMLElement | null)?.blur();
    setSaving(true);
    // Bỏ chọn để Transformer và viền chọn nhiều không bị vẽ vào ảnh xuất ra
    setSelectedIds([]);
    // Chờ 2 frame: đủ để state (note vừa commit + bỏ chọn) áp dụng và Konva vẽ lại.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const pixelRatio = 1 / fit.scale; // xuất đúng độ phân giải gốc
    const blob = flattenStage(stageRef.current, pixelRatio, webpQuality(imageQuality));

    // Quy đổi toạ độ về kích thước ảnh gốc
    const s = fit.scale;
    const annotations: Annotations = {
      imageW: img.width,
      imageH: img.height,
      boxes: boxes.map((b) => ({ ...b, x: b.x / s, y: b.y / s, w: b.w / s, h: b.h / s })),
      arrows: arrows.map((a) => ({ ...a, x1: a.x1 / s, y1: a.y1 / s, x2: a.x2 / s, y2: a.y2 / s })),
      steps: steps.map((st) => ({ ...st, x: st.x / s, y: st.y / s })),
      notes: notes.map((n) => ({ ...n, x: n.x / s, y: n.y / s })),
      highlights: highlights.map((h) => ({ ...h, x: h.x / s, y: h.y / s, w: h.w / s, h: h.h / s })),
      measures: measures.map((m) => ({ ...m, x1: m.x1 / s, y1: m.y1 / s, x2: m.x2 / s, y2: m.y2 / s })),
      shapes: shapes.map((sh) =>
        sh.kind === "ellipse"
          ? { ...sh, x: sh.x / s, y: sh.y / s, w: sh.w / s, h: sh.h / s }
            : sh.kind === "blur"
              ? { ...sh, x: sh.x / s, y: sh.y / s, w: sh.w / s, h: sh.h / s, strength: sh.strength / s }
          : sh.kind === "line"
            ? { ...sh, x1: sh.x1 / s, y1: sh.y1 / s, x2: sh.x2 / s, y2: sh.y2 / s }
            : { ...sh, points: sh.points.map((v) => v / s) }
      ),
    };

    // Ảnh gốc (để sau này sửa lại annotate) — WebP lossless, không phụ thuộc mức chất lượng:
    // đây là bản master, mỗi lần sửa lại đều dựng từ nó nên không được mất nét.
    // Trước đây giữ nguyên PNG full màn hình (vài MB) nên upload lên R2 rất lâu.
    const original = (await imageToWebpBlob(img)) ?? dataUrlToBlob(imageDataUrl);

    setSaving(false);
    onSaved(blob, original, annotations, title.trim());
  }

  const QrModal = qrResult !== null ? (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
    }}>
      <div style={{
        background: "#1c1c1e", color: "#fff", borderRadius: 14, padding: "22px 24px",
        width: 400, maxWidth: "90vw", boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}>
        {!qrResult.found ? (
          <>
            <h3 style={{ margin: "0 0 12px" }}>Không phát hiện mã QR</h3>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setQrResult(null)}>Đóng</button>
            </div>
          </>
        ) : (
          <>
            <h3 style={{ margin: "0 0 10px" }}>Mã QR</h3>
            <div style={{
              background: "#000", borderRadius: 8, padding: "10px 12px",
              marginBottom: 14, wordBreak: "break-all", fontSize: 13,
              maxHeight: 150, overflow: "auto", lineHeight: 1.5,
            }}>
              {qrResult.text}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              {qrResult.isUrl && (
                <>
                  <button className="primary" onClick={() => openUrl(qrResult.text)}>
                    Mở trên trình duyệt
                  </button>
                  <button onClick={() => { writeText(qrResult.text); setQrResult(null); }}>
                    Copy link
                  </button>
                </>
              )}
              {!qrResult.isUrl && (
                <button onClick={() => { writeText(qrResult.text); setQrResult(null); }}>
                  Copy
                </button>
              )}
              <button onClick={() => setQrResult(null)}>Đóng</button>
            </div>
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="editor">
      {copyMsg && <div className="toast">{copyMsg}</div>}
      {QrModal}
      <Toolbar
        tool={tool}
        setTool={setTool}
        onDelete={deleteSelected}
        canDelete={selectedIds.length > 0}
        deleteCount={selectedIds.length}
        onBack={onBack}
        onSave={handleSave}
        saving={saving}
        title={title}
        setTitle={setTitle}
        onScanQr={scanQr}
        onSaveLocal={saveToDisk}
        savingLocal={savingLocal}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        highlightColor={selectedHighlight ? selectedHighlight.color : highlightColor}
        setHighlightColor={changeHighlightColor}
        highlightThickness={selectedHighlight ? Math.round(selectedHighlight.h) : highlightThickness}
        setHighlightThickness={changeHighlightThickness}
        highlightOpacity={selectedHighlight ? selectedHighlight.opacity : highlightOpacity}
        setHighlightOpacity={changeHighlightOpacity}
        showHighlightOptions={tool === "highlight" || !!selectedHighlight}
        editingSelected={!!selectedHighlight}
        stepNext={stepNext}
        setStepNext={setStepNext}
        stepWithText={stepWithText}
        setStepWithText={setStepWithText}
        measureReadout={measureReadout}
        blurStrength={blurStrength}
        setBlurStrength={changeBlurStrength}
        pickedColor={pickedColor}
      />
      <div className="canvas-area" ref={canvasAreaRef}>
        {img && (
          <AnnotateCanvas
            image={img}
            width={fit.w}
            height={fit.h}
            color={COLOR}
            tool={tool}
            setTool={setTool}
            stepNext={stepNext}
            setStepNext={setStepNext}
            stepWithText={stepWithText}
            blurStrength={blurStrength}
            onPickColor={handlePickColor}
            shapes={shapes}
            setShapes={setShapes}
            measures={measures}
            setMeasures={setMeasures}
            scale={fit.scale}
            highlightColor={highlightColor}
            highlightThickness={highlightThickness}
            highlightOpacity={highlightOpacity}
            highlights={highlights}
            setHighlights={setHighlights}
            boxes={boxes}
            setBoxes={setBoxes}
            arrows={arrows}
            setArrows={setArrows}
            steps={steps}
            setSteps={setSteps}
            notes={notes}
            setNotes={setNotes}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            stageRef={stageRef}
          />
        )}
      </div>
      <p className="hint editor-hint">
        Mẹo: <b>Khung ▾</b> đổi giữa khung, hình tròn, đường thẳng và bút vẽ tay · <b>Tô sáng</b> kéo ngang qua dòng chữ · <b>Bước</b> bấm liên tiếp để đặt ①②③… · <b>Ghi chú</b> bấm để thêm chữ (đúp để sửa) · <b>⋮ Thêm</b> có hoàn tác, làm lại và đo kích thước.
        Xoá: bấm vào phần tử rồi nhấn <b>Delete</b>. Xoá nhiều cùng lúc: dùng <b>↖ Chọn</b>, <b>kéo tô một vùng trống</b> quanh chúng rồi nhấn <b>Delete</b> (Esc để bỏ chọn).
      </p>
    </div>
  );
}

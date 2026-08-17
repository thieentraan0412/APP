import { useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { AnnotateCanvas, HIGHLIGHT_OPACITY } from "../components/AnnotateCanvas";
import { Toolbar, HIGHLIGHT_COLORS } from "../components/Toolbar";
import { flattenStage, dataUrlToBlob, imageToWebpBlob } from "../lib/flatten";
import type { Annotations, Arrow, Box, Highlight, Note, StepMarker, Tool } from "../types";
import { nanoid } from "nanoid";
import jsQR from "jsqr";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

type ClipItem =
  | { kind: "box"; data: Box }
  | { kind: "arrow"; data: Arrow }
  | { kind: "step"; data: StepMarker }
  | { kind: "note"; data: Note }
  | { kind: "highlight"; data: Highlight };

const COLOR = "#ff2d2d"; // màu khung + note (đỏ)
const TOOLBAR_H = 56;
const SUBTOOLBAR_H = 44; // hàng tuỳ chọn của bút tô sáng (chỉ hiện khi đang dùng bút đó)
const PADDING = 24;
const DEFAULT_HL_THICKNESS = 20;

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
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0].value);
  const [highlightThickness, setHighlightThickness] = useState(DEFAULT_HL_THICKNESS);
  const [highlightOpacity, setHighlightOpacity] = useState(HIGHLIGHT_OPACITY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const stageRef = useRef<Konva.Stage>(null);
  const appliedInit = useRef(false);
  const lastScale = useRef<number | null>(null); // tỉ lệ hiển thị lần trước, để rescale khi resize (H6)
  const clipboard = useRef<ClipItem | null>(null);

  // ── Undo/Redo ──────────────────────────────────────────────
  // Lưu lịch sử "ảnh chụp" trạng thái annotate. Ghi theo debounce 300ms để gộp
  // các thay đổi liên tục (kéo vẽ khung/mũi tên, kéo thả) thành 1 bước undo.
  type Snapshot = { boxes: Box[]; arrows: Arrow[]; steps: StepMarker[]; notes: Note[]; highlights: Highlight[] };
  const history = useRef<Snapshot[]>([]);
  const histIndex = useRef(-1);
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

  // Theo dõi kích thước cửa sổ để vừa khít ảnh
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
        }
        setSelectedId(newId);
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
    // Hàng tuỳ chọn bút tô sáng chiếm thêm một dòng → trừ luôn, nếu không ảnh cao hơn
    // vùng còn lại và sinh thanh cuộn. Đổi tỉ lệ thì hiệu ứng H6 bên dưới tự co giãn
    // mọi chú thích theo, nên không lệch khỏi nền.
    const subShown = tool === "highlight" || highlights.some((h) => h.id === selectedId);
    const maxW = viewport.w - PADDING * 2;
    const maxH = viewport.h - TOOLBAR_H - (subShown ? SUBTOOLBAR_H : 0) - PADDING * 2;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    return { scale, w: img.width * scale, h: img.height * scale };
    // highlights/selectedId chỉ dùng để biết hàng tuỳ chọn có hiện hay không.
  }, [img, viewport, tool, highlights, selectedId]);

  // Nạp annotate cũ khi mở để SỬA (toạ độ gốc → toạ độ hiển thị)
  useEffect(() => {
    if (!img || appliedInit.current) return;
    let base: Snapshot = { boxes: [], arrows: [], steps: [], notes: [], highlights: [] };
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
      setBoxes(b); setArrows(a); setSteps(st); setNotes(n); setHighlights(hl);
      base = { boxes: b, arrows: a, steps: st, notes: n, highlights: hl };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit.scale, img]);

  // Vệt tô đang được chọn (nếu có) — để thanh công cụ chỉnh thẳng vào nó.
  const selectedHighlight = highlights.find((h) => h.id === selectedId) ?? null;

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

  function changeHighlightOpacity(o: number) {
    setHighlightOpacity(o);
    if (!selectedHighlight) return;
    setHighlights((prev) => prev.map((h) => (h.id === selectedHighlight.id ? { ...h, opacity: o } : h)));
  }

  function deleteSelected() {
    if (!selectedId) return;
    setBoxes((prev) => prev.filter((b) => b.id !== selectedId));
    setArrows((prev) => prev.filter((a) => a.id !== selectedId));
    setSteps((prev) => prev.filter((st) => st.id !== selectedId));
    setNotes((prev) => prev.filter((n) => n.id !== selectedId));
    setHighlights((prev) => prev.filter((h) => h.id !== selectedId));
    setSelectedId(null);
  }

  // ── Undo/Redo helpers ──────────────────────────────────────
  function cloneSnap(s: Snapshot): Snapshot {
    return {
      boxes: s.boxes.map((x) => ({ ...x })),
      arrows: s.arrows.map((x) => ({ ...x })),
      steps: s.steps.map((x) => ({ ...x })),
      notes: s.notes.map((x) => ({ ...x })),
      highlights: s.highlights.map((x) => ({ ...x })),
    };
  }
  function snapKey(s: Snapshot): string {
    return JSON.stringify([s.boxes, s.arrows, s.steps, s.notes, s.highlights]);
  }
  // Ghi ngay trạng thái hiện tại vào history (bỏ qua nếu trùng bước trước đó)
  function recordNow() {
    const snap = cloneSnap({ boxes, arrows, steps, notes, highlights });
    const cur = history.current[histIndex.current];
    if (cur && snapKey(cur) === snapKey(snap)) return;
    history.current = history.current.slice(0, histIndex.current + 1);
    history.current.push(snap);
    histIndex.current = history.current.length - 1;
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
    setSelectedId(null);
  }
  function undo() {
    flushRecord();
    if (histIndex.current <= 0) return;
    histIndex.current -= 1;
    restoreSnap(history.current[histIndex.current]);
  }
  function redo() {
    flushRecord();
    if (histIndex.current >= history.current.length - 1) return;
    histIndex.current += 1;
    restoreSnap(history.current[histIndex.current]);
  }

  // Xuất ảnh đã gộp (nền + khung + mũi tên + bước + ghi chú) ra PNG.
  // Ẩn khung chọn (Transformer) tạm thời để không bị vẽ vào ảnh — nhưng KHÔNG bỏ chọn
  // để người dùng giữ nguyên phần tử đang chọn.
  function buildFlattenedPng(): Blob | null {
    const stage = stageRef.current;
    if (!stage || !img) return null;
    const tr = stage.findOne("Transformer") as Konva.Transformer | undefined;
    const trVisible = tr?.visible() ?? false;
    if (tr && trVisible) {
      tr.visible(false);
      tr.getLayer()?.batchDraw();
    }
    try {
      const pixelRatio = 1 / fit.scale; // xuất đúng độ phân giải gốc
      const dataUrl = stage.toDataURL({ mimeType: "image/png", pixelRatio });
      return dataUrlToBlob(dataUrl);
    } finally {
      if (tr && trVisible) {
        tr.visible(true);
        tr.getLayer()?.batchDraw();
      }
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
  }, [img, boxes, arrows, steps, notes, highlights, fit.scale]);

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
  }, [img, boxes, arrows, steps, notes, highlights]);

  async function handleSave() {
    if (!stageRef.current || !img) return;
    // H7: commit ghi chú đang gõ trước khi xuất ảnh. Blur ô note → onBlur gọi finishNote,
    // đưa chữ vào state; nếu không (vd bấm Ctrl+S khi con trỏ ở ô note) note sẽ bị bỏ
    // khỏi ảnh xuất và mất chữ vừa gõ.
    (document.activeElement as HTMLElement | null)?.blur();
    setSaving(true);
    // Bỏ chọn để Transformer không bị vẽ vào ảnh xuất ra
    setSelectedId(null);
    // Chờ 2 frame: đủ để state (note vừa commit + bỏ chọn) áp dụng và Konva vẽ lại.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
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
      highlights: highlights.map((h) => ({ ...h, x: h.x / s, y: h.y / s, w: h.w / s, h: h.h / s })),
    };

    // Ảnh gốc (để sau này sửa lại annotate) — nén WebP cho nhẹ.
    // Trước đây giữ nguyên PNG full màn hình (vài MB) nên upload lên R2 rất lâu.
    const original = (await imageToWebpBlob(img, 0.92)) ?? dataUrlToBlob(imageDataUrl);

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
        canDelete={!!selectedId}
        onBack={onBack}
        onSave={handleSave}
        saving={saving}
        title={title}
        setTitle={setTitle}
        onScanQr={scanQr}
        highlightColor={selectedHighlight ? selectedHighlight.color : highlightColor}
        setHighlightColor={changeHighlightColor}
        highlightThickness={selectedHighlight ? Math.round(selectedHighlight.h) : highlightThickness}
        setHighlightThickness={changeHighlightThickness}
        highlightOpacity={selectedHighlight ? selectedHighlight.opacity : highlightOpacity}
        setHighlightOpacity={changeHighlightOpacity}
        showHighlightOptions={tool === "highlight" || !!selectedHighlight}
        editingSelected={!!selectedHighlight}
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
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            stageRef={stageRef}
          />
        )}
      </div>
      <p className="hint editor-hint">
        Mẹo: <b>Khung</b> kéo vẽ ô · <b>Tô sáng</b> kéo ngang qua dòng chữ (tô liên tiếp được nhiều dòng) · <b>Mũi tên</b> kéo vẽ · <b>Bước</b> bấm để đặt số thứ tự · <b>Ghi chú</b> bấm để thêm chữ (đúp để sửa).
        Chọn phần tử rồi nhấn <b>Delete</b> để xoá.
      </p>
    </div>
  );
}

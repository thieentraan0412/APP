export type Tool = "select" | "box" | "arrow" | "step" | "note" | "highlight";

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface Arrow {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

export interface StepMarker {
  id: string;
  x: number;
  y: number;
  step: number;
  color: string;
}

export interface Note {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

// Dải tô sáng (bút highlight): kéo ngang qua dòng chữ cần làm nổi.
// Lưu như một hình chữ nhật để co giãn/di chuyển giống Box; độ dày chính là h.
export interface Highlight {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** 0..1 — để mờ thì chữ bên dưới vẫn đọc được */
  opacity: number;
}

// Dữ liệu annotate lưu kèm (toạ độ theo kích thước ảnh gốc)
export interface Annotations {
  imageW: number;
  imageH: number;
  boxes: Box[];
  arrows: Arrow[];
  steps: StepMarker[];
  notes: Note[];
  /** Thêm sau — bản lưu cũ không có trường này, khi đọc phải mặc định [] */
  highlights?: Highlight[];
}

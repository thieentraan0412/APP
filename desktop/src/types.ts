export type Tool = "select" | "box" | "arrow" | "step" | "note";

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

// Dữ liệu annotate lưu kèm (toạ độ theo kích thước ảnh gốc)
export interface Annotations {
  imageW: number;
  imageH: number;
  boxes: Box[];
  arrows: Arrow[];
  steps: StepMarker[];
  notes: Note[];
}

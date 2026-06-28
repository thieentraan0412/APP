export type Tool = "select" | "box" | "note";

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
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
  notes: Note[];
}

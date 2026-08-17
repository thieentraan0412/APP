export type Tool =
  | "select"
  | "box"
  | "ellipse"
  | "line"
  | "pen"
  | "blur"
  | "eyedrop"
  | "arrow"
  | "step"
  | "note"
  | "highlight"
  | "measure";

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
  /** Nội dung của bước, hiện ngay cạnh con số (vd "Chọn sản phẩm"). Thêm sau nên có thể
   *  thiếu ở bản lưu cũ; rỗng/thiếu thì chỉ hiện con số. */
  text?: string;
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

// Hình tròn / đường thẳng / nét bút vẽ tay — gộp CHUNG một mảng thay vì ba mảng riêng.
// Mỗi mảng mới phải nối vào chừng tám chỗ (state, ảnh chụp undo, co giãn theo cửa sổ, xoá,
// copy/paste, lưu, nạp lại, vẽ), nên gộp lại cắt được hai phần ba chỗ phải sửa và không
// bao giờ sót một nhánh.
export type Shape =
  | { kind: "ellipse"; id: string; x: number; y: number; w: number; h: number; color: string }
  | { kind: "line"; id: string; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: "pen"; id: string; points: number[]; color: string; width: number }
  // Vùng che mờ. `strength` = bán kính làm mờ, tính theo pixel HIỂN THỊ nên co giãn cùng
  // toạ độ; nếu giữ nguyên khi ảnh đổi tỉ lệ thì độ mờ trông khác hẳn lúc vẽ.
  | { kind: "blur"; id: string; x: number; y: number; w: number; h: number; strength: number };

// Thước đo A→B. Nhãn hiện số đo theo PIXEL ẢNH GỐC, không phải pixel trên màn hình —
// toạ độ ở đây lưu cùng quy ước với mọi chú thích khác nên quy đổi là chia cho tỉ lệ hiển thị.
export interface Measure {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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
  /** Thêm sau — bản lưu cũ không có trường này, khi đọc phải mặc định [] */
  highlights?: Highlight[];
  /** Thêm sau — như trên */
  measures?: Measure[];
  /** Thêm sau — như trên */
  shapes?: Shape[];
}

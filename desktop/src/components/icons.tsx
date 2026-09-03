import type { ReactNode, SVGProps } from "react";

// Bộ icon của hàng công cụ. Trước đây mỗi nút dùng một ký tự Unicode (▭ ◯ ▨ ▦ 🏷 🎨):
// cỡ và độ đậm mỗi ký tự một kiểu, emoji thì ra màu còn ký tự hình học thì nét mảnh — nhìn
// rời rạc. Tệ hơn: dưới 1180px nhãn chữ bị ẩn nên chỉ còn icon, mà ▨ (che mờ) với ▦ (QR)
// gần như giống hệt nhau. Vẽ lại bằng SVG cùng lưới 24×24, cùng nét 1.8, cùng cỡ 18px.

const SIZE = 18;

/** Khung chung cho mọi icon: nét theo màu chữ của nút nên tự đổi khi nút đang bật. */
function Svg({ children, ...rest }: { children: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconSelect() {
  return (
    <Svg>
      <path d="M4.2 3.4l6.9 16.4 2.4-7.1 7.1-2.4z" />
    </Svg>
  );
}

export function IconBox() {
  return (
    <Svg>
      <rect x="3.8" y="5.6" width="16.4" height="12.8" rx="1.6" />
    </Svg>
  );
}

export function IconEllipse() {
  return (
    <Svg>
      <ellipse cx="12" cy="12" rx="8.6" ry="7.2" />
    </Svg>
  );
}

export function IconLine() {
  return (
    <Svg>
      <path d="M4.6 19.4L19.4 4.6" />
    </Svg>
  );
}

export function IconPen() {
  return (
    <Svg>
      <path d="M4 20l1.1-4 11-11a2.1 2.1 0 0 1 3 3l-11 11z" />
      <path d="M14.2 6.9l3 3" />
    </Svg>
  );
}

export function IconArrow() {
  return (
    <Svg>
      <path d="M5 19L18.6 5.4" />
      <path d="M11.6 5h7.4v7.4" />
    </Svg>
  );
}

/** Mốc Bước hiện luôn con số sắp đóng — biết trước sẽ đặt ① hay ⑦ mà không cần mở hàng dưới. */
export function IconStep({ n }: { n: number }) {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8.6" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={n > 9 ? 9 : 11}
        fontWeight="700"
        fill="currentColor"
        stroke="none"
      >
        {n}
      </text>
    </Svg>
  );
}

export function IconNote() {
  return (
    <Svg>
      <path d="M20.4 15.2a1.8 1.8 0 0 1-1.8 1.8H8.2L4 20.6V6.2a1.8 1.8 0 0 1 1.8-1.8h12.8a1.8 1.8 0 0 1 1.8 1.8z" />
      <path d="M8 8.8h8" />
      <path d="M8 12.4h5" />
    </Svg>
  );
}

/** Bút dạ quang nghiêng 45° + vệt màu bên dưới tô đúng màu đang cầm (thay ô vuông rời trước đây). */
export function IconHighlight({ color }: { color: string }) {
  return (
    <Svg>
      <g transform="rotate(45 12 12)">
        <rect x="9.2" y="2.6" width="5.6" height="8.4" rx="1.6" />
        <path d="M9.2 11h5.6l-1.1 4.2h-3.4z" />
      </g>
      <rect x="3.5" y="19.6" width="17" height="2.8" rx="1.4" fill={color} stroke="none" />
    </Svg>
  );
}

// Lưới ô vuông đậm nhạt lẫn lộn = ảnh bị vỡ hạt. Khác hẳn hình QR nên ở chế độ chỉ-icon
// không còn lẫn hai nút với nhau nữa.
const BLUR_CELLS = [
  [0.85, 0.35, 0.6],
  [0.4, 0.72, 0.28],
  [0.62, 0.3, 0.8],
];

export function IconBlur() {
  return (
    <Svg>
      <g fill="currentColor" stroke="none">
        {BLUR_CELLS.map((row, r) =>
          row.map((o, c) => (
            <rect
              key={`${r}-${c}`}
              x={4.2 + c * 5.4}
              y={4.2 + r * 5.4}
              width={4.4}
              height={4.4}
              rx={1}
              opacity={o}
            />
          )),
        )}
      </g>
    </Svg>
  );
}

export function IconTrash() {
  return (
    <Svg>
      <path d="M4.6 6.6h14.8" />
      <path d="M9.4 6.6V5a1.4 1.4 0 0 1 1.4-1.4h2.4A1.4 1.4 0 0 1 14.6 5v1.6" />
      <path d="M6.4 6.6l.85 12.6a1.6 1.6 0 0 0 1.6 1.5h6.3a1.6 1.6 0 0 0 1.6-1.5l.85-12.6" />
      <path d="M10.4 10.6v6.2" />
      <path d="M13.6 10.6v6.2" />
    </Svg>
  );
}

export function IconQr() {
  return (
    <Svg>
      <rect x="3.6" y="3.6" width="7" height="7" rx="1.4" />
      <rect x="13.4" y="3.6" width="7" height="7" rx="1.4" />
      <rect x="3.6" y="13.4" width="7" height="7" rx="1.4" />
      <g fill="currentColor" stroke="none">
        <rect x="6.1" y="6.1" width="2" height="2" rx="0.5" />
        <rect x="15.9" y="6.1" width="2" height="2" rx="0.5" />
        <rect x="6.1" y="15.9" width="2" height="2" rx="0.5" />
        <rect x="13.4" y="13.4" width="3" height="3" rx="0.6" />
        <rect x="18" y="17.6" width="2.6" height="2.6" rx="0.6" />
        <rect x="13.4" y="18.6" width="2" height="2" rx="0.5" />
      </g>
    </Svg>
  );
}

export function IconMore() {
  return (
    <Svg>
      <g fill="currentColor" stroke="none">
        <circle cx="12" cy="5.4" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="12" cy="18.6" r="1.6" />
      </g>
    </Svg>
  );
}

export function IconCaret() {
  return (
    <Svg width={13} height={13}>
      <path d="M6.5 9.5L12 15l5.5-5.5" />
    </Svg>
  );
}

export function IconUndo() {
  return (
    <Svg>
      <path d="M4 9.5h9.5a5.25 5.25 0 0 1 0 10.5H9" />
      <path d="M8 5.5L4 9.5l4 4" />
    </Svg>
  );
}

export function IconRedo() {
  return (
    <Svg>
      <path d="M20 9.5h-9.5a5.25 5.25 0 0 0 0 10.5H15" />
      <path d="M16 5.5l4 4-4 4" />
    </Svg>
  );
}

export function IconMeasure() {
  return (
    <Svg>
      <rect x="2.6" y="8.4" width="18.8" height="7.2" rx="1.5" />
      <path d="M7 8.4v3.2" />
      <path d="M11 8.4v4.4" />
      <path d="M15 8.4v3.2" />
      <path d="M19 8.4v4.4" />
    </Svg>
  );
}

export function IconEyedrop() {
  return (
    <Svg>
      <g transform="rotate(-40 12 12)">
        <rect x="9.4" y="2.4" width="5.2" height="4.2" rx="1.5" />
        <path d="M10.4 6.6h3.2v3.2l-1 10.6h-1.2l-1-10.6z" />
      </g>
    </Svg>
  );
}

export function IconDownload() {
  return (
    <Svg>
      <path d="M12 3v12" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </Svg>
  );
}

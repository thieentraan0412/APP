import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

// Xem ảnh kết quả cho NÉT. Trước đây ảnh nằm trong khung có lề và bị chặn max-height:70vh, nên
// ảnh chụp 1920×1080 chỉ còn ~1257px (co 0,655) và chữ nhỏ nhòe hẳn. Đo trên Chromium: chỉ bỏ
// chặn chiều cao thôi thì lề 24px hai bên + thanh cuộn vẫn khiến ảnh co ~0,97 — đọc được nhưng
// chữ còn nhoè không đều. Chỉ đúng 1:1 mới sắc.
//
// Vì vậy khung xem TRÀN HẾT bề ngang cửa sổ, tự cuộn bên trong (thanh cuộn ẩn), và cỡ ảnh tính
// theo pixel MÀN HÌNH chứ không theo CSS px: trên máy scale 125%, ảnh chụp rộng 1920 pixel thật
// chỉ là 1536 CSS px — vẽ 1536 CSS px mới đúng 1:1, còn vẽ 1920 CSS px là phóng 1,25 lần và mờ.
//
// Ba cách xem, bấm vào ảnh để đổi (giống trang link chia sẻ):
//   ""      vừa chiều ngang — mặc định; cửa sổ đủ rộng thì chính là 1:1
//   "full"  kích thước thật — khi cửa sổ hẹp hơn ảnh
//   "whole" thu cả ảnh vào khung — khi ảnh đã 1:1 nhưng cao hơn khung, để nhìn tổng thể
type Mode = "" | "full" | "whole";

const HINT: Record<"full" | "whole" | "toFull" | "toWhole", string> = {
  full: "Đang xem kích thước thật · bấm vào ảnh để thu lại vừa chiều ngang",
  whole: "Đang thu nhỏ để xem toàn ảnh nên chữ nhỏ sẽ mờ · bấm vào ảnh để xem lại đúng kích thước",
  toFull: "Cửa sổ hẹp hơn ảnh nên đang thu vừa chiều ngang · bấm vào ảnh để xem đúng kích thước thật",
  toWhole: "Đang hiển thị đúng kích thước thật · cuộn để xem tiếp, hoặc bấm vào ảnh để thu toàn ảnh vào khung",
};

// Bên gọi đặt `key={src}` để mỗi ảnh mới là một lần mount sạch (về cách xem mặc định). Không
// reset bằng useEffect theo src: effect có thể chạy SAU sự kiện load của ảnh blob — vốn nạp gần
// như tức thì — rồi xoá mất kích thước gốc vừa đọc được, và ảnh không bao giờ về đúng 1:1.
export function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<Mode>("");

  // Theo dõi cỡ khung xem. Kéo cửa sổ sang màn hình có scale khác cũng làm đổi cỡ CSS của khung,
  // nên lần vẽ lại đó đọc được devicePixelRatio mới — không cần nghe riêng sự kiện đổi DPI.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Phòng khi ảnh đã nạp xong trước lúc gắn onLoad (ảnh lấy từ bộ nhớ đệm).
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setNat({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  let imgStyle: CSSProperties | undefined;
  let next: Mode | null = null; // bấm vào ảnh thì sang đâu; null = ảnh nằm gọn, không có gì để đổi
  let hint = "";
  if (nat && box.w > 0 && box.h > 0) {
    const dpr = window.devicePixelRatio || 1;
    const tw = nat.w / dpr;
    const th = nat.h / dpr;
    // Dư nửa pixel coi như vừa: làm tròn clientWidth không được biến ảnh 1920 thành "rộng hơn" khung 1920.
    next = mode ? "" : tw > box.w + 0.5 ? "full" : th > box.h + 0.5 ? "whole" : null;
    const w =
      mode === "full" ? tw
      : mode === "whole" ? Math.min(tw, box.w, (box.h * nat.w) / nat.h)
      : Math.min(tw, box.w);
    imgStyle = {
      width: w,
      height: (w * nat.h) / nat.w,
      maxWidth: "none",
      cursor: next === null ? "default" : mode === "full" || next === "whole" ? "zoom-out" : "zoom-in",
    };
    hint =
      mode === "full" ? HINT.full
      : mode === "whole" ? HINT.whole
      : next === "full" ? HINT.toFull
      : next === "whole" ? HINT.toWhole
      : "";
  }

  return (
    <>
      {/* Luôn giữ chỗ cho dòng gợi ý (chỉ ẩn đi) để khung xem không đổi chiều cao khi gợi ý
          hiện/ẩn — đổi chiều cao sẽ đổi luôn điều kiện "ảnh có cao hơn khung không". */}
      <p className="viewer-hint" style={{ visibility: hint ? "visible" : "hidden" }}>
        {hint || "·"}
      </p>
      <div className="viewer" ref={boxRef}>
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          title={hint}
          style={imgStyle}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onClick={() => {
            if (next !== null) setMode(next);
          }}
        />
      </div>
    </>
  );
}

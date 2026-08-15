interface Props {
  title: string;
  done: number;
  total: number;
  /** Tên mục đang xử lý — để người dùng thấy nó đang chạy chứ không treo. */
  label: string;
  bytesDone?: number;
  bytesTotal?: number;
}

function fmtBytes(b: number): string {
  if (b >= 1_000_000_000) return `${(b / 1_000_000_000).toFixed(2)} GB`;
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b >= 1_000) return `${(b / 1_000).toFixed(0)} KB`;
  return `${Math.round(b)} B`;
}

/**
 * Modal chặn màn hình trong lúc tải về máy / khôi phục. Trước đây tiến độ nằm trong vùng
 * cuộn của trang nên cuộn xuống là mất hút, không biết còn bao lâu.
 *
 * Không có nút đóng: đây là việc đang chạy dở, đóng giữa chừng không dừng được nó mà chỉ
 * làm người dùng tưởng đã xong.
 */
export function ProgressModal({ title, done, total, label, bytesDone, bytesTotal }: Props) {
  // total = 0 lúc mới bắt đầu (đang đọc thư mục, chưa biết bao nhiêu mục).
  const unknown = total === 0;
  // Ưu tiên phần trăm theo BYTE: đếm theo số mục thì tải xong 9 ảnh nhỏ đã nhảy 90% rồi
  // đứng im cả phút ở video cuối. Theo byte thì thanh chạy đều với thời gian thật.
  const useBytes = bytesTotal != null && bytesTotal > 0 && bytesDone != null;
  const pct = unknown
    ? 0
    : useBytes
      ? Math.min(100, Math.round((bytesDone! / bytesTotal!) * 100))
      : Math.min(100, Math.round((done / total) * 100));

  return (
    <div className="modal-backdrop">
      <div className="modal-box progress-box">
        <p className="progress-title">{title}</p>

        <div className="progress-pct">{unknown ? "…" : `${pct}%`}</div>

        <div className={`progress-track${unknown ? " progress-track--idle" : ""}`}>
          <div className="progress-fill" style={{ width: unknown ? "100%" : `${pct}%` }} />
        </div>

        <div className="progress-count">
          {unknown
            ? "Đang chuẩn bị…"
            : useBytes
              ? `${done} / ${total} mục · ${fmtBytes(bytesDone!)} / ${fmtBytes(bytesTotal!)}`
              : `${done} / ${total} mục`}
        </div>

        {label && <div className="progress-label" title={label}>{label}</div>}

        <p className="progress-hint">Đừng tắt app cho tới khi xong.</p>
      </div>
    </div>
  );
}

interface Props {
  message: string;
  confirmLabel?: string;
  /** Biểu tượng trên đầu hộp thoại. Mặc định thùng rác vì đa số nơi dùng là xoá. */
  icon?: string;
  /**
   * Hành động có phá huỷ dữ liệu không. Mặc định `true` để mọi chỗ gọi cũ giữ nguyên
   * hình thức cảnh báo. Đặt `false` cho việc an toàn (khôi phục, tải về…) — nút đỏ ghi
   * "Xoá" trên một hộp thoại khôi phục làm người dùng không dám bấm.
   */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  message,
  confirmLabel = "Xoá",
  icon = "🗑",
  danger = true,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon">{icon}</div>
        <p className="modal-message">{message}</p>
        <div className="modal-actions">
          <button className="modal-btn modal-btn--cancel" onClick={onCancel}>Huỷ</button>
          <button
            className={`modal-btn ${danger ? "modal-btn--danger" : "modal-btn--primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

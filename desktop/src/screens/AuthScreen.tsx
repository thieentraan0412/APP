import { useState } from "react";
import { login, register, type AuthUser } from "../lib/auth";

type Mode = "login" | "register";

// Tạm ẩn chức năng đăng ký — chỉ cho đăng nhập. Đổi thành true để bật lại.
const ALLOW_REGISTER = false;

export function AuthScreen({ onAuthed }: { onAuthed: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === "register";

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setConfirm("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const mail = email.trim();
    if (!mail || !password) {
      setError("Vui lòng nhập email và mật khẩu");
      return;
    }
    if (isRegister) {
      if (password.length < 6) {
        setError("Mật khẩu phải từ 6 ký tự trở lên");
        return;
      }
      if (password !== confirm) {
        setError("Mật khẩu nhập lại không khớp");
        return;
      }
    }

    setBusy(true);
    try {
      const user = isRegister ? await register(mail, password) : await login(mail, password);
      onAuthed(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "0.6rem 0.75rem",
    fontSize: "0.95rem",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-sm)",
    background: "var(--surface)",
    color: "var(--text)",
    outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "var(--text-soft)",
    marginBottom: 6,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: 380,
          maxWidth: "100%",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          padding: "28px 26px",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>📸</div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>CaptureShare</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--text-soft)" }}>
            {isRegister ? "Tạo tài khoản mới" : "Đăng nhập để tiếp tục"}
          </p>
        </div>

        {/* Chuyển tab Đăng nhập / Đăng ký */}
        {ALLOW_REGISTER && (
          <div
            style={{
              display: "flex",
              gap: 4,
              background: "var(--bg)",
              padding: 4,
              borderRadius: "var(--radius-sm)",
              marginBottom: 20,
            }}
          >
            {(["login", "register"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                style={{
                  flex: 1,
                  border: "none",
                  borderRadius: 6,
                  padding: "0.45rem 0",
                  fontWeight: 600,
                  background: mode === m ? "var(--surface)" : "transparent",
                  color: mode === m ? "var(--primary)" : "var(--text-soft)",
                  boxShadow: mode === m ? "var(--shadow-sm)" : "none",
                }}
              >
                {m === "login" ? "Đăng nhập" : "Đăng ký"}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={onSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Email</label>
            <input
              style={inputStyle}
              type="email"
              autoComplete="email"
              placeholder="ban@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              autoFocus
            />
          </div>

          <div style={{ marginBottom: isRegister ? 14 : 18 }}>
            <label style={labelStyle}>Mật khẩu</label>
            <input
              style={inputStyle}
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder={isRegister ? "Ít nhất 6 ký tự" : "Mật khẩu"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </div>

          {isRegister && (
            <div style={{ marginBottom: 18 }}>
              <label style={labelStyle}>Nhập lại mật khẩu</label>
              <input
                style={inputStyle}
                type="password"
                autoComplete="new-password"
                placeholder="Nhập lại mật khẩu"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
              />
            </div>
          )}

          {error && (
            <div
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger)",
                border: "1px solid #fecaca",
                borderRadius: "var(--radius-sm)",
                padding: "8px 12px",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          <button
            className="primary"
            type="submit"
            disabled={busy}
            style={{ width: "100%", padding: "0.6rem", fontWeight: 600 }}
          >
            {busy
              ? isRegister
                ? "Đang tạo tài khoản…"
                : "Đang đăng nhập…"
              : isRegister
                ? "Đăng ký"
                : "Đăng nhập"}
          </button>
        </form>

        {ALLOW_REGISTER && (
          <p style={{ textAlign: "center", margin: "16px 0 0", fontSize: 13, color: "var(--text-soft)" }}>
            {isRegister ? "Đã có tài khoản? " : "Chưa có tài khoản? "}
            <button
              type="button"
              onClick={() => switchMode(isRegister ? "login" : "register")}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                color: "var(--primary)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {isRegister ? "Đăng nhập" : "Đăng ký ngay"}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

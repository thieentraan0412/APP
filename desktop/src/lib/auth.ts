// Đăng nhập / đăng ký / phiên làm việc.
// Token phiên được lưu ở localStorage và gửi kèm mọi request quản lý (Authorization: Bearer).
const WORKER_URL = import.meta.env.VITE_WORKER_URL;

const TOKEN_KEY = "auth-token";
const USER_KEY = "auth-user";

export interface AuthUser {
  id: string;
  email: string;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function saveSession(token: string, user: AuthUser) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {}
}

function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {}
}

// Đọc thông báo lỗi thân thiện từ phản hồi Worker.
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {}
  return `${fallback} (HTTP ${res.status})`;
}

export async function register(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${WORKER_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Đăng ký thất bại"));
  const data = (await res.json()) as { token: string; user: AuthUser };
  saveSession(data.token, data.user);
  return data.user;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${WORKER_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Đăng nhập thất bại"));
  const data = (await res.json()) as { token: string; user: AuthUser };
  saveSession(data.token, data.user);
  return data.user;
}

export async function logout(): Promise<void> {
  const token = getToken();
  clearSession();
  if (!token) return;
  try {
    await fetch(`${WORKER_URL}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Đã xoá phiên ở máy rồi — lỗi mạng khi thu hồi trên server không quan trọng.
  }
}

// Xác thực token còn hiệu lực (gọi khi mở app). Trả về user hoặc null nếu phiên hết hạn.
export async function fetchMe(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${WORKER_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 401) clearSession(); // phiên hết hạn/không hợp lệ → đăng xuất
      return null;
    }
    const data = (await res.json()) as { user: AuthUser };
    saveSession(token, data.user);
    return data.user;
  } catch {
    // Lỗi mạng: giữ nguyên phiên đã lưu để dùng offline, dựa vào user đã lưu.
    return getStoredUser();
  }
}

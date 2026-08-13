// Cloudflare Worker — API cho app chụp ảnh / quay video
//
// Công khai (ai có link cũng xem được):
//   GET  /v/:id          trang HTML xem ảnh/video
//   GET  /file/:id       file để xem/chia sẻ (ảnh đã gộp annotate / video)
//   GET  /orig/:id       ảnh GỐC (phục vụ sửa lại annotate)
//
// Ghi / quản lý (cần header x-api-key = API_KEY):
//   POST   /api/upload           tạo mới: file (+ original + annotations) -> R2 + D1 -> { id, url }
//   GET    /api/items            liệt kê
//   GET    /api/usage            thống kê toàn bộ R2 + D1 và tốc độ tăng dữ liệu
//   GET    /api/storage          dung lượng theo từng ngày (để quản lý & dọn dữ liệu cũ)
//   GET    /api/storage/items    danh sách nội dung trong một khoảng thời gian (kèm dung lượng)
//   POST   /api/storage/sync     đối chiếu dung lượng thật trên R2 + tìm file rác
//   POST   /api/storage/purge    xoá hàng loạt theo id / khoảng thời gian / file rác
//   GET    /api/items/:id        chi tiết (kèm annotations)
//   PATCH  /api/items/:id        sửa: thay ảnh đã gộp + annotations
//   DELETE /api/items/:id        xoá: xoá file R2 + bản ghi D1

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  API_KEY: string;
}


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization",
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // phiên đăng nhập sống 30 ngày

function makeId(len = 10): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---------- Mật khẩu (PBKDF2-SHA256 qua WebCrypto) ----------
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function derivePasswordHash(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt);
  return { hash, salt: bytesToHex(salt) };
}

async function verifyPassword(password: string, saltHex: string, expectedHash: string): Promise<boolean> {
  const hash = await derivePasswordHash(password, hexToBytes(saltHex));
  // So sánh hằng-thời-gian để tránh lộ thông tin qua thời gian phản hồi
  if (hash.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return diff === 0;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  created_at: number;
}

// Tạo phiên đăng nhập mới, trả về token cho client.
async function createSession(env: Env, userId: string): Promise<string> {
  const token = makeId(32);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  )
    .bind(token, userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

// Lấy user từ session token (Authorization: Bearer <token>); null nếu không hợp lệ/hết hạn.
async function getSessionUser(req: Request, env: Env): Promise<UserRow | null> {
  const auth = req.headers.get("Authorization")?.trim();
  if (!auth || !/^Bearer\s+/i.test(auth)) return null;
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  )
    .bind(token, Date.now())
    .first<UserRow>();
  return row || null;
}

// Bảo vệ route quản lý: hợp lệ nếu có session đăng nhập HOẶC đúng API_KEY (tương thích ngược).
async function authed(req: Request, env: Env): Promise<boolean> {
  const sent = req.headers.get("x-api-key")?.trim();
  const expected = env.API_KEY?.trim();
  if (expected && sent === expected) return true;
  return (await getSessionUser(req, env)) !== null;
}

interface R2Usage {
  bytes: number;
  objectCount: number;
  imageBytes: number;
  videoBytes: number;
  originalBytes: number;
  otherBytes: number;
  listOperations: number;
}

// R2.list() chỉ trả tối đa 1.000 object mỗi trang. Lặp cursor để thống kê toàn bộ
// bucket; size có sẵn trong kết quả nên không cần HEAD từng object (tránh Class B ops).
async function getR2Usage(bucket: R2Bucket): Promise<R2Usage> {
  const usage: R2Usage = {
    bytes: 0,
    objectCount: 0,
    imageBytes: 0,
    videoBytes: 0,
    originalBytes: 0,
    otherBytes: 0,
    listOperations: 0,
  };
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ limit: 1000, cursor });
    usage.listOperations += 1;
    for (const object of page.objects) {
      usage.bytes += object.size;
      usage.objectCount += 1;
      if (object.key.endsWith("_orig.webp")) {
        usage.originalBytes += object.size;
        usage.imageBytes += object.size;
      } else if (object.key.endsWith(".mp4")) {
        usage.videoBytes += object.size;
      } else if (/\.(?:webp|png|jpe?g)$/i.test(object.key)) {
        usage.imageBytes += object.size;
      } else {
        usage.otherBytes += object.size;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return usage;
}

// ---------- Dung lượng theo thời gian ----------
// Mỗi bản ghi lưu sẵn tổng số byte đã chiếm trên R2 (cột items.bytes, ghi lúc upload),
// nhờ vậy thống kê theo ngày/tháng chỉ là truy vấn D1 — không phải quét lại R2 (Class A op).
// /api/storage/sync dùng để đối chiếu với R2 cho dữ liệu cũ (chưa có bytes) và tìm file rác.

// Cột bytes được thêm sau khi app đã chạy → tự ALTER TABLE lần đầu trong mỗi isolate
// (D1 không có cơ chế migration tự động ở đây; chạy lại nhiều lần vô hại).
let bytesColumnPromise: Promise<void> | null = null;
function ensureBytesColumn(env: Env): Promise<void> {
  if (!bytesColumnPromise) {
    bytesColumnPromise = env.DB.prepare("ALTER TABLE items ADD COLUMN bytes INTEGER")
      .run()
      .then(() => undefined)
      .catch((err) => {
        if (/duplicate column/i.test(String(err))) return; // đã có cột → xong
        bytesColumnPromise = null; // lỗi khác (mạng/D1) → cho phép thử lại
        throw err;
      });
  }
  return bytesColumnPromise;
}

// items/<id>.webp | items/<id>.mp4 | items/<id>_orig.webp  ->  <id>
function idFromKey(key: string): string | null {
  if (!key.startsWith("items/")) return null;
  let name = key.slice("items/".length);
  if (name.includes("/")) return null;
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);
  if (name.endsWith("_orig")) name = name.slice(0, -"_orig".length);
  return name || null;
}

interface R2ItemScan {
  perId: Map<string, { bytes: number; keys: string[]; uploadedAt: number }>;
  objectCount: number;
  listOperations: number;
}

// Quét toàn bộ bucket, gom object theo id nội dung (ảnh đã gộp + ảnh gốc tính chung 1 id).
async function scanR2ByItem(bucket: R2Bucket): Promise<R2ItemScan> {
  const perId = new Map<string, { bytes: number; keys: string[]; uploadedAt: number }>();
  let objectCount = 0;
  let listOperations = 0;
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ limit: 1000, cursor });
    listOperations += 1;
    for (const object of page.objects) {
      objectCount += 1;
      const id = idFromKey(object.key);
      if (!id) continue; // object ngoài items/ — không đụng tới
      const uploadedAt = object.uploaded ? object.uploaded.getTime() : 0;
      const cur = perId.get(id);
      if (cur) {
        cur.bytes += object.size;
        cur.keys.push(object.key);
        cur.uploadedAt = Math.max(cur.uploadedAt, uploadedAt);
      } else {
        perId.set(id, { bytes: object.size, keys: [object.key], uploadedAt });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { perId, objectCount, listOperations };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// R2 xoá tối đa 1.000 key mỗi lời gọi.
async function deleteR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (const part of chunk(keys, 1000)) await bucket.delete(part);
}

// D1 giới hạn số tham số bind mỗi câu lệnh → xoá theo lô nhỏ.
async function deleteItemRows(env: Env, ids: string[]): Promise<void> {
  for (const group of chunk(chunk(ids, 50), 20)) {
    await env.DB.batch(
      group.map((part) =>
        env.DB.prepare(
          `DELETE FROM items WHERE id IN (${part.map(() => "?").join(",")})`
        ).bind(...part)
      )
    );
  }
}

// Lấy File từ form (form.get trả về File | string | null)
function asFile(v: File | string | null): File | null {
  return v && typeof v !== "string" ? v : null;
}

// Phục vụ file từ R2 có hỗ trợ HTTP Range (để tua video) + HEAD.
async function serveR2(env: Env, key: string, mime: string, req: Request): Promise<Response> {
  const rangeHeader = req.headers.get("Range");
  let range: R2Range | undefined;
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const offset = parseInt(m[1], 10);
      range = m[2] ? { offset, length: parseInt(m[2], 10) - offset + 1 } : { offset };
    }
  }

  // HEAD: chỉ trả metadata (báo cho trình duyệt biết có thể tua)
  if (req.method === "HEAD") {
    const head = await env.BUCKET.head(key);
    if (!head) return new Response("Not found", { status: 404, headers: CORS });
    return new Response(null, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(head.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
        ...CORS,
      },
    });
  }

  const obj = await env.BUCKET.get(key, range ? { range } : undefined);
  if (!obj) return new Response("Not found", { status: 404, headers: CORS });

  const headers = new Headers(CORS);
  headers.set("Content-Type", mime);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000");

  if (range && obj.range) {
    const r = obj.range as { offset?: number; length?: number };
    const offset = r.offset ?? 0;
    const length = r.length ?? obj.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

interface ItemRow {
  id: string;
  type: string;
  r2_key: string;
  r2_key_orig: string | null;
  mime: string;
  annotations: string | null;
  title: string | null;
  created_at: number;
  bytes: number | null; // tổng byte trên R2 (ảnh đã gộp + ảnh gốc); NULL = chưa đối chiếu
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ---------- Đăng ký tài khoản ----------
    if (req.method === "POST" && path === "/api/auth/register") {
      let body: { email?: string; password?: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Dữ liệu không hợp lệ" }, 400);
      }
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "Email không hợp lệ" }, 400);
      }
      if (password.length < 6) {
        return json({ error: "Mật khẩu phải từ 6 ký tự trở lên" }, 400);
      }

      const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
        .bind(email)
        .first<{ id: string }>();
      if (existing) return json({ error: "Email này đã được đăng ký" }, 409);

      const userId = makeId(16);
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, password_salt, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(userId, email, hash, salt, Date.now())
        .run();

      const token = await createSession(env, userId);
      return json({ token, user: { id: userId, email } }, 201);
    }

    // ---------- Đăng nhập ----------
    if (req.method === "POST" && path === "/api/auth/login") {
      let body: { email?: string; password?: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Dữ liệu không hợp lệ" }, 400);
      }
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");

      const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
        .bind(email)
        .first<UserRow>();
      const ok = user && (await verifyPassword(password, user.password_salt, user.password_hash));
      if (!ok || !user) return json({ error: "Email hoặc mật khẩu không đúng" }, 401);

      const token = await createSession(env, user.id);
      return json({ token, user: { id: user.id, email: user.email } });
    }

    // ---------- Đăng xuất ----------
    if (req.method === "POST" && path === "/api/auth/logout") {
      const auth = req.headers.get("Authorization")?.trim();
      const token = auth?.replace(/^Bearer\s+/i, "").trim();
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
      return json({ ok: true });
    }

    // ---------- Thông tin tài khoản hiện tại ----------
    if (req.method === "GET" && path === "/api/auth/me") {
      const user = await getSessionUser(req, env);
      if (!user) return json({ error: "Chưa đăng nhập" }, 401);
      return json({ user: { id: user.id, email: user.email, createdAt: user.created_at } });
    }

    // ---------- Thống kê toàn bộ dữ liệu Cloudflare ----------
    if (req.method === "GET" && path === "/api/usage") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);

      type UsageRow = {
        total_items: number;
        image_count: number;
        video_count: number;
        items_7d: number;
        images_7d: number;
        videos_7d: number;
        items_30d: number;
        images_30d: number;
        videos_30d: number;
        oldest_item_at: number | null;
        newest_item_at: number | null;
        user_count: number;
        session_count: number;
      };

      const now = Date.now();
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      const [r2, d1Result] = await Promise.all([
        getR2Usage(env.BUCKET),
        env.DB.prepare(
          `SELECT
             COUNT(*) AS total_items,
             COALESCE(SUM(CASE WHEN type = 'image' THEN 1 ELSE 0 END), 0) AS image_count,
             COALESCE(SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END), 0) AS video_count,
             COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS items_7d,
             COALESCE(SUM(CASE WHEN created_at >= ? AND type = 'image' THEN 1 ELSE 0 END), 0) AS images_7d,
             COALESCE(SUM(CASE WHEN created_at >= ? AND type = 'video' THEN 1 ELSE 0 END), 0) AS videos_7d,
             COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS items_30d,
             COALESCE(SUM(CASE WHEN created_at >= ? AND type = 'image' THEN 1 ELSE 0 END), 0) AS images_30d,
             COALESCE(SUM(CASE WHEN created_at >= ? AND type = 'video' THEN 1 ELSE 0 END), 0) AS videos_30d,
             MIN(created_at) AS oldest_item_at,
             MAX(created_at) AS newest_item_at,
             (SELECT COUNT(*) FROM users) AS user_count,
             (SELECT COUNT(*) FROM sessions) AS session_count
           FROM items`
        )
          .bind(
            sevenDaysAgo, sevenDaysAgo, sevenDaysAgo,
            thirtyDaysAgo, thirtyDaysAgo, thirtyDaysAgo
          )
          .all<UsageRow>(),
      ]);

      const row = d1Result.results?.[0];
      if (!row) return json({ error: "Không đọc được thống kê D1" }, 500);

      return json({
        generatedAt: now,
        r2,
        d1: {
          bytes: d1Result.meta.size_after,
          rowsReadByThisRefresh: d1Result.meta.rows_read,
          totalItems: row.total_items,
          imageCount: row.image_count,
          videoCount: row.video_count,
          userCount: row.user_count,
          sessionCount: row.session_count,
          oldestItemAt: row.oldest_item_at,
          newestItemAt: row.newest_item_at,
        },
        growth: {
          last7Days: {
            items: row.items_7d,
            images: row.images_7d,
            videos: row.videos_7d,
          },
          last30Days: {
            items: row.items_30d,
            images: row.images_30d,
            videos: row.videos_30d,
          },
        },
      });
    }

    // ---------- Dung lượng theo từng ngày (nguồn cho trang Quản lý dữ liệu) ----------
    if (req.method === "GET" && path === "/api/storage") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureBytesColumn(env);

      // Lệch múi giờ của client (phút, dương = phía đông UTC) để cắt mốc ngày theo
      // giờ địa phương — nếu cắt theo UTC thì ảnh chụp tối ở VN sẽ rơi sang ngày hôm sau.
      const tzRaw = Number(url.searchParams.get("tz"));
      const tzMs = (Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, tzRaw)) : 0) * 60_000;

      type DayRow = {
        day: string;
        items: number;
        bytes: number;
        images: number;
        videos: number;
        image_bytes: number;
        video_bytes: number;
        unsized: number;
      };
      type TotalRow = {
        items: number;
        bytes: number;
        images: number;
        videos: number;
        image_bytes: number;
        video_bytes: number;
        unsized: number;
        oldest_at: number | null;
        newest_at: number | null;
      };

      const [dayRes, totalRes] = await Promise.all([
        env.DB.prepare(
          `SELECT strftime('%Y-%m-%d', (created_at + ?) / 1000, 'unixepoch') AS day,
                  COUNT(*) AS items,
                  COALESCE(SUM(bytes), 0) AS bytes,
                  COALESCE(SUM(CASE WHEN type = 'image' THEN 1 ELSE 0 END), 0) AS images,
                  COALESCE(SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END), 0) AS videos,
                  COALESCE(SUM(CASE WHEN type = 'image' THEN bytes ELSE 0 END), 0) AS image_bytes,
                  COALESCE(SUM(CASE WHEN type = 'video' THEN bytes ELSE 0 END), 0) AS video_bytes,
                  COALESCE(SUM(CASE WHEN bytes IS NULL THEN 1 ELSE 0 END), 0) AS unsized
             FROM items
            GROUP BY day
            ORDER BY day DESC`
        )
          .bind(tzMs)
          .all<DayRow>(),
        env.DB.prepare(
          `SELECT COUNT(*) AS items,
                  COALESCE(SUM(bytes), 0) AS bytes,
                  COALESCE(SUM(CASE WHEN type = 'image' THEN 1 ELSE 0 END), 0) AS images,
                  COALESCE(SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END), 0) AS videos,
                  COALESCE(SUM(CASE WHEN type = 'image' THEN bytes ELSE 0 END), 0) AS image_bytes,
                  COALESCE(SUM(CASE WHEN type = 'video' THEN bytes ELSE 0 END), 0) AS video_bytes,
                  COALESCE(SUM(CASE WHEN bytes IS NULL THEN 1 ELSE 0 END), 0) AS unsized,
                  MIN(created_at) AS oldest_at,
                  MAX(created_at) AS newest_at
             FROM items`
        ).first<TotalRow>(),
      ]);

      return json({
        generatedAt: Date.now(),
        total: {
          items: totalRes?.items ?? 0,
          bytes: totalRes?.bytes ?? 0,
          images: totalRes?.images ?? 0,
          videos: totalRes?.videos ?? 0,
          imageBytes: totalRes?.image_bytes ?? 0,
          videoBytes: totalRes?.video_bytes ?? 0,
          unsized: totalRes?.unsized ?? 0,
        },
        oldestAt: totalRes?.oldest_at ?? null,
        newestAt: totalRes?.newest_at ?? null,
        days: (dayRes.results || []).map((r) => ({
          day: r.day,
          items: r.items,
          bytes: r.bytes,
          images: r.images,
          videos: r.videos,
          imageBytes: r.image_bytes,
          videoBytes: r.video_bytes,
          unsized: r.unsized,
        })),
      });
    }

    // ---------- Nội dung trong một khoảng thời gian (kèm dung lượng) ----------
    if (req.method === "GET" && path === "/api/storage/items") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureBytesColumn(env);

      const fromRaw = Number(url.searchParams.get("from"));
      const toRaw = Number(url.searchParams.get("to"));
      const from = Number.isFinite(fromRaw) ? fromRaw : 0;
      const to = Number.isFinite(toRaw) && toRaw > 0 ? toRaw : Date.now();
      const limitRaw = Number(url.searchParams.get("limit"));
      const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 300));

      type Row = Pick<ItemRow, "id" | "type" | "title" | "created_at" | "bytes">;
      const [listRes, countRes] = await Promise.all([
        env.DB.prepare(
          `SELECT id, type, title, created_at, bytes FROM items
            WHERE created_at >= ? AND created_at <= ?
            ORDER BY bytes IS NULL, bytes DESC, created_at DESC
            LIMIT ?`
        )
          .bind(from, to, limit)
          .all<Row>(),
        env.DB.prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM items
            WHERE created_at >= ? AND created_at <= ?`
        )
          .bind(from, to)
          .first<{ n: number; bytes: number }>(),
      ]);

      const total = countRes?.n ?? 0;
      return json({
        total,
        totalBytes: countRes?.bytes ?? 0,
        truncated: total > limit,
        items: (listRes.results || []).map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          createdAt: r.created_at,
          bytes: r.bytes,
          url: `${url.origin}/v/${r.id}`,
          fileUrl: `${url.origin}/file/${r.id}`,
        })),
      });
    }

    // ---------- Đối chiếu dung lượng thật trên R2 + tìm file rác ----------
    if (req.method === "POST" && path === "/api/storage/sync") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureBytesColumn(env);

      const [dbRes, scan] = await Promise.all([
        env.DB.prepare("SELECT id, bytes FROM items").all<{ id: string; bytes: number | null }>(),
        scanR2ByItem(env.BUCKET),
      ]);
      const rows = dbRes.results || [];
      const knownIds = new Set(rows.map((r) => r.id));

      // Chỉ ghi lại những bản ghi lệch/chưa có → lần sync sau gần như không tốn write.
      const updates: { id: string; bytes: number }[] = [];
      let missingFiles = 0;
      for (const row of rows) {
        const real = scan.perId.get(row.id);
        if (!real) {
          missingFiles += 1; // bản ghi D1 còn nhưng file R2 đã mất
          continue;
        }
        if (row.bytes !== real.bytes) updates.push({ id: row.id, bytes: real.bytes });
      }
      for (const group of chunk(updates, 50)) {
        await env.DB.batch(
          group.map((u) =>
            env.DB.prepare("UPDATE items SET bytes = ? WHERE id = ?").bind(u.bytes, u.id)
          )
        );
      }

      // File rác: có trên R2 nhưng không còn bản ghi D1 (xoá hụt trước đây). Bỏ qua file
      // vừa tải lên dưới 1 giờ để không đụng vào upload đang dở giữa chừng.
      const cutoff = Date.now() - 60 * 60 * 1000;
      let orphanCount = 0;
      let orphanBytes = 0;
      for (const [id, info] of scan.perId) {
        if (knownIds.has(id) || info.uploadedAt > cutoff) continue;
        orphanCount += info.keys.length;
        orphanBytes += info.bytes;
      }

      return json({
        updated: updates.length,
        missingFiles,
        scannedObjects: scan.objectCount,
        listOperations: scan.listOperations,
        orphan: { count: orphanCount, bytes: orphanBytes },
      });
    }

    // ---------- Xoá hàng loạt: theo id / khoảng thời gian / file rác ----------
    if (req.method === "POST" && path === "/api/storage/purge") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureBytesColumn(env);

      let body: { ids?: string[]; from?: number; to?: number; orphans?: boolean };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Dữ liệu không hợp lệ" }, 400);
      }

      // Dọn file rác trên R2 (không có bản ghi D1 tương ứng)
      if (body.orphans) {
        const [dbRes, scan] = await Promise.all([
          env.DB.prepare("SELECT id FROM items").all<{ id: string }>(),
          scanR2ByItem(env.BUCKET),
        ]);
        const knownIds = new Set((dbRes.results || []).map((r) => r.id));
        const cutoff = Date.now() - 60 * 60 * 1000;
        const keys: string[] = [];
        let bytesFreed = 0;
        for (const [id, info] of scan.perId) {
          if (knownIds.has(id) || info.uploadedAt > cutoff) continue;
          keys.push(...info.keys);
          bytesFreed += info.bytes;
        }
        await deleteR2Keys(env.BUCKET, keys);
        return json({ deleted: 0, bytesFreed, orphansDeleted: keys.length, hasMore: false });
      }

      // Mỗi lượt xử lý tối đa ngần này bản ghi để không chạm giới hạn thời gian chạy của
      // Worker; client lặp lại khi hasMore = true.
      const MAX_PER_CALL = 2000;
      type DelRow = Pick<ItemRow, "id" | "r2_key" | "r2_key_orig" | "bytes">;
      let rows: DelRow[] = [];
      let hasMore = false;

      if (Array.isArray(body.ids) && body.ids.length > 0) {
        const ids = body.ids.filter((x) => typeof x === "string").slice(0, MAX_PER_CALL);
        hasMore = body.ids.length > ids.length;
        for (const part of chunk(ids, 50)) {
          const res = await env.DB.prepare(
            `SELECT id, r2_key, r2_key_orig, bytes FROM items
              WHERE id IN (${part.map(() => "?").join(",")})`
          )
            .bind(...part)
            .all<DelRow>();
          rows.push(...(res.results || []));
        }
      } else if (Number.isFinite(body.from) || Number.isFinite(body.to)) {
        const from = Number.isFinite(body.from) ? (body.from as number) : 0;
        const to = Number.isFinite(body.to) ? (body.to as number) : Date.now();
        const res = await env.DB.prepare(
          `SELECT id, r2_key, r2_key_orig, bytes FROM items
            WHERE created_at >= ? AND created_at <= ?
            ORDER BY created_at ASC LIMIT ?`
        )
          .bind(from, to, MAX_PER_CALL + 1)
          .all<DelRow>();
        rows = res.results || [];
        if (rows.length > MAX_PER_CALL) {
          rows = rows.slice(0, MAX_PER_CALL);
          hasMore = true;
        }
      } else {
        return json({ error: "Thiếu ids hoặc khoảng thời gian" }, 400);
      }

      if (rows.length === 0) return json({ deleted: 0, bytesFreed: 0, hasMore: false });

      const keys = rows.flatMap((r) => (r.r2_key_orig ? [r.r2_key, r.r2_key_orig] : [r.r2_key]));
      // Xoá file trước, rồi mới xoá bản ghi: nếu đứt giữa chừng thì bản ghi còn đó và
      // lần xoá sau vẫn dọn được, thay vì để lại file rác không ai biết.
      await deleteR2Keys(env.BUCKET, keys);
      await deleteItemRows(env, rows.map((r) => r.id));

      return json({
        deleted: rows.length,
        bytesFreed: rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
        hasMore,
      });
    }

    // ---------- Tạo mới ----------
    if (req.method === "POST" && path === "/api/upload") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      try {
        await ensureBytesColumn(env);
        const form = await req.formData();
        const file = asFile(form.get("file"));
        const type = String(form.get("type") || "image");
        const annotations = form.get("annotations")?.toString() ?? null;
        const title = form.get("title")?.toString()?.trim() || null;
        const original = asFile(form.get("original"));

        if (!file) return json({ error: "Thiếu file" }, 400);

        const id = makeId();
        // Ảnh app xuất ra luôn là WebP (flattenStage) → lưu đúng mime/ext để link chia sẻ
        // hiển thị được trên web (trước đây gắn nhãn image/png cho byte WebP → ảnh vỡ).
        const ext = type === "video" ? "mp4" : "webp";
        const mime = type === "video" ? "video/mp4" : "image/webp";
        const key = `items/${id}.${ext}`;

        await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: mime } });

        // Lưu thêm ảnh gốc (để sửa lại annotate) nếu có — cũng là WebP.
        let origKey: string | null = null;
        let bytes = file.size;
        if (type === "image" && original) {
          origKey = `items/${id}_orig.webp`;
          await env.BUCKET.put(origKey, original.stream(), {
            httpMetadata: { contentType: "image/webp" },
          });
          bytes += original.size;
        }

        await env.DB.prepare(
          `INSERT INTO items (id, type, r2_key, r2_key_orig, mime, annotations, title, created_at, bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(id, type, key, origKey, mime, annotations, title, Date.now(), bytes)
          .run();

        return json({ id, url: `${url.origin}/v/${id}` });
      } catch (err) {
        return json({ error: "Upload thất bại", detail: String(err) }, 500);
      }
    }

    // ---------- Quản lý: liệt kê ----------
    if (req.method === "GET" && path === "/api/items") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT id, type, annotations, title, created_at FROM items ORDER BY created_at DESC LIMIT 200`
      ).all<Pick<ItemRow, "id" | "type" | "annotations" | "title" | "created_at">>();
      const items = (results || []).map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        createdAt: r.created_at,
        url: `${url.origin}/v/${r.id}`,
        fileUrl: `${url.origin}/file/${r.id}`,
        hasAnnotations: !!r.annotations,
      }));
      return json({ items });
    }

    // ---------- Quản lý: chi tiết / sửa / xoá ----------
    const mItem = path.match(/^\/api\/items\/([^/]+)$/);
    if (mItem) {
      const id = mItem[1];
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);

      const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?")
        .bind(id)
        .first<ItemRow>();
      if (!row) return json({ error: "Không tìm thấy" }, 404);

      if (req.method === "GET") {
        return json({
          id: row.id,
          type: row.type,
          title: row.title,
          createdAt: row.created_at,
          annotations: row.annotations ? JSON.parse(row.annotations) : null,
          hasOriginal: !!row.r2_key_orig,
          originalUrl: row.r2_key_orig ? `${url.origin}/orig/${id}` : null,
          url: `${url.origin}/v/${id}`,
        });
      }

      if (req.method === "DELETE") {
        await env.BUCKET.delete(row.r2_key);
        if (row.r2_key_orig) await env.BUCKET.delete(row.r2_key_orig);
        await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (req.method === "PATCH") {
        await ensureBytesColumn(env);
        const form = await req.formData();
        const file = asFile(form.get("file"));
        // Thay ảnh đã gộp (giữ nguyên key) nếu gửi file mới
        const sets: string[] = [];
        const binds: (string | number | null)[] = [];
        if (file) {
          await env.BUCKET.put(row.r2_key, file.stream(), {
            httpMetadata: { contentType: row.mime },
          });
          // Ảnh gộp mới có kích thước khác → cập nhật lại dung lượng của mục. Ảnh gốc
          // không đổi nên chỉ cần hỏi kích thước của nó (1 Class B op cho mỗi lần sửa).
          const origSize = row.r2_key_orig ? (await env.BUCKET.head(row.r2_key_orig))?.size ?? 0 : 0;
          sets.push("bytes = ?");
          binds.push(file.size + origSize);
        }
        // Chỉ cập nhật cột nào được gửi (tránh xoá nhầm)
        if (form.has("annotations")) {
          sets.push("annotations = ?");
          binds.push(form.get("annotations")?.toString() ?? null);
        }
        if (form.has("title")) {
          sets.push("title = ?");
          binds.push(form.get("title")?.toString()?.trim() || null);
        }
        if (sets.length) {
          binds.push(id);
          await env.DB.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`)
            .bind(...binds)
            .run();
        }
        return json({ ok: true, url: `${url.origin}/v/${id}` });
      }
    }

    // ---------- Công khai: file đã gộp (hỗ trợ tua video) ----------
    if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/file/")) {
      const id = path.slice("/file/".length);
      const row = await env.DB.prepare("SELECT r2_key, mime FROM items WHERE id = ?")
        .bind(id)
        .first<Pick<ItemRow, "r2_key" | "mime">>();
      if (!row) return new Response("Not found", { status: 404, headers: CORS });
      // File ảnh trong hệ thống LUÔN là WebP → ép image/webp kể cả item cũ lưu nhãn
      // image/png (sửa lỗi link ảnh vỡ trên web). Video giữ nguyên mime đã lưu.
      const serveMime = row.mime.startsWith("image/") ? "image/webp" : row.mime;
      return serveR2(env, row.r2_key, serveMime, req);
    }

    // ---------- Công khai: ảnh gốc (để sửa) ----------
    if (req.method === "GET" && path.startsWith("/orig/")) {
      const id = path.slice("/orig/".length);
      const row = await env.DB.prepare("SELECT r2_key_orig FROM items WHERE id = ?")
        .bind(id)
        .first<Pick<ItemRow, "r2_key_orig">>();
      if (!row || !row.r2_key_orig) return new Response("Not found", { status: 404, headers: CORS });
      const obj = await env.BUCKET.get(row.r2_key_orig);
      if (!obj) return new Response("Not found", { status: 404, headers: CORS });
      // Ảnh gốc: item cũ là PNG, item mới là WebP → nhận diện qua magic bytes để gắn
      // đúng Content-Type (đọc cả object vào RAM — ảnh gốc nhỏ nên không sao).
      const buf = await obj.arrayBuffer();
      const b = new Uint8Array(buf.slice(0, 12));
      const isWebp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
                     b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
      return new Response(buf, {
        headers: { "Content-Type": isWebp ? "image/webp" : "image/png", "Cache-Control": "public, max-age=31536000", ...CORS },
      });
    }

    // ---------- Công khai: trang xem ----------
    if (req.method === "GET" && path.startsWith("/v/")) {
      const id = path.slice("/v/".length);
      const row = await env.DB.prepare("SELECT type, title, r2_key FROM items WHERE id = ?")
        .bind(id)
        .first<Pick<ItemRow, "type" | "title" | "r2_key">>();
      if (!row) return new Response("Not found", { status: 404 });

      // Version token = thời điểm file được ghi vào R2. Khi sửa ảnh, file bị ghi đè
      // nên token đổi → URL ảnh đổi → phá cache của trình duyệt/CDN (ảnh cũ đã đặt
      // Cache-Control 1 năm). Ảnh chưa sửa vẫn dùng cache như cũ, không tốn thêm.
      const head = await env.BUCKET.head(row.r2_key);
      const ver = head?.uploaded ? head.uploaded.getTime() : "";
      const fileSrc = `/file/${id}${ver ? `?v=${ver}` : ""}`;

      // Thoát HTML cho tiêu đề
      const esc = (s: string) =>
        s.replace(/[&<>"']/g, (c) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
        );
      const title = row.title ? esc(row.title) : "";
      const heading = title
        ? `<h1 style="color:#fff;font:600 18px system-ui;margin:16px 0 10px">${title}</h1>`
        : "";

      const media =
        row.type === "video"
          ? `<video id="vid" src="${fileSrc}" controls autoplay muted playsinline style="max-width:100%;max-height:78vh"></video>
<div class="skip">
  <button onclick="seek(-10)">⏪ 10s</button>
  <button onclick="seek(-5)">◀ 5s</button>
  <button onclick="seek(5)">5s ▶</button>
  <button onclick="seek(10)">10s ⏩</button>
</div>
<script>
function seek(d){var v=document.getElementById('vid');if(!v)return;var t=v.currentTime+d;v.currentTime=Math.max(0,Math.min(v.duration||1e9,t));}
document.addEventListener('keydown',function(e){if(e.key==='ArrowLeft')seek(-5);else if(e.key==='ArrowRight')seek(5);else if(e.key==='j')seek(-10);else if(e.key==='l')seek(10);});
</script>`
          : `<img src="${fileSrc}" style="max-width:100%;max-height:90vh"/>`;

      const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title || id}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#111;font-family:system-ui,sans-serif}
  .skip{display:flex;gap:8px;margin-top:12px}
  .skip button{cursor:pointer;background:#1f2937;color:#fff;border:1px solid #374151;border-radius:8px;padding:8px 14px;font-size:14px}
  .skip button:hover{background:#374151}
</style></head>
<body>
${heading}${media}
</body></html>`;
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // Không cache trang HTML → luôn nhúng version token mới nhất của ảnh sau khi sửa
          "Cache-Control": "no-cache, must-revalidate",
        },
      });
    }

    if (req.method === "GET" && path === "/") {
      return new Response("captures-api OK", { headers: CORS });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

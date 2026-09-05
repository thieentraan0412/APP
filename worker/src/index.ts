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
//   GET    /api/search           tìm theo tiêu đề (cả mục còn sống lẫn đã lưu về máy)
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
  // 256 không chia hết cho 62, nên lấy thẳng `byte % 62` làm 8 ký tự đầu bảng ra nhiều hơn
  // ~25% — id bớt ngẫu nhiên, xác suất trùng nhích lên. Bỏ các byte rơi vào phần dư
  // (>= 248) để mọi ký tự có cơ hội bằng nhau. Bảng ký tự giữ nguyên nên id cũ vẫn hợp lệ.
  const limit = 256 - (256 % chars.length);
  let out = "";
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len))) {
      if (b >= limit) continue; // byte lệch — bốc lại, không dùng
      out += chars[b % chars.length];
      if (out.length === len) break;
    }
  }
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

// Bảng sổ kho tạo muộn hơn bảng items, nên database đã dùng từ trước sẽ chưa có. Tạo một
// lần cho mỗi isolate rồi nhớ lại, giống cách ensureBytesColumn làm.
let archiveTablesPromise: Promise<void> | null = null;
function ensureArchiveTables(env: Env): Promise<void> {
  if (!archiveTablesPromise) {
    archiveTablesPromise = env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS archive_stores (
           id TEXT PRIMARY KEY, device TEXT NOT NULL, dir TEXT NOT NULL,
           items INTEGER NOT NULL, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL,
           UNIQUE (device, dir))`
      ),
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS archive_items (
           item_id TEXT NOT NULL, store_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT,
           bytes INTEGER, created_at INTEGER, archived_at INTEGER, file TEXT,
           PRIMARY KEY (item_id, store_id))`
      ),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_archive_items_store ON archive_items(store_id)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_archive_items_item ON archive_items(item_id)`),
    ])
      .then(() => undefined)
      .catch((err) => {
        archiveTablesPromise = null; // cho phép thử lại ở request sau
        throw err;
      });
  }
  return archiveTablesPromise;
}

// ---------- Sổ đếm hạn mức theo ngày ----------
// Cloudflare không cho worker tự đọc mức đã tiêu của chính nó, nên muốn biết hôm nay đã
// dùng bao nhiêu thì phải tự đếm. Mỗi request cộng đúng một dòng UPSERT vào ngày hôm đó.
//
// Mốc ngày theo UTC vì hạn mức ngày của Cloudflare cũng reset lúc 00:00 UTC — cắt theo giờ
// VN sẽ lệch 7 tiếng và báo "còn dư" trong khi thực tế đã hết.
interface Meter {
  requests: number;
  classA: number;
  classB: number;
  rowsWritten: number;
}

let usageTablePromise: Promise<void> | null = null;
function ensureUsageTable(env: Env): Promise<void> {
  if (!usageTablePromise) {
    usageTablePromise = env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS usage_daily (
         day TEXT PRIMARY KEY,
         requests INTEGER NOT NULL DEFAULT 0,
         class_a INTEGER NOT NULL DEFAULT 0,
         class_b INTEGER NOT NULL DEFAULT 0,
         rows_written INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL)`
    )
      .run()
      .then(() => undefined)
      .catch((err) => {
        usageTablePromise = null;
        throw err;
      });
  }
  return usageTablePromise;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function flushMeter(env: Env, m: Meter): Promise<void> {
  // Chính câu UPSERT này cũng là một row written — cộng luôn vào, không giấu.
  const rowsWritten = m.rowsWritten + 1;
  await ensureUsageTable(env);
  await env.DB.prepare(
    `INSERT INTO usage_daily (day, requests, class_a, class_b, rows_written, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       requests     = requests + excluded.requests,
       class_a      = class_a + excluded.class_a,
       class_b      = class_b + excluded.class_b,
       rows_written = rows_written + excluded.rows_written,
       updated_at   = excluded.updated_at`
  )
    .bind(utcDay(Date.now()), m.requests, m.classA, m.classB, rowsWritten, Date.now())
    .run();
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
async function serveR2(env: Env, key: string, mime: string, req: Request, meter: Meter): Promise<Response> {
  // head và get đều là Class B. Video tải theo nhiều đoạn Range → mỗi đoạn vào đây một lần
  // và tính thêm một Class B, nên bộ đếm này mới phản ánh đúng chi phí thật của video.
  meter.classB += 1;
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

const routes = {
  async handle(req: Request, env: Env, meter: Meter): Promise<Response> {
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
        getR2Usage(env.BUCKET).then((u) => {
          meter.classA += u.listOperations; // ListObjects là Class A
          return u;
        }),
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

    // ---------- Mức đã tiêu theo ngày (sổ do worker tự đếm) ----------
    if (req.method === "GET" && path === "/api/usage/daily") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureUsageTable(env);

      const daysRaw = Number(url.searchParams.get("days"));
      const days = Math.max(1, Math.min(90, Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 30));
      const from = utcDay(Date.now() - (days - 1) * 86_400_000);

      type Row = {
        day: string; requests: number; class_a: number; class_b: number;
        rows_written: number; updated_at: number;
      };
      const { results } = await env.DB.prepare(
        `SELECT day, requests, class_a, class_b, rows_written, updated_at
           FROM usage_daily WHERE day >= ? ORDER BY day DESC`
      ).bind(from).all<Row>();

      return json({
        today: utcDay(Date.now()),
        // Mốc ngày theo UTC, khớp với lúc Cloudflare reset hạn mức ngày.
        timezone: "UTC",
        days: (results || []).map((r) => ({
          day: r.day,
          requests: r.requests,
          classA: r.class_a,
          classB: r.class_b,
          rowsWritten: r.rows_written,
          updatedAt: r.updated_at,
        })),
      });
    }

    // ---------- Sổ kho lưu trữ dưới máy ----------
    // Danh sách mọi kho của mọi máy, kèm các mục bên trong. Nhờ nó mà đứng ở máy B vẫn
    // biết video đã xoá đang nằm ở máy A, thư mục nào.
    if (req.method === "GET" && path === "/api/archives") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureArchiveTables(env);

      type StoreRow = { id: string; device: string; dir: string; items: number; bytes: number; updated_at: number };
      const stores = await env.DB.prepare(
        `SELECT id, device, dir, items, bytes, updated_at FROM archive_stores
          ORDER BY updated_at DESC`
      ).all<StoreRow>();

      return json({
        stores: (stores.results || []).map((s) => ({
          id: s.id,
          device: s.device,
          dir: s.dir,
          items: s.items,
          bytes: s.bytes,
          updatedAt: s.updated_at,
        })),
      });
    }

    // Các mục bên trong một kho, hoặc tra ngược một mục đang nằm ở những kho nào.
    if (req.method === "GET" && path === "/api/archives/items") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureArchiveTables(env);

      const storeId = url.searchParams.get("store");
      const itemId = url.searchParams.get("item");
      if (!storeId && !itemId) return json({ error: "Thiếu store hoặc item" }, 400);

      type Row = {
        item_id: string; store_id: string; type: string; title: string | null;
        bytes: number | null; created_at: number | null; archived_at: number | null;
        file: string | null; device: string; dir: string;
      };
      const stmt = storeId
        ? env.DB.prepare(
            `SELECT ai.*, s.device, s.dir FROM archive_items ai
               JOIN archive_stores s ON s.id = ai.store_id
              WHERE ai.store_id = ? ORDER BY ai.bytes DESC LIMIT 1000`
          ).bind(storeId)
        : env.DB.prepare(
            `SELECT ai.*, s.device, s.dir FROM archive_items ai
               JOIN archive_stores s ON s.id = ai.store_id
              WHERE ai.item_id = ?`
          ).bind(itemId);

      const { results } = await stmt.all<Row>();
      return json({
        items: (results || []).map((r) => ({
          itemId: r.item_id,
          storeId: r.store_id,
          device: r.device,
          dir: r.dir,
          type: r.type,
          title: r.title,
          bytes: r.bytes,
          createdAt: r.created_at,
          archivedAt: r.archived_at,
          file: r.file,
        })),
      });
    }


    // ---------- Tra theo tiêu đề ----------
    // Tìm cả mục còn sống (bảng items) lẫn mục đã xoá nhưng còn bản sao dưới máy (sổ kho),
    // rồi gộp theo id để mỗi mục chỉ hiện một lần — trả về đúng khuôn kết quả tra theo id.
    if (req.method === "GET" && path === "/api/search") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureBytesColumn(env);
      await ensureArchiveTables(env);

      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({ error: "Cần ít nhất 2 ký tự để tìm" }, 400);
      const limitRaw = Number(url.searchParams.get("limit"));
      const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50));
      // % và _ trong chuỗi người dùng gõ phải hiểu là ký tự thường, không phải ký tự đại diện.
      const like = `%${q.replace(/[!%_]/g, (c) => "!" + c)}%`;

      type LiveRow = { id: string; type: string; title: string | null; created_at: number; bytes: number | null };
      type CopyRow = {
        item_id: string; store_id: string; type: string; title: string | null;
        bytes: number | null; created_at: number | null; archived_at: number | null;
        file: string | null; device: string; dir: string;
      };
      const [liveRes, copyRes] = await Promise.all([
        env.DB.prepare(
          `SELECT id, type, title, created_at, bytes FROM items
            WHERE title LIKE ? ESCAPE '!'
            ORDER BY created_at DESC LIMIT ?`
        )
          .bind(like, limit + 1) // lấy dư 1 để biết có bị cắt bớt hay không
          .all<LiveRow>(),
        env.DB.prepare(
          `SELECT ai.*, s.device, s.dir FROM archive_items ai
             JOIN archive_stores s ON s.id = ai.store_id
            WHERE ai.title LIKE ? ESCAPE '!'
            ORDER BY ai.created_at DESC LIMIT ?`
        )
          .bind(like, limit * 4) // một mục có thể nằm ở nhiều kho → lấy dư rồi mới gộp
          .all<CopyRow>(),
      ]);

      const found = new Map<
        string,
        { id: string; createdAt: number; live: unknown | null; copies: unknown[] }
      >();
      for (const r of liveRes.results || []) {
        found.set(r.id, {
          id: r.id,
          createdAt: r.created_at,
          live: {
            id: r.id,
            type: r.type,
            title: r.title,
            createdAt: r.created_at,
            bytes: r.bytes,
            url: `${url.origin}/v/${r.id}`,
          },
          copies: [],
        });
      }
      for (const r of copyRes.results || []) {
        let hit = found.get(r.item_id);
        if (!hit) {
          hit = { id: r.item_id, createdAt: r.created_at ?? 0, live: null, copies: [] };
          found.set(r.item_id, hit);
        }
        hit.copies.push({
          itemId: r.item_id,
          storeId: r.store_id,
          device: r.device,
          dir: r.dir,
          type: r.type,
          title: r.title,
          bytes: r.bytes,
          createdAt: r.created_at,
          archivedAt: r.archived_at,
          file: r.file,
        });
      }

      const results = [...found.values()].sort((a, b) => b.createdAt - a.createdAt);
      return json({
        q,
        truncated: results.length > limit,
        results: results.slice(0, limit).map(({ id, live, copies }) => ({ id, live, copies })),
      });
    }

    // Ghi nhận (hoặc cập nhật) một kho. App gọi sau mỗi lần lưu về máy.
    if (req.method === "POST" && path === "/api/archives") {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureArchiveTables(env);

      type Incoming = {
        device?: string;
        dir?: string;
        items?: Array<{
          id?: string; type?: string; title?: string | null; bytes?: number | null;
          createdAt?: number | null; archivedAt?: number | null; file?: string | null;
        }>;
      };
      const body = (await req.json().catch(() => null)) as Incoming | null;
      const device = body?.device?.trim();
      const dir = body?.dir?.trim();
      if (!device || !dir) return json({ error: "Thiếu tên máy hoặc đường dẫn" }, 400);

      const list = Array.isArray(body?.items) ? body!.items! : [];
      const bytes = list.reduce((s, it) => s + (it.bytes ?? 0), 0);

      // Kho đã có thì giữ nguyên id để các dòng archive_items cũ không mồ côi.
      const existing = await env.DB.prepare(
        `SELECT id FROM archive_stores WHERE device = ? AND dir = ?`
      ).bind(device, dir).first<{ id: string }>();
      const storeId = existing?.id ?? makeId(12);

      await env.DB.prepare(
        `INSERT INTO archive_stores (id, device, dir, items, bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device, dir) DO UPDATE SET
           items = excluded.items, bytes = excluded.bytes, updated_at = excluded.updated_at`
      ).bind(storeId, device, dir, list.length, bytes, Date.now()).run();

      // Manifest dưới máy là nguồn sự thật: thay sạch danh sách cũ của kho này thay vì
      // chèn thêm, để mục người dùng đã xoá khỏi thư mục không còn nằm lại trong sổ.
      await env.DB.prepare(`DELETE FROM archive_items WHERE store_id = ?`).bind(storeId).run();

      // D1 giới hạn số câu lệnh mỗi batch, chia lô cho kho vài trăm mục.
      const rows = list.filter((it) => typeof it.id === "string" && it.id);
      for (let i = 0; i < rows.length; i += 50) {
        await env.DB.batch(
          rows.slice(i, i + 50).map((it) =>
            env.DB.prepare(
              `INSERT INTO archive_items (item_id, store_id, type, title, bytes, created_at, archived_at, file)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(item_id, store_id) DO NOTHING`
            ).bind(
              it.id, storeId, it.type === "video" ? "video" : "image",
              it.title ?? null, it.bytes ?? null, it.createdAt ?? null,
              it.archivedAt ?? null, it.file ?? null
            )
          )
        );
      }

      return json({ id: storeId, items: rows.length, bytes });
    }

    // Bỏ một kho khỏi sổ. Chỉ xoá bản ghi — file dưới máy không đụng tới.
    if (req.method === "DELETE" && path.startsWith("/api/archives/")) {
      if (!(await authed(req, env))) return json({ error: "Không có quyền" }, 401);
      await ensureArchiveTables(env);

      const id = path.slice("/api/archives/".length);
      if (!id) return json({ error: "Thiếu id" }, 400);
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM archive_items WHERE store_id = ?`).bind(id),
        env.DB.prepare(`DELETE FROM archive_stores WHERE id = ?`).bind(id),
      ]);
      return json({ ok: true });
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
        // Khôi phục từ kho dưới máy gửi kèm thời điểm tạo GỐC để mục về đúng mốc thời gian
        // cũ. Chỉ nhận giá trị hợp lệ (dương, không ở tương lai) — còn lại coi như tạo mới.
        const createdAtRaw = Number(form.get("createdAt"));
        const createdAt =
          Number.isFinite(createdAtRaw) && createdAtRaw > 0 && createdAtRaw <= Date.now() + 60_000
            ? Math.round(createdAtRaw)
            : Date.now();

        if (!file) return json({ error: "Thiếu file" }, 400);

        // Ảnh app xuất ra luôn là WebP (flattenStage) → lưu đúng mime/ext để link chia sẻ
        // hiển thị được trên web (trước đây gắn nhãn image/png cho byte WebP → ảnh vỡ).
        const ext = type === "video" ? "mp4" : "webp";
        const mime = type === "video" ? "video/mp4" : "image/webp";
        // Ảnh gốc (để sửa lại annotate) chỉ có với ảnh; video không bao giờ kèm.
        const origFile = type === "image" ? original : null;
        const bytes = file.size + (origFile ? origFile.size : 0);

        // Khôi phục từ kho dưới máy xin lại ĐÚNG id cũ để link chia sẻ cũ sống lại.
        // Chỉ nhận id đúng khuôn makeId(): id ghép thẳng vào key R2 nên ký tự lạ (dấu /,
        // "..") có thể trỏ ra ngoài thư mục items/ và giẫm lên file khác.
        const wantedRaw = form.get("id")?.toString() ?? "";
        const wanted = /^[0-9A-Za-z]{10}$/.test(wantedRaw) ? wantedRaw : null;

        // Giữ chỗ id trong D1 TRƯỚC khi ghi R2 — đây là chốt chống trùng. id đã có chủ thì
        // ON CONFLICT DO NOTHING không đổi dòng nào (changes = 0) và ta chưa hề đụng vào
        // file của họ. Làm ngược lại (ghi R2 trước) sẽ ghi đè im lặng nội dung mục cũ:
        // link cũ vẫn mở được nhưng ra nội dung khác, hỏng dữ liệu mà không ai hay.
        const reserve = (candidate: string) =>
          env.DB.prepare(
            `INSERT INTO items (id, type, r2_key, r2_key_orig, mime, annotations, title, created_at, bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`
          )
            .bind(
              candidate,
              type,
              `items/${candidate}.${ext}`,
              origFile ? `items/${candidate}_orig.webp` : null,
              mime,
              annotations,
              title,
              createdAt,
              bytes
            )
            .run();

        let id = "";
        let keptId = false;
        if (wanted && (await reserve(wanted)).meta.changes === 1) {
          id = wanted;
          keptId = true;
        } else {
          // Không xin id cũ, hoặc id cũ đã có chủ → bốc id mới. Vài lượt là quá đủ:
          // 62^10 tổ hợp nên trùng ngẫu nhiên gần như không xảy ra.
          for (let i = 0; i < 5 && !id; i++) {
            const candidate = makeId();
            if ((await reserve(candidate)).meta.changes === 1) id = candidate;
          }
          if (!id) return json({ error: "Không cấp được id, thử lại" }, 503);
        }

        const key = `items/${id}.${ext}`;
        const origKey = origFile ? `items/${id}_orig.webp` : null;
        meter.rowsWritten += 1; // dòng vừa giữ chỗ ở trên
        try {
          await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: mime } });
          meter.classA += 1;
          if (origFile && origKey) {
            await env.BUCKET.put(origKey, origFile.stream(), {
              httpMetadata: { contentType: "image/webp" },
            });
            meter.classA += 1;
          }
        } catch (err) {
          // Ghi file hỏng giữa chừng: trả lại id vừa giữ chỗ và dọn phần đã kịp ghi, kẻo
          // để lại dòng trỏ vào file không tồn tại + file rác chiếm dung lượng.
          await env.DB.prepare(`DELETE FROM items WHERE id = ?`).bind(id).run();
          await env.BUCKET.delete(origKey ? [key, origKey] : [key]).catch(() => {});
          throw err;
        }

        return json({ id, url: `${url.origin}/v/${id}`, keptId });
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
      return serveR2(env, row.r2_key, serveMime, req, meter);
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
          : `<img id="pic" src="${fileSrc}" title="Bấm để xem kích thước thật"/>
<p class="hint">Bấm vào ảnh để xem đúng kích thước thật · bấm lần nữa để thu vừa màn hình</p>
<script>
document.getElementById('pic').addEventListener('click',function(){document.body.classList.toggle('full');});
</script>`;

      const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title || id}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#111;font-family:system-ui,sans-serif}
  .skip{display:flex;gap:8px;margin-top:12px}
  .skip button{cursor:pointer;background:#1f2937;color:#fff;border:1px solid #374151;border-radius:8px;padding:8px 14px;font-size:14px}
  .skip button:hover{background:#374151}
  #pic{max-width:100%;max-height:90vh;cursor:zoom-in}
  .hint{color:#9ca3af;font-size:12px;margin:10px 0 0}
  /* 1:1 — canh về góc trên-trái để cuộn tới được mọi mép; canh giữa thì phần tràn bên trái bị cắt */
  body.full{justify-content:flex-start;align-items:flex-start}
  body.full h1,body.full .hint{margin-left:16px}
  body.full #pic{max-width:none;max-height:none;cursor:zoom-out}
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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Đếm ngay từ đầu, kể cả OPTIONS lẫn 404 — Cloudflare cũng tính những lượt đó.
    const meter: Meter = { requests: 1, classA: 0, classB: 0, rowsWritten: 0 };
    try {
      return await routes.handle(req, env, meter);
    } finally {
      // waitUntil: ghi sổ SAU khi response đã đi, người dùng không phải chờ thêm. Ghi hỏng
      // thì nuốt lỗi — sổ đếm sai vài lượt còn hơn làm hỏng một request thật.
      ctx.waitUntil(flushMeter(env, meter).catch(() => {}));
    }
  },
};

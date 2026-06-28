// Cloudflare Worker — API cho app chụp ảnh / quay video
//
// Công khai (ai có link cũng xem được):
//   GET  /v/:id          trang HTML xem ảnh/video
//   GET  /file/:id       file để xem/chia sẻ (ảnh đã gộp annotate / video)
//   GET  /orig/:id       ảnh GỐC (phục vụ sửa lại annotate)
//   POST /api/upload     tạo mới: file (+ original + annotations) -> R2 + D1 -> { id, url }
//
// Quản lý (cần header x-api-key = API_KEY):
//   GET    /api/items        liệt kê
//   GET    /api/items/:id    chi tiết (kèm annotations)
//   PATCH  /api/items/:id    sửa: thay ảnh đã gộp + annotations
//   DELETE /api/items/:id    xoá: xoá file R2 + bản ghi D1

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  API_KEY: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
};

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

// Bảo vệ route quản lý (trim để tránh lệch do khoảng trắng/xuống dòng)
function authed(req: Request, env: Env): boolean {
  const sent = req.headers.get("x-api-key")?.trim();
  const expected = env.API_KEY?.trim();
  return !!expected && sent === expected;
}

// Lấy File từ form (form.get trả về File | string | null)
function asFile(v: File | string | null): File | null {
  return v && typeof v !== "string" ? v : null;
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
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ---------- Tạo mới ----------
    if (req.method === "POST" && path === "/api/upload") {
      try {
        const form = await req.formData();
        const file = asFile(form.get("file"));
        const type = String(form.get("type") || "image");
        const annotations = form.get("annotations")?.toString() ?? null;
        const title = form.get("title")?.toString()?.trim() || null;
        const original = asFile(form.get("original"));

        if (!file) return json({ error: "Thiếu file" }, 400);

        const id = makeId();
        const ext = type === "video" ? "mp4" : "png";
        const mime = type === "video" ? "video/mp4" : "image/png";
        const key = `items/${id}.${ext}`;

        await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: mime } });

        // Lưu thêm ảnh gốc (để sửa lại annotate) nếu có
        let origKey: string | null = null;
        if (type === "image" && original) {
          origKey = `items/${id}_orig.png`;
          await env.BUCKET.put(origKey, original.stream(), {
            httpMetadata: { contentType: "image/png" },
          });
        }

        await env.DB.prepare(
          `INSERT INTO items (id, type, r2_key, r2_key_orig, mime, annotations, title, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(id, type, key, origKey, mime, annotations, title, Date.now())
          .run();

        return json({ id, url: `${url.origin}/v/${id}` });
      } catch (err) {
        return json({ error: "Upload thất bại", detail: String(err) }, 500);
      }
    }

    // ---------- Quản lý: liệt kê ----------
    if (req.method === "GET" && path === "/api/items") {
      if (!authed(req, env)) return json({ error: "Không có quyền" }, 401);
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
      if (!authed(req, env)) return json({ error: "Không có quyền" }, 401);

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
        const form = await req.formData();
        const file = asFile(form.get("file"));
        // Thay ảnh đã gộp (giữ nguyên key) nếu gửi file mới
        if (file) {
          await env.BUCKET.put(row.r2_key, file.stream(), {
            httpMetadata: { contentType: row.mime },
          });
        }
        // Chỉ cập nhật cột nào được gửi (tránh xoá nhầm)
        const sets: string[] = [];
        const binds: (string | null)[] = [];
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

    // ---------- Công khai: file đã gộp ----------
    if (req.method === "GET" && path.startsWith("/file/")) {
      const id = path.slice("/file/".length);
      const row = await env.DB.prepare("SELECT r2_key, mime FROM items WHERE id = ?")
        .bind(id)
        .first<Pick<ItemRow, "r2_key" | "mime">>();
      if (!row) return new Response("Not found", { status: 404, headers: CORS });
      const obj = await env.BUCKET.get(row.r2_key);
      if (!obj) return new Response("Not found", { status: 404, headers: CORS });
      return new Response(obj.body, {
        headers: { "Content-Type": row.mime, "Cache-Control": "public, max-age=31536000", ...CORS },
      });
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
      return new Response(obj.body, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000", ...CORS },
      });
    }

    // ---------- Công khai: trang xem ----------
    if (req.method === "GET" && path.startsWith("/v/")) {
      const id = path.slice("/v/".length);
      const row = await env.DB.prepare("SELECT type, title FROM items WHERE id = ?")
        .bind(id)
        .first<Pick<ItemRow, "type" | "title">>();
      if (!row) return new Response("Not found", { status: 404 });
      const media =
        row.type === "video"
          ? `<video src="/file/${id}" controls autoplay muted style="max-width:100%;max-height:90vh"></video>`
          : `<img src="/file/${id}" style="max-width:100%;max-height:90vh"/>`;
      // Thoát HTML cho tiêu đề
      const esc = (s: string) =>
        s.replace(/[&<>"']/g, (c) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
        );
      const title = row.title ? esc(row.title) : "";
      const heading = title
        ? `<h1 style="color:#fff;font:600 18px system-ui;margin:16px 0 8px">${title}</h1>`
        : "";
      const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title || id}</title></head>
<body style="margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#111">
${heading}${media}
</body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (req.method === "GET" && path === "/") {
      return new Response("captures-api OK", { headers: CORS });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};

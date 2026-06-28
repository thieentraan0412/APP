# Kế hoạch thực hiện chi tiết

> Dựa trên [begin.md](begin.md). Stack MVP: **Tauri + React + Konva** → **Cloudflare Workers** → **R2** + **D1**, link công khai, người dùng ẩn danh.

---

## 1. Mô hình kiến trúc tổng thể

```
┌──────────────────────────────────────────────┐
│              DESKTOP APP (Tauri)             │
│                                              │
│   ┌───────────────┐      ┌────────────────┐  │
│   │  Rust (core)  │      │  React (UI)    │  │
│   │  - global     │─────▶│  - màn hình    │  │
│   │    hotkey     │ emit │    chỉnh sửa   │  │
│   │  - chụp màn   │ event│    (Konva)     │  │
│   │    hình (PNG) │      │  - upload      │  │
│   │  - quay video │      │  - hiện link   │  │
│   │    (ffmpeg)   │      └───────┬────────┘  │
│   │  - system tray│              │           │
│   └───────────────┘              │ HTTPS     │
└──────────────────────────────────┼───────────┘
                                   │
                          POST /api/upload
                                   │
                                   ▼
┌──────────────────────────────────────────────┐
│           CLOUDFLARE WORKER (API)            │
│   - nhận file + annotate                      │
│   - PUT file vào R2                           │
│   - ghi metadata vào D1                       │
│   - trả về { id, url }                        │
│   - GET /v/:id  → trang xem                    │
│   - GET /file/:id → stream file từ R2          │
└───────────┬───────────────────┬───────────────┘
            │                   │
            ▼                   ▼
   ┌────────────────┐   ┌────────────────┐
   │   R2 (file)    │   │   D1 (SQLite)  │
   │  ảnh / video   │   │   metadata     │
   └────────────────┘   └────────────────┘
```

**Phân vai:**
- **Rust**: bắt phím tắt toàn cục, chụp/quay màn hình tức thì, chạy nền ở tray.
- **React + Konva**: hiển thị ảnh, vẽ khung + note, xuất ảnh đã annotate, gọi API.
- **Worker**: cổng API duy nhất, nói chuyện với R2 và D1, sinh link.
- **R2**: chứa file nặng. **D1**: chứa metadata nhẹ.

---

## 2. Luồng dữ liệu chi tiết

**Chụp ảnh:**
1. Bấm phím tắt (vd `Ctrl+Shift+1`) → Rust chụp toàn màn hình → lưu PNG tạm.
2. Rust mở cửa sổ editor và gửi đường dẫn ảnh sang React (qua event).
3. Người dùng kẻ khung + thêm note trên Konva.
4. Bấm **Lưu** → React "ép phẳng" (flatten) annotate lên ảnh → ra 1 PNG cuối + JSON annotate.
5. React `POST /api/upload` (file PNG + JSON + type=image).
6. Worker: PUT vào R2, INSERT vào D1, trả `{ id, url }`.
7. React hiện link + tự copy vào clipboard.

**Quay video:**
1. Bấm phím tắt (vd `Ctrl+Shift+2`) lần 1 → Rust bắt đầu quay (ffmpeg).
2. Bấm lần 2 → dừng quay → ra file mp4.
3. Video **không annotate** → upload thẳng → trả link.

---

## 3. Cấu trúc thư mục dự án

```
app/
├── begin.md
├── implement.md
│
├── desktop/                  # Ứng dụng Tauri
│   ├── src/                  # Frontend React
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── screens/
│   │   │   ├── EditorScreen.tsx     # màn hình chỉnh sửa ảnh (Konva)
│   │   │   └── ResultScreen.tsx     # hiện link sau khi lưu
│   │   ├── components/
│   │   │   ├── AnnotateCanvas.tsx   # canvas Konva: khung + note
│   │   │   ├── Toolbar.tsx
│   │   │   └── NoteEditor.tsx
│   │   ├── lib/
│   │   │   ├── api.ts               # gọi Worker
│   │   │   └── flatten.ts           # ép annotate lên ảnh → PNG
│   │   └── types.ts
│   │
│   ├── src-tauri/            # Backend Rust
│   │   ├── src/
│   │   │   ├── main.rs
│   │   │   ├── capture.rs           # chụp ảnh màn hình
│   │   │   ├── record.rs            # quay video (ffmpeg)
│   │   │   ├── hotkey.rs            # đăng ký phím tắt
│   │   │   └── tray.rs              # system tray
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   │
│   ├── package.json
│   └── vite.config.ts
│
└── worker/                   # Cloudflare Worker (API)
    ├── src/
    │   └── index.ts
    ├── schema.sql            # bảng D1
    └── wrangler.toml
```

---

## 4. Mô hình dữ liệu (D1)

`worker/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,      -- id ngắn, vd nanoid
  type        TEXT NOT NULL,         -- 'image' | 'video'
  r2_key      TEXT NOT NULL,         -- key file trên R2
  mime        TEXT NOT NULL,         -- 'image/png' | 'video/mp4'
  annotations TEXT,                  -- JSON khung + note (null nếu video)
  created_at  INTEGER NOT NULL       -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
```

**Định dạng `annotations` (JSON):**
```json
{
  "imageW": 1920,
  "imageH": 1080,
  "boxes": [
    { "id": "b1", "x": 100, "y": 80, "w": 240, "h": 120, "color": "#ff0000" }
  ],
  "notes": [
    { "id": "n1", "x": 110, "y": 210, "text": "Lỗi ở đây", "color": "#ff0000" }
  ]
}
```
> Lưu thêm JSON annotate (dù đã ép phẳng vào ảnh) để sau này có thể chỉnh sửa lại.

---

## 5. Các bước thực hiện (theo giai đoạn)

### Giai đoạn 0 — Chuẩn bị môi trường
- [ ] Cài **Node.js** (LTS) và **Rust** (rustup).
- [ ] Cài Tauri CLI: `npm create tauri-app@latest` (chọn React + TypeScript).
- [ ] Tạo tài khoản **Cloudflare**, cài `npm i -g wrangler`, chạy `wrangler login`.
- [ ] Cài **ffmpeg** (cho quay video) — sẽ đóng gói làm sidecar của Tauri.

### Giai đoạn 1 — Khởi tạo Worker + R2 + D1 (làm backend trước để có link sớm)
1. Tạo bucket R2: `wrangler r2 bucket create captures`
2. Tạo D1: `wrangler d1 create captures-db` → ghi lại `database_id`.
3. Áp schema: `wrangler d1 execute captures-db --file=worker/schema.sql`
4. Cấu hình `worker/wrangler.toml`:
   ```toml
   name = "captures-api"
   main = "src/index.ts"
   compatibility_date = "2024-01-01"

   [[r2_buckets]]
   binding = "BUCKET"
   bucket_name = "captures"

   [[d1_databases]]
   binding = "DB"
   database_name = "captures-db"
   database_id = "<dán database_id vào đây>"
   ```
5. Viết `worker/src/index.ts` (xem mẫu ở mục 6).
6. Deploy thử: `wrangler deploy` → có URL kiểu `https://captures-api.<acc>.workers.dev`.
7. Test bằng curl/Postman: upload 1 file → nhận link → mở link xem được.

### Giai đoạn 2 — Khung Tauri + phím tắt + chụp ảnh
1. `npm create tauri-app@latest desktop` (React + TS).
2. Thêm plugin phím tắt: `tauri-plugin-global-shortcut`.
3. Viết `hotkey.rs`: đăng ký `Ctrl+Shift+1` (ảnh), `Ctrl+Shift+2` (video).
4. Viết `capture.rs`: dùng crate `xcap` chụp toàn màn hình → PNG tạm.
5. Khi chụp xong → mở cửa sổ editor + emit event kèm đường dẫn ảnh.
6. Viết `tray.rs`: icon ở khay hệ thống, menu Quit, app chạy nền.
7. Test: bấm phím tắt → có file PNG + cửa sổ editor mở lên.

### Giai đoạn 3 — Màn hình chỉnh sửa (React + Konva)
1. Cài: `npm i konva react-konva nanoid`.
2. `AnnotateCanvas.tsx`: 
   - Hiển thị ảnh nền trên `<Stage>`.
   - Công cụ "Khung": kéo chuột để vẽ `<Rect>`, có thể chọn/di chuyển/đổi kích thước (Transformer).
   - Công cụ "Note": click để thêm `<Text>` + ô nhập chữ.
   - Xoá phần tử đang chọn (phím Delete).
3. `flatten.ts`: `stage.toDataURL()` hoặc `toBlob()` → ra PNG đã gộp khung + note.
4. Nút **Lưu** → gọi `api.upload()`.
5. Test: vẽ khung + note, bấm lưu, xem ảnh xuất ra đã có annotate.

### Giai đoạn 4 — Kết nối upload + hiện link
1. `lib/api.ts`: `POST {WORKER_URL}/api/upload` (FormData: file, type, annotations).
2. Nhận `{ id, url }` → chuyển sang `ResultScreen`.
3. Tự copy link vào clipboard (Tauri clipboard API) + nút "Copy".
4. Test end-to-end: phím tắt → annotate → lưu → link mở được trên trình duyệt.

### Giai đoạn 5 — Quay video
1. Đóng gói **ffmpeg** làm sidecar trong `tauri.conf.json`.
2. `record.rs`: 
   - Phím tắt lần 1 → chạy ffmpeg quay màn hình (Windows: `-f gdigrab -i desktop`).
   - Phím tắt lần 2 → gửi tín hiệu dừng → ra `out.mp4`.
3. Upload thẳng video (bỏ qua editor) → nhận link.
4. Test: quay vài giây → dừng → link phát được video.

### Giai đoạn 6 — Hoàn thiện & đóng gói
- [ ] Thông báo nhỏ (toast/notification) khi chụp/quay/lưu xong.
- [ ] Cho phép đổi phím tắt trong phần Cài đặt.
- [ ] Xử lý lỗi mạng (retry upload).
- [ ] `npm run tauri build` → ra file cài đặt (.msi / .exe trên Windows).

---

## 6. Mã nguồn mẫu các phần cốt lõi

### 6.1. Worker API — `worker/src/index.ts`
```ts
import { nanoid } from "nanoid";

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Upload: nhận file + metadata
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const form = await req.formData();
      const file = form.get("file") as File;
      const type = String(form.get("type")); // 'image' | 'video'
      const annotations = form.get("annotations")?.toString() ?? null;

      const id = nanoid(10);
      const ext = type === "video" ? "mp4" : "png";
      const key = `items/${id}.${ext}`;
      const mime = type === "video" ? "video/mp4" : "image/png";

      await env.BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType: mime },
      });

      await env.DB.prepare(
        `INSERT INTO items (id, type, r2_key, mime, annotations, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, type, key, mime, annotations, Date.now()).run();

      const link = `${url.origin}/v/${id}`;
      return Response.json({ id, url: link });
    }

    // Stream file gốc từ R2
    if (req.method === "GET" && url.pathname.startsWith("/file/")) {
      const id = url.pathname.split("/").pop()!;
      const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?")
        .bind(id).first<any>();
      if (!row) return new Response("Not found", { status: 404 });
      const obj = await env.BUCKET.get(row.r2_key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: { "Content-Type": row.mime },
      });
    }

    // Trang xem (HTML)
    if (req.method === "GET" && url.pathname.startsWith("/v/")) {
      const id = url.pathname.split("/").pop()!;
      const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?")
        .bind(id).first<any>();
      if (!row) return new Response("Not found", { status: 404 });
      const media = row.type === "video"
        ? `<video src="/file/${id}" controls style="max-width:100%"></video>`
        : `<img src="/file/${id}" style="max-width:100%"/>`;
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>${id}</title>
         <body style="margin:0;display:flex;justify-content:center;background:#111">
         ${media}</body>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    return new Response("OK");
  },
};
```

### 6.2. Phím tắt + chụp ảnh — `src-tauri/src/capture.rs`
```rust
use xcap::Monitor;

#[tauri::command]
pub fn capture_screen() -> Result<String, String> {
    let monitor = Monitor::all().map_err(|e| e.to_string())?
        .into_iter().next().ok_or("Không tìm thấy màn hình")?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;

    // Lưu ra file tạm
    let path = std::env::temp_dir().join("capture.png");
    image.save(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
```

`src-tauri/src/main.rs` (đăng ký phím tắt — rút gọn):
```rust
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            app.global_shortcut().on_shortcut("Ctrl+Shift+1", move |_, _, _| {
                if let Ok(path) = crate::capture::capture_screen() {
                    // Mở editor + gửi đường dẫn ảnh sang React
                    handle.emit("image-captured", path).ok();
                }
            }).unwrap();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![capture::capture_screen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 6.3. Canvas annotate — `src/components/AnnotateCanvas.tsx` (khung sườn)
```tsx
import { Stage, Layer, Image as KImage, Rect, Text } from "react-konva";
import { useState } from "react";

export function AnnotateCanvas({ image }: { image: HTMLImageElement }) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  // kéo chuột để vẽ khung mới → push vào boxes
  // double click để thêm note → push vào notes
  // Transformer để di chuyển/đổi kích thước phần tử đang chọn

  return (
    <Stage width={image.width} height={image.height}>
      <Layer>
        <KImage image={image} />
        {boxes.map(b => (
          <Rect key={b.id} {...b} stroke={b.color} strokeWidth={3} />
        ))}
        {notes.map(n => (
          <Text key={n.id} x={n.x} y={n.y} text={n.text} fontSize={18} fill={n.color} />
        ))}
      </Layer>
    </Stage>
  );
}
```

### 6.4. Ép phẳng + upload — `src/lib/api.ts`
```ts
const WORKER_URL = "https://captures-api.<acc>.workers.dev";

export async function upload(
  blob: Blob,
  type: "image" | "video",
  annotations?: object
): Promise<{ id: string; url: string }> {
  const form = new FormData();
  form.append("file", blob, type === "video" ? "out.mp4" : "out.png");
  form.append("type", type);
  if (annotations) form.append("annotations", JSON.stringify(annotations));

  const res = await fetch(`${WORKER_URL}/api/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Upload thất bại");
  return res.json();
}
```

`flatten.ts`:
```ts
// stage là ref tới Konva Stage
export async function flattenToBlob(stage: any): Promise<Blob> {
  const dataUrl = stage.toDataURL({ pixelRatio: 1 });
  const res = await fetch(dataUrl);
  return res.blob();
}
```

---

## 7. Phụ thuộc chính (dependencies)

**Tauri / Rust (`Cargo.toml`):**
```toml
tauri = { version = "2", features = [] }
tauri-plugin-global-shortcut = "2"
tauri-plugin-clipboard-manager = "2"
xcap = "0.0"          # chụp màn hình (kiểm tra version mới nhất)
```

**Frontend (`package.json`):**
```
react, react-dom, @tauri-apps/api,
konva, react-konva, nanoid
```

**Worker:** `nanoid` (hoặc tự sinh id), Wrangler.

---

## 8. Checklist kiểm thử (mỗi giai đoạn xong test ngay)

- [ ] Worker: upload qua curl → nhận link → mở link thấy file.
- [ ] Phím tắt chụp ảnh → ra PNG đúng nội dung màn hình.
- [ ] Editor: vẽ khung, thêm note, di chuyển, xoá hoạt động.
- [ ] Ảnh xuất ra đã gộp đúng khung + note.
- [ ] Upload ảnh annotate → link mở thấy đúng ảnh.
- [ ] Quay video → dừng → link phát được video.
- [ ] Link tự copy vào clipboard.
- [ ] `tauri build` ra file cài chạy được trên máy sạch.

---

## 9. Các điểm rủi ro / cần kiểm chứng sớm

1. **Quay video native**: ffmpeg + gdigrab cần thử nghiệm sớm (codec, FPS, dừng sạch). Đây là phần khó nhất.
2. **Version Tauri 2 vs plugin**: API global-shortcut/clipboard đổi theo version → bám theo tài liệu chính thức.
3. **CORS**: Worker cần cho phép request từ app Tauri (thêm header `Access-Control-Allow-Origin`).
4. **Kích thước file video**: video dài → upload lâu; cân nhắc giới hạn thời lượng hoặc nén.
5. **Link công khai**: ai có link đều xem được — chấp nhận ở MVP, nâng cấp private sau.

---

## 10. Lộ trình nâng cấp (sau MVP)

- Đăng nhập + "thư viện của tôi" (chuyển D1 → thêm bảng users, hoặc dùng Supabase Auth).
- Link riêng tư / link hết hạn (presigned URL).
- Annotate cho video (cắt, chú thích theo thời điểm).
- Nén ảnh/video trước khi upload.
- Lịch sử + tìm kiếm + xoá nội dung.

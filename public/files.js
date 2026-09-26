/* ============================================================
   MAX — universal file reader
   Turns any dropped/pasted/picked file into something a model can read:
     • images  → resized/converted to a vision-friendly format
     • PDF     → extracted text (pdf.js) + page images for scanned PDFs
     • Office  → DOCX / XLSX / PPTX / ODT / ODS / ODP text (built-in ZIP reader)
     • ZIP     → file listing + contents of the text files inside
     • video   → evenly-spaced key frames (as images) + duration
     • audio   → metadata
     • text/code/anything textual → the text itself
   No build step, no dependencies (pdf.js is lazy-loaded from the CDN only
   when a PDF is attached).
   ============================================================ */
(() => {
  "use strict";

  const TEXT_CAP = 200_000;            // chars of extracted text per file
  const IMAGE_MAX_EDGE = 1600;         // px — plenty for vision models
  const IMAGE_KEEP_BYTES = 1_500_000;  // keep originals below this size
  const PDF_INLINE_MAX = 10 * 1024 * 1024; // keep raw PDF for native document reading
  const VISION_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/";

  const extOf = (name) => (String(name || "").split(".").pop() || "").toLowerCase();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const cap = (s) => (s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + `\n… (truncated — ${s.length.toLocaleString()} chars total)` : s);

  const readAsDataURL = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob);
  });

  /* ---------------- ZIP (store + deflate) ---------------- */
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser can't decompress ZIP data.");
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function readZip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a ZIP archive (or it is corrupted).");
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const utf8 = new TextDecoder("utf-8");
    const entries = [];
    for (let n = 0; n < count && off + 46 <= u8.length; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const flags = dv.getUint16(off + 8, true);
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const size = dv.getUint32(off + 24, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = utf8.decode(u8.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue;
      entries.push({
        name, size, encrypted: Boolean(flags & 1),
        async bytes() {
          if (this.encrypted) throw new Error("encrypted entry");
          const ln = dv.getUint16(localOff + 26, true), le = dv.getUint16(localOff + 28, true);
          const start = localOff + 30 + ln + le;
          const data = u8.subarray(start, start + compSize);
          if (method === 0) return data;
          if (method === 8) return inflateRaw(data);
          throw new Error(`unsupported compression method ${method}`);
        },
        async text() { return utf8.decode(await this.bytes()); },
      });
    }
    return entries;
  }

  const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const byLocal = (root, local) => Array.from(root.getElementsByTagNameNS("*", local));

  /* ---------------- Office formats ---------------- */
  function docxParagraphText(p) {
    let out = "";
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        const ln = c.localName;
        if (ln === "t") out += c.textContent;
        else if (ln === "tab") out += "\t";
        else if (ln === "br" || ln === "cr") out += "\n";
        else walk(c);
      }
    };
    walk(p);
    return out;
  }

  async function readDocx(entries) {
    const doc = entries.find((e) => e.name === "word/document.xml");
    if (!doc) throw new Error("word/document.xml missing");
    const d = xml(await doc.text());
    const body = byLocal(d, "body")[0] || d.documentElement;
    const lines = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c.localName === "p") {
          const t = docxParagraphText(c);
          const style = byLocal(c, "pStyle")[0]?.getAttribute("w:val") || "";
          const h = /^Heading(\d)/i.exec(style);
          lines.push(h ? `${"#".repeat(Math.min(6, +h[1]))} ${t}` : t);
        } else if (c.localName === "tbl") {
          const rows = byLocal(c, "tr").map((tr) =>
            "| " + byLocal(tr, "tc").map((tc) => byLocal(tc, "p").map(docxParagraphText).join(" ").replace(/\|/g, "\\|")).join(" | ") + " |");
          if (rows.length) {
            const cols = (rows[0].match(/ \| /g) || []).length + 1;
            rows.splice(1, 0, "|" + " --- |".repeat(cols));
          }
          lines.push("", ...rows, "");
        } else walk(c);
      }
    };
    walk(body);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const colToNum = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

  async function readXlsx(entries) {
    const get = (n) => entries.find((e) => e.name === n);
    const shared = [];
    const ss = get("xl/sharedStrings.xml");
    if (ss) for (const si of byLocal(xml(await ss.text()), "si")) shared.push(byLocal(si, "t").map((t) => t.textContent).join(""));
    const wb = get("xl/workbook.xml");
    const rels = get("xl/_rels/workbook.xml.rels");
    const relMap = {};
    if (rels) for (const r of byLocal(xml(await rels.text()), "Relationship")) relMap[r.getAttribute("Id")] = r.getAttribute("Target");
    let sheets = [];
    if (wb) {
      sheets = byLocal(xml(await wb.text()), "sheet").map((s) => {
        const rid = s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
        let target = relMap[rid] || "";
        target = target.replace(/^\/?(xl\/)?/, "xl/");
        return { name: s.getAttribute("name"), path: target };
      });
    }
    if (!sheets.length) sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).map((e, i) => ({ name: `Sheet${i + 1}`, path: e.name }));
    const out = [];
    for (const sh of sheets) {
      const ent = get(sh.path);
      if (!ent) continue;
      const d = xml(await ent.text());
      const rows = [];
      for (const row of byLocal(d, "row").slice(0, 3000)) {
        const cells = [];
        for (const c of byLocal(row, "c")) {
          const idx = colToNum(c.getAttribute("r") || "A");
          const t = c.getAttribute("t");
          const v = byLocal(c, "v")[0]?.textContent ?? "";
          let val = v;
          if (t === "s") val = shared[+v] ?? "";
          else if (t === "inlineStr") val = byLocal(c, "t").map((x) => x.textContent).join("");
          else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
          cells[idx] = /[",\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
        }
        rows.push(Array.from(cells, (x) => x ?? "").join(","));
      }
      out.push(`## Sheet: ${sh.name}\n${rows.join("\n")}`);
    }
    return out.join("\n\n");
  }

  async function readPptx(entries) {
    const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => +a.name.match(/(\d+)\.xml$/)[1] - +b.name.match(/(\d+)\.xml$/)[1]);
    const out = [];
    for (let i = 0; i < slides.length; i++) {
      const d = xml(await slides[i].text());
      const paras = byLocal(d, "p").map((p) => byLocal(p, "t").map((t) => t.textContent).join("")).filter(Boolean);
      out.push(`## Slide ${i + 1}\n${paras.join("\n")}`);
    }
    return out.join("\n\n");
  }

  async function readOdf(entries) {
    const c = entries.find((e) => e.name === "content.xml");
    if (!c) throw new Error("content.xml missing");
    const d = xml(await c.text());
    return byLocal(d, "p").concat(byLocal(d, "h")).map((p) => p.textContent).filter(Boolean).join("\n");
  }

  const TEXTY = /\.(txt|md|mdx|json|jsonl|ya?ml|toml|ini|cfg|conf|env|csv|tsv|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|sql|r|lua|pl|ex|exs|erl|hs|ml|clj|vue|svelte|astro|gradle|tf|hcl|proto|graphql|gql|dockerfile|makefile|gitignore|lock|log|rst|tex|srt|vtt|xhtml|svg|ipynb)$/i;

  async function readArchive(entries, archiveName) {
    const list = entries.map((e) => `${e.name} (${e.size.toLocaleString()} B)`);
    let budget = TEXT_CAP * 0.8;
    const parts = [`Archive ${archiveName}: ${entries.length} file(s)\n\n${list.slice(0, 500).join("\n")}${list.length > 500 ? `\n… ${list.length - 500} more` : ""}`];
    const texts = entries.filter((e) => (TEXTY.test(e.name) || /(^|\/)(README|LICENSE|Makefile|Dockerfile)$/i.test(e.name)) && e.size < 400_000 && !e.encrypted)
      .sort((a, b) => a.name.split("/").length - b.name.split("/").length || a.size - b.size);
    let included = 0;
    for (const e of texts) {
      if (budget <= 0) break;
      try {
        let t = await e.text();
        if (t.includes("\u0000")) continue;
        if (t.length > budget) t = t.slice(0, budget) + "\n… (truncated)";
        budget -= t.length;
        included++;
        parts.push(`--- ${e.name} ---\n${t}`);
      } catch {}
    }
    if (texts.length > included) parts.push(`(${texts.length - included} more text file(s) not included to stay within the context budget)`);
    return parts.join("\n\n");
  }

  /* ---------------- PDF via pdf.js ---------------- */
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PDFJS + "pdf.min.js";
      s.onload = () => {
        if (!window.pdfjsLib) return reject(new Error("pdf.js failed to initialise"));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { pdfjsPromise = null; reject(new Error("Could not load the PDF reader (offline?)")); };
      document.head.appendChild(s);
    });
    return pdfjsPromise;
  }

  async function readPdf(file, onProgress) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = Math.min(pdf.numPages, 400);
    const out = [];
    let chars = 0;
    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      let line = "", lastY = null;
      const lines = [];
      for (const it of tc.items) {
        const y = it.transform ? Math.round(it.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ""; }
        line += it.str + (it.hasEOL ? "\n" : "");
        lastY = y;
      }
      lines.push(line);
      const t = lines.join("\n").replace(/[ \t]+\n/g, "\n").trim();
      chars += t.length;
      out.push(`--- Page ${i} ---\n${t}`);
      onProgress?.(i / pages);
      if (chars > TEXT_CAP) break;
    }
    // Scanned PDF (little/no text layer) → render the first pages as images for vision.
    const images = [];
    if (chars < 40 * pages) {
      for (let i = 1; i <= Math.min(pages, 6); i++) {
        const page = await pdf.getPage(i);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1400 / Math.max(vp0.width, vp0.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        images.push({ media_type: "image/jpeg", dataUrl: c.toDataURL("image/jpeg", 0.85) });
      }
    }
    return { text: cap(out.join("\n\n")), pages: pdf.numPages, images, scanned: images.length > 0 };
  }

  /* ---------------- images ---------------- */
  function loadImage(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("decode failed")); im.src = src; });
  }
  const canvasToBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));

  async function normalizeImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const w = img.naturalWidth || img.width || 1024, h = img.naturalHeight || img.height || 1024;
      const fits = Math.max(w, h) <= IMAGE_MAX_EDGE;
      if (VISION_TYPES.has(file.type) && fits && file.size <= IMAGE_KEEP_BYTES) {
        return { media_type: file.type, dataUrl: await readAsDataURL(file), width: w, height: h };
      }
      const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      let blob = await canvasToBlob(c, "image/webp", 0.9);
      if (!blob || blob.type !== "image/webp") blob = await canvasToBlob(c, file.type === "image/png" ? "image/png" : "image/jpeg", 0.9);
      return { media_type: blob.type, dataUrl: await readAsDataURL(blob), width: c.width, height: c.height, resized: scale < 1, converted: !VISION_TYPES.has(file.type) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------------- video / audio ---------------- */
  async function videoFrames(file, count = 6) {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = url;
    const once = (ev) => new Promise((res, rej) => {
      const ok = () => { cleanup(); res(); };
      const bad = () => { cleanup(); rej(new Error("This video format can't be decoded by the browser.")); };
      const cleanup = () => { v.removeEventListener(ev, ok); v.removeEventListener("error", bad); };
      v.addEventListener(ev, ok, { once: true }); v.addEventListener("error", bad, { once: true });
    });
    try {
      await once("loadeddata");
      const dur = isFinite(v.duration) ? v.duration : 0;
      const scale = Math.min(1, 768 / Math.max(v.videoWidth || 768, v.videoHeight || 432));
      const c = document.createElement("canvas");
      c.width = Math.round((v.videoWidth || 768) * scale); c.height = Math.round((v.videoHeight || 432) * scale);
      const ctx = c.getContext("2d");
      const frames = [];
      const n = dur ? Math.min(count, Math.max(1, Math.ceil(dur))) : 1;
      for (let i = 0; i < n; i++) {
        const t = dur ? Math.min(dur - 0.05, (dur * (i + 0.5)) / n) : 0;
        if (dur) { v.currentTime = Math.max(0, t); await once("seeked"); }
        ctx.drawImage(v, 0, 0, c.width, c.height);
        frames.push({ media_type: "image/jpeg", dataUrl: c.toDataURL("image/jpeg", 0.8), t });
      }
      return { frames, duration: dur, width: v.videoWidth, height: v.videoHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function mediaDuration(file) {
    return new Promise((res) => {
      const url = URL.createObjectURL(file);
      const a = document.createElement("audio");
      a.preload = "metadata"; a.src = url;
      a.onloadedmetadata = () => { res(isFinite(a.duration) ? a.duration : 0); URL.revokeObjectURL(url); };
      a.onerror = () => { res(0); URL.revokeObjectURL(url); };
    });
  }

  /* ---------------- text sniffing ---------------- */
  async function sniffText(file) {
    const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    let bad = 0;
    for (const b of head) { if (b === 0) return null; if (b < 9 || (b > 13 && b < 32)) bad++; }
    if (head.length && bad / head.length > 0.1) return null;
    return await file.text();
  }

  const fmtTime = (s) => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  /**
   * Process any File → attachment.
   * { id, kind, name, size, media_type, dataUrl?, text?, images?, note?, meta? }
   *   kind: image | pdf | document | archive | video | audio | text | binary
   */
  async function processFile(file, { onProgress } = {}) {
    const name = file.name || "file";
    const ext = extOf(name);
    const type = file.type || "";
    const base = { id: uid(), name, size: file.size, media_type: type || "application/octet-stream" };

    // Images (including SVG, BMP, AVIF, ICO, TIFF where the browser can decode)
    if (type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff", "heic", "heif"].includes(ext)) {
      try {
        const im = await normalizeImage(file);
        const att = { ...base, kind: "image", media_type: im.media_type, dataUrl: im.dataUrl, meta: { width: im.width, height: im.height, resized: im.resized, converted: im.converted } };
        if (ext === "svg" && file.size < 150_000) att.text = await file.text();
        return att;
      } catch {
        return { ...base, kind: "binary", note: `Image format ${ext || type} can't be decoded in this browser (try PNG/JPEG).` };
      }
    }

    if (ext === "pdf" || type === "application/pdf") {
      const att = { ...base, kind: "pdf", media_type: "application/pdf" };
      if (file.size <= PDF_INLINE_MAX) att.dataUrl = await readAsDataURL(file);
      try {
        const r = await readPdf(file, onProgress);
        att.text = r.text; att.images = r.images; att.meta = { pages: r.pages, scanned: r.scanned };
      } catch (e) {
        att.note = `Text extraction failed (${e.message}).`;
      }
      return att;
    }

    const isZipLike = ["zip", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "jar", "apk", "xlsm", "docm"].includes(ext) || /zip|officedocument|opendocument/.test(type);
    if (isZipLike) {
      try {
        const entries = readZip(await file.arrayBuffer());
        let text, kind = "document";
        if (ext === "docx" || ext === "docm" || entries.some((e) => e.name === "word/document.xml")) text = await readDocx(entries);
        else if (ext === "xlsx" || ext === "xlsm" || entries.some((e) => e.name === "xl/workbook.xml")) text = await readXlsx(entries);
        else if (ext === "pptx" || entries.some((e) => e.name.startsWith("ppt/slides/"))) text = await readPptx(entries);
        else if (["odt", "ods", "odp"].includes(ext)) text = await readOdf(entries);
        else { text = await readArchive(entries, name); kind = "archive"; }
        return { ...base, kind, text: cap(text), meta: { entries: entries.length } };
      } catch (e) {
        return { ...base, kind: "binary", note: `Could not open ${name} (${e.message}).` };
      }
    }

    if (type.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi", "m4v", "ogv"].includes(ext)) {
      try {
        const v = await videoFrames(file);
        return {
          ...base, kind: "video", images: v.frames,
          meta: { duration: v.duration, width: v.width, height: v.height },
          note: `Video ${name}: ${fmtTime(v.duration)} long, ${v.width}×${v.height}. ${v.frames.length} evenly spaced frames are attached as images (at ${v.frames.map((f) => fmtTime(f.t)).join(", ")}).`,
        };
      } catch (e) {
        return { ...base, kind: "binary", note: `Video ${name}: ${e.message}` };
      }
    }

    if (type.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"].includes(ext)) {
      const d = await mediaDuration(file);
      return { ...base, kind: "audio", note: `Audio file ${name}${d ? `, ${fmtTime(d)} long` : ""}. (Audio content can't be sent to text models — describe what you need, or paste a transcript.)` };
    }

    // Anything that looks like text (code, configs, logs, CSV, unknown extensions…)
    if (file.size <= 5 * 1024 * 1024) {
      const t = await sniffText(file).catch(() => null);
      if (t !== null) {
        let text = t;
        if (ext === "ipynb") {
          try {
            const nb = JSON.parse(t);
            text = (nb.cells || []).map((c, i) => `# [${c.cell_type} ${i + 1}]\n${[].concat(c.source || []).join("")}`).join("\n\n");
          } catch {}
        }
        return { ...base, kind: "text", media_type: type || "text/plain", text: cap(text), meta: { lang: ext } };
      }
    }
    return { ...base, kind: "binary", note: `Binary file ${name} (${type || "unknown type"}). Its raw bytes can't be read by the model.` };
  }

  window.MaxFiles = { processFile, readZip, loadPdfJs };
})();

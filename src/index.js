/**
 * Cloudflare Email Worker: Any Newsletter → Dropbox → Kobo
 *
 * ENV VARS (set in Cloudflare dashboard → Workers → Settings → Variables):
 *
 *   DROPBOX_ACCESS_TOKEN  — long-lived Dropbox API token (set as encrypted secret)
 *   DROPBOX_FOLDER        — Dropbox path synced to Kobo, e.g. /KoboReader
 *
 *   ALLOWED_SENDERS       — optional comma-separated list of allowed sender emails.
 *                           If omitted, all senders are accepted.
 *                           e.g. "morningbrew@email.morningbrew.com,digest@example.com"
 *
 *   BLOCKED_SENDERS       — optional comma-separated list of senders to always reject.
 *                           e.g. "noreply@spam.com"
 */

import * as _pm from "postal-mime";
const PostalMime = _pm.default?.default ?? _pm.default ?? _pm;

export default {
  async email(message, env, ctx) {
    const sender = message.from.toLowerCase().trim();

    // ── 1. Filter senders ──────────────────────────────────────────────────
    if (!isSenderAllowed(sender, env)) {
      console.log(`Skipped email from ${sender} (not in allowlist or blocked)`);
      return;
    }

    // ── 2. Parse the raw email ─────────────────────────────────────────────
    const rawBuffer = await streamToArrayBuffer(message.raw);
    const parsed = await PostalMime.parse(rawBuffer);

    const subject = parsed.subject ?? "No Subject";
    const senderName = extractSenderName(parsed.from?.name, sender);
    const htmlBody = parsed.html ?? textToHtml(parsed.text ?? "No content");

    // ── 3. Build EPUB ──────────────────────────────────────────────────────
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const title = `${subject}`;
    const filename = buildFilename(senderName, subject, date);
    const epubBytes = buildEpub(title, senderName, date, htmlBody);

    // ── 4. Upload to Dropbox ───────────────────────────────────────────────
    const folder = (env.DROPBOX_FOLDER ?? "/KoboReader").replace(/\/$/, "");
    const dropboxPath = `${folder}/${filename}`;

    const response = await fetch(
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.DROPBOX_ACCESS_TOKEN}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: dropboxPath,
            mode: "overwrite",
            autorename: false,
            mute: false,
          }),
        },
        body: epubBytes,
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Dropbox upload failed: ${response.status} — ${err}`);
    }

    console.log(`✓ Uploaded "${filename}" to Dropbox at ${dropboxPath}`);
  },
};

// ── Sender filtering ─────────────────────────────────────────────────────────

function isSenderAllowed(sender, env) {
  const blocked = parseList(env.BLOCKED_SENDERS);
  if (blocked.includes(sender)) return false;

  const allowed = parseList(env.ALLOWED_SENDERS);
  if (allowed.length === 0) return true; // no allowlist = accept all

  return allowed.includes(sender);
}

function parseList(envVar) {
  if (!envVar) return [];
  return envVar
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ── Naming helpers ───────────────────────────────────────────────────────────

/**
 * Extract a clean sender name from the From header name or email address.
 * e.g. "Morning Brew <noreply@...>" → "Morning Brew"
 *      "noreply@email.morningbrew.com" → "morningbrew"
 */
function extractSenderName(fromName, emailAddress) {
  if (fromName && fromName.trim()) return fromName.trim();
  // Fall back to the domain part of the email, minus common prefixes
  const domain = emailAddress.split("@")[1] ?? emailAddress;
  return domain.replace(/^(email|mail|newsletter|news|send)\./i, "").split(".")[0];
}

/**
 * Build a safe filename from sender name, subject, and date.
 * e.g. "Morning-Brew_The-Market-Today_2026-05-19.epub"
 */
function buildFilename(senderName, subject, date) {
  const slugify = (s) =>
    s
      .replace(/[^a-z0-9 _-]/gi, " ")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40); // keep filenames reasonable

  return `${slugify(senderName)}_${slugify(subject)}_${date}.epub`;
}

// ── EPUB builder ─────────────────────────────────────────────────────────────

function buildEpub(title, author, date, htmlBody) {
  const uuid = crypto.randomUUID();
  const safeBody = sanitiseForXhtml(htmlBody);
  const safeTitle = escapeXml(title);
  const safeAuthor = escapeXml(author);
  const modifiedDate = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const files = {
    // mimetype MUST be first and uncompressed for valid EPUB
    mimetype: "application/epub+zip",

    "META-INF/container.xml": `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf"
              media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,

    "OEBPS/content.opf": `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${safeTitle}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>${safeAuthor}</dc:creator>
    <dc:date>${date}</dc:date>
    <meta property="dcterms:modified">${modifiedDate}</meta>
  </metadata>
  <manifest>
    <item id="content"  href="content.xhtml"  media-type="application/xhtml+xml"/>
    <item id="ncx"      href="toc.ncx"        media-type="application/x-dtbncx+xml"/>
    <item id="css"      href="style.css"       media-type="text/css"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="content"/>
  </spine>
</package>`,

    "OEBPS/toc.ncx": `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${uuid}"/>
  </head>
  <docTitle><text>${safeTitle}</text></docTitle>
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>${safeTitle}</text></navLabel>
      <content src="content.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,

    "OEBPS/style.css": `
body {
  font-family: serif;
  font-size: 1em;
  line-height: 1.6;
  margin: 1em 2em;
  color: #111;
}
h1 {
  font-family: sans-serif;
  font-size: 1.4em;
  margin-bottom: 0.2em;
}
.meta {
  font-family: sans-serif;
  font-size: 0.85em;
  color: #555;
  margin-bottom: 2em;
  border-bottom: 1px solid #ccc;
  padding-bottom: 0.5em;
}
h2, h3 { font-family: sans-serif; }
a { color: #1a0dab; }
img { max-width: 100%; height: auto; }
blockquote {
  border-left: 3px solid #ccc;
  margin-left: 0;
  padding-left: 1em;
  color: #444;
}
`,

    "OEBPS/content.xhtml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${safeTitle}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1>${safeTitle}</h1>
  <div class="meta">${safeAuthor} · ${date}</div>
  ${safeBody}
</body>
</html>`,
  };

  return zipFiles(files);
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function textToHtml(text) {
  return `<p>${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br/>")}</p>`;
}

/**
 * Sanitise HTML for embedding in XHTML:
 *  1. If it's a full HTML document, extract just the <body> contents
 *  2. Strip scripts, styles, conditional comments, tracking pixels
 *  3. Unwrap purely layout <table> structures, keeping cell text
 *  4. Self-close void elements
 *  5. Escape bare ampersands
 */
function sanitiseForXhtml(html) {
  // Step 1: extract body contents if this is a full HTML document
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : html;

  // Step 2: strip elements Kobo can't use or that break XHTML
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")  // MSO conditional comments
    .replace(/<!--[\s\S]*?-->/g, "")                      // all other HTML comments
    .replace(/<\?xml[^?]*\?>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");

  // Step 3: strip tracking pixels (1x1 images)
  body = body.replace(/<img[^>]*width=["']?1["']?[^>]*height=["']?1["']?[^>]*\/?>/gi, "");
  body = body.replace(/<img[^>]*height=["']?1["']?[^>]*width=["']?1["']?[^>]*\/?>/gi, "");

  // Step 4: unwrap table layout — replace table/tr/td/tbody with div equivalents
  // keeping the content but losing the email-client-specific table structure
  body = body
    .replace(/<table[^>]*>/gi, '<div class="table">')
    .replace(/<\/table>/gi, "</div>")
    .replace(/<tbody[^>]*>/gi, "")
    .replace(/<\/tbody>/gi, "")
    .replace(/<thead[^>]*>/gi, "")
    .replace(/<\/thead>/gi, "")
    .replace(/<tr[^>]*>/gi, '<div class="tr">')
    .replace(/<\/tr>/gi, "</div>")
    .replace(/<td[^>]*>/gi, '<div class="td">')
    .replace(/<\/td>/gi, "</div>")
    .replace(/<th[^>]*>/gi, '<div class="td">')
    .replace(/<\/th>/gi, "</div>");

  // Step 5: self-close void elements for XHTML validity
  body = body.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)([^>]*?)(?<!\/)>/gi,
    "<$1$2/>"
  );

  // Step 6: escape bare ampersands
  body = body.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, "&amp;");

  return body;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Stream helper ─────────────────────────────────────────────────────────────

async function streamToArrayBuffer(stream) {
  const chunks = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

// ── Minimal ZIP (no external deps, store method — fine for newsletters) ───────

function zipFiles(files) {
  const encoder = new TextEncoder();
  const entries = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const dataBytes =
      typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header sig
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0, true);           // flags
    lv.setUint16(8, 0, true);           // compression: store
    lv.setUint16(10, 0, true);          // mod time
    lv.setUint16(12, 0, true);          // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true); // compressed size
    lv.setUint32(22, dataBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);          // extra field length
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.length);

    entries.push({ nameBytes, dataBytes, crc, localOffset: offset, local });
    offset += local.length;
  }

  // Central directory
  const cdParts = entries.map((e) => {
    const cd = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);  // central dir sig
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);           // compression: store
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.dataBytes.length, true);
    cv.setUint32(24, e.dataBytes.length, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk start
    cv.setUint16(36, 0, true);           // internal attr
    cv.setUint32(38, 0, true);           // external attr
    cv.setUint32(42, e.localOffset, true);
    cd.set(e.nameBytes, 46);
    return cd;
  });

  const cdBytes = concat(cdParts);

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdBytes.length, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return concat([concat(entries.map((e) => e.local)), cdBytes, eocd]);
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function crc32(data) {
  if (!crc32._table) {
    crc32._table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32._table[i] = c;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crc32._table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
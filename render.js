/**
 * 把 Markdown 渲染成完整 HTML。
 * 公式用 KaTeX 服务端渲染，代码用 highlight.js，不依赖截图端的外网 CDN。
 *
 * stdin:  {"markdown": "...", "title": "..."}
 * stdout: HTML 字符串
 */
const fs = require("fs");
const path = require("path");
const MarkdownIt = require("markdown-it");
const { katex } = require("@mdit/plugin-katex");
const hljs = require("highlight.js");

const katexCssPath = require.resolve("katex/dist/katex.min.css");

/**
 * 截图服务在另一台机器，页面是 about:blank：
 * - 相对路径 fonts/*.woff2 会 404
 * - data: 字体 URL 会被服务端剥掉
 * 所以改成 local()，走那台机器上已安装的 KaTeX ttf。
 * 字体目录：/usr/local/share/fonts/katex/
 */
function useLocalKatexFonts(css) {
  return css.replace(/url\((fonts\/[^)]+)\)/g, (full, rel) => {
    const clean = rel.replace(/^["']|["']$/g, "").split("?")[0];
    const base = path.basename(clean);
    const family = base.replace(/\.(woff2|woff|ttf)$/i, "").replace(/-/g, "_");
    return `local("${family}"),${full}`;
  });
}

const katexCss = useLocalKatexFonts(fs.readFileSync(katexCssPath, "utf8"));
const hljsCss = fs.readFileSync(
  require.resolve("highlight.js/styles/github.min.css"),
  "utf8"
);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

const TEX_CMD =
  /\\(?:frac|dfrac|tfrac|lim|sum|int|prod|partial|Delta|cdot|theta|alpha|beta|gamma|infty|sqrt|left|right|quad|qquad|arg|to|rightarrow|leftarrow|pm|times|div|leq|geq|neq|approx|equiv|sin|cos|tan|log|ln|exp|mathbb|mathrm|mathbf|operatorname|begin|end)\b/;

/** 从左到右吞掉一段公式：命令、花括号、上下标，以及夹在中间的字母数字和运算符。 */
function consumeMath(text, start) {
  let i = start;
  let depth = 0;
  let sawCmd = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      sawCmd = true;
      i += 1;
      if (i < text.length && /[a-zA-Z]/.test(text[i])) {
        while (i < text.length && /[a-zA-Z]/.test(text[i])) i += 1;
      } else if (i < text.length) {
        i += 1;
      }
      continue;
    }
    if (ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "}") {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth > 0) { i += 1; continue; }
    if (/[A-Za-z0-9_^'=|+\-*/(),.]/.test(ch) || ch === " ") {
      i += 1;
      continue;
    }
    break;
  }
  while (i > start && text[i - 1] === " ") i -= 1;
  if (!sawCmd) return start;
  return i;
}

/**
 * 模型经常把公式写成裸的 \frac、\lim，没有 $。
 * KaTeX 只认 $ / $$，这种行会被当成普通文本。
 * 已经带定界符的不动。
 */
function wrapBareTex(markdown) {
  const protectedParts = [];
  let src = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => {
    const token = "\u0000CODE" + protectedParts.length + "\u0000";
    protectedParts.push(block);
    return token;
  });
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("$") || !TEX_CMD.test(line)) {
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    const prose = /[。，、；：？！]/.test(trimmed) || trimmed.length > 220;
    if (!prose && trimmed.startsWith("\\")) {
      out.push("$$");
      out.push(line);
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() &&
        TEX_CMD.test(lines[i + 1]) &&
        !lines[i + 1].includes("$") &&
        !/[。，、；：？！]/.test(lines[i + 1])
      ) {
        i += 1;
        out.push(lines[i]);
      }
      out.push("$$");
    } else {
      let built = "";
      let cursor = 0;
      while (cursor < line.length) {
        const slash = line.indexOf("\\", cursor);
        if (slash < 0) {
          built += line.slice(cursor);
          break;
        }
        const end = consumeMath(line, slash);
        if (end <= slash) {
          built += line.slice(cursor, slash + 1);
          cursor = slash + 1;
          continue;
        }
        let begin = slash;
        while (begin > cursor && /[A-Za-z0-9_^'=|+\-*/().,]/.test(line[begin - 1])) {
          begin -= 1;
        }
        const eq = line.lastIndexOf("=", slash);
        if (eq >= cursor && eq < slash && slash - eq < 40 && !/[。，：；]/.test(line.slice(eq, slash))) {
          let left = eq;
          while (left > cursor && /[A-Za-z0-9_^'=|+\-*/()., ]/.test(line[left - 1])) left -= 1;
          begin = left;
        }
        built += line.slice(cursor, begin) + "$" + line.slice(begin, end).trim() + "$";
        cursor = end;
      }
      out.push(built);
    }
  }
  src = out.join("\n");
  protectedParts.forEach((block, idx) => {
    src = src.replace("\u0000CODE" + idx + "\u0000", block);
  });
  return src;
}

function buildMarkdown() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : "";
      let highlighted;
      try {
        highlighted = language
          ? hljs.highlight(code, { language, ignoreIllegals: true }).value
          : md.utils.escapeHtml(code);
      } catch (err) {
        highlighted = md.utils.escapeHtml(code);
      }
      const label = md.utils.escapeHtml(language || "text");
      return (
        `<pre class="hljs"><div class="code-lang">${label}</div><code>` +
        highlighted +
        "</code></pre>"
      );
    },
  });
  md.use(katex, {
    throwOnError: false,
    strict: "ignore",
    errorColor: "#cc0000",
  });
  return md;
}

const PAGE_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #f4f1ea; }
body {
  font-family: "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC",
    "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  color: #2b2a28;
  font-size: 17px;
  line-height: 1.75;
  word-break: break-word;
}
.page {
  width: 100%;
  padding: 28px 36px 40px;
  background: linear-gradient(180deg, #fffdf8 0%, #f7f3ea 100%);
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.35;
  margin: 1.2em 0 0.45em;
  font-weight: 700;
  color: #1f1e1c;
}
h1 { font-size: 1.85em; padding-bottom: 0.25em; border-bottom: 2px solid #e6dfd2; }
h2 { font-size: 1.45em; padding-bottom: 0.2em; border-bottom: 1px solid #ece4d6; }
h3 { font-size: 1.2em; }
p { margin: 0.55em 0; }
a { color: #8a5a2b; text-decoration: none; }
blockquote {
  margin: 0.8em 0;
  padding: 0.2em 0.9em;
  color: #5c564c;
  border-left: 4px solid #d7b48a;
  background: rgba(215, 180, 138, 0.12);
}
ul, ol { margin: 0.4em 0 0.6em; padding-left: 1.4em; }
li { margin: 0.2em 0; }
table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 0.95em; }
th, td { border: 1px solid #e0d8cc; padding: 8px 10px; text-align: left; vertical-align: top; }
th { background: #f3ecdf; }
tr:nth-child(even) td { background: rgba(255,255,255,0.55); }
code {
  font-family: "Sarasa Mono SC", "JetBrains Mono", "Source Code Pro", ui-monospace, monospace;
  font-size: 0.9em;
  background: #efe8dc;
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
pre.hljs { margin: 0.8em 0; border-radius: 10px; overflow: hidden; background: #f6f8fa; border: 1px solid #e6e8eb; }
pre.hljs .code-lang {
  font-size: 12px; letter-spacing: 0.04em; color: #6a737d; background: #eef1f4;
  padding: 4px 12px; font-family: ui-monospace, monospace;
}
pre.hljs code { display: block; padding: 12px 14px 14px; background: transparent; overflow-x: auto; line-height: 1.55; font-size: 14px; }
.katex { font-size: 1.05em; }
.katex-display { margin: 0.8em 0; overflow-x: auto; overflow-y: hidden; }
img { max-width: 100%; }
`;

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch (err) {
    process.stderr.write("stdin is not JSON\n");
    process.exit(2);
  }
  const markdown = wrapBareTex(String(payload.markdown || ""));
  const md = buildMarkdown();
  const body = md.render(markdown);
  const title = String(payload.title || "").replace(/[<>&]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;",
  }[c]));
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${katexCss}\n${hljsCss}\n${PAGE_CSS}</style>
</head>
<body>
<article class="page">
${title ? `<h1 class="doc-title">${title}</h1>` : ""}
${body}
</article>
</body>
</html>`;
  process.stdout.write(html);
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err));
  process.exit(1);
});

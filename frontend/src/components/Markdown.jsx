import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Copy, Check } from "lucide-react";

// CodeBlock: blok kode dengan tombol salin. rehype-highlight sudah mewarnai
// isi <code> (tema github-dark diimpor di main.jsx), jadi di sini cukup
// membungkus + tombol salin. not-prose supaya typography tidak ikut campur.
function CodeBlock({ children }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard ditolak — abaikan
    }
  };
  return (
    <div className="not-prose group relative my-3 overflow-hidden rounded-2xl border border-border bg-[#0d1117]">
      <button
        onClick={copy}
        title="Salin kode"
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-lg bg-white/5 px-2 py-1 font-mono text-[11px] text-muted-foreground opacity-0 transition hover:bg-white/10 hover:text-foreground group-hover:opacity-100"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        <span>{copied ? "Tersalin" : "Salin"}</span>
      </button>
      <pre ref={ref} className="overflow-x-auto p-4 text-[13px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

const COMPONENTS = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

// remark-math hanya mengenali delimiter $...$ dan $$...$$, sedangkan banyak
// model (Qwen3, DeepSeek-R1, GPT, dll) mengeluarkan LaTeX dengan delimiter
// \( ... \) (inline) dan \[ ... \] (display). normalizeMath mengubahnya ke
// bentuk dolar agar ikut ter-render KaTeX. Isi code fence (```) dan inline
// code (`...`) dilewati supaya contoh LaTeX di dalam kode tetap literal.
function normalizeMath(input) {
  if (!input || (!input.includes("\\(") && !input.includes("\\["))) return input;
  // Pecah teks jadi segmen kode vs non-kode. Regex menangkap blok ```...```
  // maupun inline `...`; hanya segmen non-kode yang ditransformasi.
  const parts = input.split(/(```[\s\S]*?```|`[^`]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // segmen kode → biarkan apa adanya
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => `$$${body}$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => `$${body}$`);
    })
    .join("");
}

// Markdown merender teks respons AI (kode, bold, italic, list, tabel, dll).
// react-markdown tidak merender HTML mentah secara default → aman dari XSS.
// Catatan: model reasoning (Qwen3, DeepSeek-R1, dll) membungkus jawaban akhir
// dalam \boxed{...} — dibiarkan sebagai kotak (konvensi umum), hanya di-style
// agar jelas & rapi lewat CSS (.katex .fbox di index.css).
export default function Markdown({ children }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none prose-headings:font-display prose-headings:tracking-tight prose-p:leading-relaxed prose-a:text-panel-chat prose-a:font-medium prose-code:rounded prose-code:bg-panel-image/12 prose-code:px-1.5 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em] prose-code:text-panel-image prose-code:before:content-none prose-code:after:content-none prose-strong:text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]} components={COMPONENTS}>
        {normalizeMath(children || "")}
      </ReactMarkdown>
    </div>
  );
}

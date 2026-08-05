import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Copy, Check } from "lucide-react";

// CodeBlock: blok kode dengan tombol salin. rehype-highlight sudah mewarnai
// isi <code> di dalamnya, jadi di sini cukup membungkus + tombol salin.
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
    <div className="md-codeblock">
      <button className="md-copy" onClick={copy} title="Salin kode">
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? "Tersalin" : "Salin"}</span>
      </button>
      <pre ref={ref}>{children}</pre>
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

// Markdown merender teks respons AI (kode, bold, italic, list, tabel, dll).
// react-markdown tidak merender HTML mentah secara default → aman dari XSS.
export default function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={COMPONENTS}>
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}

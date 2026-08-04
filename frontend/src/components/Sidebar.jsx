import { MessageSquare, Box, Mic } from "lucide-react";
import "./Sidebar.css";

const ITEMS = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "speech", label: "Suara→Teks", icon: Mic },
  { id: "models", label: "Model", icon: Box },
];

export default function Sidebar({ active, onSelect }) {
  return (
    <nav className="sidebar">
      {ITEMS.map(({ id, label, icon: Icon }) => (
        <button key={id} className={`nav-item${active === id ? " active" : ""}`} onClick={() => onSelect(id)}>
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

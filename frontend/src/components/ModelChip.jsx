import { Box, ChevronRight } from "lucide-react";

// ModelChip menampilkan model aktif sebuah mesin sebagai chip read-only.
// Pengelolaan model dipusatkan di Model Manager — mengklik chip membuka
// Model Manager, bukan mengganti model di tempat.
export default function ModelChip({ model, onOpen }) {
  return (
    <button className="model-chip" onClick={onOpen} title="Kelola model di Model Manager">
      <Box size={14} />
      <span className={`model-chip-name${model ? "" : " empty"}`}>{model || "Pilih model di Model Manager"}</span>
      <ChevronRight size={14} className="chev" />
    </button>
  );
}

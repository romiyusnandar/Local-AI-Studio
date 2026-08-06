import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// cn menggabungkan className bersyarat (clsx) lalu merapikan konflik utilitas
// Tailwind (tailwind-merge). Dipakai semua komponen shadcn/ui.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

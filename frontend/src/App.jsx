import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import TopStatusBar from "./components/TopStatusBar.jsx";
import Sidebar, { BottomNav } from "./components/Sidebar.jsx";
import Chat from "./components/Chat.jsx";
import ChatHistory from "./components/ChatHistory.jsx";
import ImageGen from "./components/ImageGen.jsx";
import Speech from "./components/Speech.jsx";
import TextToSpeech from "./components/TextToSpeech.jsx";
import ModelManager from "./components/ModelManager.jsx";
import System from "./components/System.jsx";
import Settings from "./components/Settings.jsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}

// Shell berada di dalam BrowserRouter supaya bisa memakai hook navigasi.
function Shell() {
  const navigate = useNavigate();
  // Tiap panel membuka Model Manager di tab mesinnya sendiri lewat ?kind=.
  const openModels = (kind) => navigate(`/models?kind=${kind}`);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <TopStatusBar onOpenSystem={() => navigate("/system")} />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-hidden pb-[4.5rem] md:pb-0">
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<ChatHistory />} />
              <Route path="/chat/:id" element={<Chat onOpenModels={() => openModels("llm")} />} />
              <Route path="/image" element={<ImageGen onOpenModels={() => openModels("img")} />} />
              <Route path="/speech" element={<Speech onOpenModels={() => openModels("stt")} />} />
              <Route path="/tts" element={<TextToSpeech onOpenModels={() => openModels("tts")} />} />
              <Route path="/models" element={<ModelManager />} />
              <Route path="/system" element={<System />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </main>
        </div>
        <BottomNav />
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;

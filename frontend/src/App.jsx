import { useState } from "react";
import TopStatusBar from "./components/TopStatusBar.jsx";
import Sidebar, { BottomNav } from "./components/Sidebar.jsx";
import Chat from "./components/Chat.jsx";
import ImageGen from "./components/ImageGen.jsx";
import Speech from "./components/Speech.jsx";
import TextToSpeech from "./components/TextToSpeech.jsx";
import ModelManager from "./components/ModelManager.jsx";
import System from "./components/System.jsx";
import Settings from "./components/Settings.jsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

function App() {
  const [panel, setPanel] = useState("chat");

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <TopStatusBar onOpenSystem={() => setPanel("system")} />
        <div className="flex min-h-0 flex-1">
          <Sidebar active={panel} onSelect={setPanel} />
          <main className="min-w-0 flex-1 overflow-hidden pb-[4.5rem] md:pb-0">
            {panel === "chat" && <Chat onOpenModels={() => setPanel("models")} />}
            {panel === "image" && <ImageGen onOpenModels={() => setPanel("models")} />}
            {panel === "speech" && <Speech onOpenModels={() => setPanel("models")} />}
            {panel === "tts" && <TextToSpeech onOpenModels={() => setPanel("models")} />}
            {panel === "models" && <ModelManager />}
            {panel === "system" && <System />}
            {panel === "settings" && <Settings />}
          </main>
        </div>
        <BottomNav active={panel} onSelect={setPanel} />
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;

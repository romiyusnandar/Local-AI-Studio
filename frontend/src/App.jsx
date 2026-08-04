import { useState } from "react";
import TopStatusBar from "./components/TopStatusBar.jsx";
import Sidebar from "./components/Sidebar.jsx";
import Chat from "./components/Chat.jsx";
import ImageGen from "./components/ImageGen.jsx";
import Speech from "./components/Speech.jsx";
import TextToSpeech from "./components/TextToSpeech.jsx";
import ModelManager from "./components/ModelManager.jsx";
import System from "./components/System.jsx";

function App() {
  const [panel, setPanel] = useState("chat");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopStatusBar onOpenSystem={() => setPanel("system")} />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Sidebar active={panel} onSelect={setPanel} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {panel === "chat" && <Chat />}
          {panel === "image" && <ImageGen />}
          {panel === "speech" && <Speech />}
          {panel === "tts" && <TextToSpeech />}
          {panel === "models" && <ModelManager />}
          {panel === "system" && <System />}
        </div>
      </div>
    </div>
  );
}

export default App;

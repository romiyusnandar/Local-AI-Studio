import { useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import Chat from "./components/Chat.jsx";
import Speech from "./components/Speech.jsx";
import TextToSpeech from "./components/TextToSpeech.jsx";
import ModelManager from "./components/ModelManager.jsx";

function App() {
  const [panel, setPanel] = useState("chat");

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar active={panel} onSelect={setPanel} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {panel === "chat" && <Chat />}
        {panel === "speech" && <Speech />}
        {panel === "tts" && <TextToSpeech />}
        {panel === "models" && <ModelManager />}
      </div>
    </div>
  );
}

export default App;

package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	modelDir   = "app/models"
	backendDir = "app/backend"
	uiAddr     = "127.0.0.1:1420"
)

var (
	//go:embed web
	file embed.FS

	mu             sync.Mutex
	portLlama      int
	engineRunning  bool
	forceShutdown  bool
	runningProcess *exec.Cmd
	activeModel    string
)

func main() {
	if err := ensureBackend(); err != nil {
		fmt.Println("gagal menyiapkan backend:", err)
		fmt.Println("aplikasi tetap jalan — cek koneksi lalu restart")
	}

	if models := listModels(); len(models) > 0 {
		setActiveModel(models[0])
	} else {
		fmt.Printf("belum ada model — taruh file .gguf di %s/\n", modelDir)
	}

	if err := ensureTTSBackend(); err != nil {
		fmt.Println("gagal menyiapkan backend TTS:", err)
		fmt.Println("aplikasi tetap jalan — cek koneksi lalu restart")
	}

	if models := listTTSModels(); len(models) > 0 {
		setTTSActiveModel(models[0])
	} else {
		fmt.Printf("belum ada model TTS — taruh file .gguf di %s/\n", ttsModelDir)
	}

	if err := ensureSTTBackend(); err != nil {
		fmt.Println("gagal menyiapkan backend STT:", err)
		fmt.Println("aplikasi tetap jalan — cek koneksi lalu restart")
	}

	if models := listSTTModels(); len(models) > 0 {
		setSTTActiveModel(models[0])
	} else {
		fmt.Printf("belum ada model STT — taruh file .bin di %s/\n", sttModelDir)
	}

	sinyal := make(chan os.Signal, 1)
	signal.Notify(sinyal, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sinyal
		fmt.Println("\nmenghentikan mesin AI...")
		shutdown(getProcess())
		shutdownTTS(getTTSProcess())
		shutdownSTT(getSTTProcess())
		os.Exit(0)
	}()

	go startEngine()
	go startTTSEngine()
	go startSTTEngine()

	http.Handle("/", http.FileServer(http.FS(sub())))
	http.HandleFunc("/api/status", handleStatus)
	http.HandleFunc("/api/chat", handleChat)
	http.HandleFunc("/api/models", handleModels)
	http.HandleFunc("/api/models/select", handleSelectModel)
	http.HandleFunc("/api/catalog", handleCatalog)
	http.HandleFunc("/api/models/download", handleDownloadModel)
	http.HandleFunc("/api/models/cancel", handleCancelDownload)
	http.HandleFunc("/api/models/delete", handleDeleteModel)
	http.HandleFunc("/api/progress", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, getProgress())
	})

	http.HandleFunc("/api/tts/status", handleTTSStatus)
	http.HandleFunc("/api/tts/speak", handleTTSSpeak)
	http.HandleFunc("/api/tts/models", handleTTSModelsList)
	http.HandleFunc("/api/tts/models/select", handleTTSSelectModel)
	http.HandleFunc("/api/tts/catalog", handleTTSCatalog)
	http.HandleFunc("/api/tts/models/download", handleTTSDownloadModel)
	http.HandleFunc("/api/tts/models/cancel", handleCancelDownload)
	http.HandleFunc("/api/tts/models/delete", handleTTSDeleteModel)

	http.HandleFunc("/api/stt/status", handleSTTStatus)
	http.HandleFunc("/api/stt/transcribe", handleSTTTranscribe)
	http.HandleFunc("/api/stt/models", handleSTTModelsList)
	http.HandleFunc("/api/stt/models/select", handleSTTSelectModel)
	http.HandleFunc("/api/stt/catalog", handleSTTCatalog)
	http.HandleFunc("/api/stt/models/download", handleSTTDownloadModel)
	http.HandleFunc("/api/stt/models/cancel", handleCancelDownload)
	http.HandleFunc("/api/stt/models/delete", handleSTTDeleteModel)

	fmt.Println("buka http://localhost:1420")
	if err := http.ListenAndServe(uiAddr, nil); err != nil {
		fmt.Println("server berhenti:", err)
	}
}

// ---------- handler ----------

func handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"mesinHidup": isEngineRunning(),
		"model":      getActiveModel(),
	})
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	models := listModels()
	if models == nil {
		models = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"models": models,
		"active": getActiveModel(),
		"ready":  isEngineRunning(),
	})
}

func handleSelectModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}

	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "permintaan tidak valid"})
		return
	}

	if !isValidModel(req.Model) {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "model tidak ditemukan"})
		return
	}

	if req.Model == getActiveModel() && isEngineRunning() {
		writeJSON(w, http.StatusOK,
			map[string]any{"ok": true, "model": req.Model, "note": "sudah aktif"})
		return
	}

	if p := getProcess(); p != nil {
		shutdown(p)
	}
	setForceShutdown(false)
	setActiveModel(req.Model)

	go startEngine()

	writeJSON(w, http.StatusOK,
		map[string]any{"ok": true, "model": req.Model})
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	if !isEngineRunning() {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "mesin AI sedang mati"})
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "streaming tidak didukung"})
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/v1/chat/completions", getPort()),
		r.Body,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menyiapkan permintaan"})
		return
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		setEngine(false)
		writeJSON(w, http.StatusBadGateway,
			map[string]any{"error": "mesin AI tidak merespons"})
		return
	}
	defer res.Body.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	buf := make([]byte, 4096)
	for {
		n, err := res.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			flusher.Flush()
		}
		if err != nil {
			return
		}
	}
}

// ---------- model ----------

func listModels() []string {
	entries, err := os.ReadDir(modelDir)
	if err != nil {
		return nil
	}

	var out []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasSuffix(strings.ToLower(e.Name()), ".gguf") {
			out = append(out, e.Name())
		}
	}
	return out
}

func isValidModel(name string) bool {
	return slices.Contains(listModels(), name)
}

// ---------- siklus hidup mesin ----------

func startEngine() {
	cmd, err := runLlama()
	if err != nil {
		fmt.Println("gagal menjalankan mesin:", err)
		return
	}

	fmt.Println("menunggu mesin siap...")
	if err := waitForReady(); err != nil {
		fmt.Println("mesin tidak siap:", err)
		shutdown(cmd)
		return
	}
	fmt.Println("mesin siap dengan model:", getActiveModel())

	monitor(cmd)
}

func runLlama() (*exec.Cmd, error) {
	model := getActiveModel()
	if model == "" {
		return nil, fmt.Errorf("belum ada model yang dipilih")
	}

	modelPath := filepath.Join(modelDir, model)
	if _, err := os.Stat(modelPath); err != nil {
		return nil, fmt.Errorf("model %q tidak ditemukan", model)
	}

	port, err := emptyPort()
	if err != nil {
		return nil, err
	}

	bin := filepath.Join(backendDir, "llama-server")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}

	cmd := exec.Command(bin,
		"-m", modelPath,
		"--host", "127.0.0.1",
		"--port", fmt.Sprint(port),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	setProcess(cmd, port)
	return cmd, nil
}

func monitor(cmd *exec.Cmd) {
	failedAttempts := 0

	for {
		mulai := time.Now()

		setEngine(true)
		cmd.Wait()
		setEngine(false)

		if isForceShutdown() {
			return
		}

		if time.Since(mulai) > time.Minute {
			failedAttempts = 0
		}

		failedAttempts++
		if failedAttempts > 3 {
			fmt.Println("mesin gagal 3 kali berturut-turut, berhenti mencoba")

			if err := fallbackToCPU(); err != nil {
				fmt.Println("gagal beralih ke CPU:", err)
				return
			}

			failedAttempts = 0
			newCmd, err := runLlama()
			if err != nil {
				fmt.Println("gagal menyalakan ulang backend CPU:", err)
				return
			}
			if err := waitForReady(); err != nil {
				fmt.Println("mesin CPU tidak siap:", err)
				return
			}
			cmd = newCmd
			continue
		}

		pause := time.Duration(failedAttempts) * 2 * time.Second
		fmt.Printf("mesin berhenti, mencoba lagi dalam %v (percobaan %d/3)\n",
			pause, failedAttempts)
		time.Sleep(pause)

		newCmd, err := runLlama()
		if err != nil {
			fmt.Println("gagal menyalakan ulang:", err)
			continue
		}

		if err := waitForReady(); err != nil {
			fmt.Println("mesin tidak siap setelah restart:", err)
		}

		cmd = newCmd
	}
}

func waitForReady() error {
	limit := time.Now().Add(60 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}

	for time.Now().Before(limit) {
		res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", getPort()))
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("mesin tidak merespons dalam 60 detik")
}

// killProcess menghentikan proses lewat OS tanpa menyentuh flag "force
// shutdown" milik mesin manapun — dipakai ulang oleh shutdown() (LLM) dan
// shutdownTTS() (TTS) supaya kedua mesin punya state independen.
func killProcess(cmd *exec.Cmd) bool {
	if cmd == nil || cmd.Process == nil {
		return false
	}

	if runtime.GOOS == "windows" {
		exec.Command("taskkill", "/PID",
			fmt.Sprint(cmd.Process.Pid), "/T", "/F").Run()
	} else {
		cmd.Process.Kill()
	}

	time.Sleep(200 * time.Millisecond)
	return true
}

func shutdown(cmd *exec.Cmd) {
	if killProcess(cmd) {
		setForceShutdown(true)
	}
}

// ---------- akses variabel bersama ----------

func setProcess(cmd *exec.Cmd, port int) {
	mu.Lock()
	runningProcess, portLlama = cmd, port
	mu.Unlock()
}

func getProcess() *exec.Cmd {
	mu.Lock()
	defer mu.Unlock()
	return runningProcess
}

func getPort() int {
	mu.Lock()
	defer mu.Unlock()
	return portLlama
}

func setEngine(v bool) {
	mu.Lock()
	engineRunning = v
	mu.Unlock()
}

func isEngineRunning() bool {
	mu.Lock()
	defer mu.Unlock()
	return engineRunning
}

func setForceShutdown(v bool) {
	mu.Lock()
	forceShutdown = v
	mu.Unlock()
}

func isForceShutdown() bool {
	mu.Lock()
	defer mu.Unlock()
	return forceShutdown
}

func setActiveModel(name string) {
	mu.Lock()
	activeModel = name
	mu.Unlock()
}

func getActiveModel() string {
	mu.Lock()
	defer mu.Unlock()
	return activeModel
}

// ---------- lain-lain ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func emptyPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func sub() fs.FS {
	f, err := fs.Sub(file, "web")
	if err != nil {
		panic(err)
	}
	return f
}
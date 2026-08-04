package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	ttsBackendDir = "app/tts-backend"
	ttsModelDir   = "app/tts-models"
)

var (
	ttsMu            sync.Mutex
	ttsPort          int
	ttsProcess       *exec.Cmd
	ttsRunning       bool
	ttsForceShutdown bool
	ttsActiveModel   string
)

// ---------- pemasangan backend ----------

func ensureTTSBackend() error {
	return ensureBackendFor(ttsBackendDir, "manifests/tts_backends.json", "cpu")
}

// ---------- model ----------

func listTTSModels() []string {
	entries, err := os.ReadDir(ttsModelDir)
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

func isValidTTSModel(name string) bool {
	return slices.Contains(listTTSModels(), name)
}

// ---------- siklus hidup mesin ----------

func startTTSEngine() {
	cmd, err := runKobold()
	if err != nil {
		fmt.Println("gagal menjalankan mesin TTS:", err)
		return
	}

	fmt.Println("menunggu mesin TTS siap...")
	if err := waitForTTSReady(); err != nil {
		fmt.Println("mesin TTS tidak siap:", err)
		shutdownTTS(cmd)
		return
	}
	fmt.Println("mesin TTS siap dengan model:", getTTSActiveModel())

	monitorTTS(cmd)
}

func ttsBinPath() string {
	bin := filepath.Join(ttsBackendDir, "koboldcpp")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	return bin
}

func runKobold() (*exec.Cmd, error) {
	model := getTTSActiveModel()
	if model == "" {
		return nil, fmt.Errorf("belum ada model TTS yang dipilih")
	}

	modelPath := filepath.Join(ttsModelDir, model)
	if _, err := os.Stat(modelPath); err != nil {
		return nil, fmt.Errorf("model TTS %q tidak ditemukan", model)
	}

	port, err := emptyPort()
	if err != nil {
		return nil, err
	}

	cmd := exec.Command(ttsBinPath(),
		"--ttsmodel", modelPath,
		"--host", "127.0.0.1",
		"--port", fmt.Sprint(port),
		"--skiplauncher",
		"--quiet",
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	setTTSProcess(cmd, port)
	return cmd, nil
}

// monitorTTS me-restart mesin TTS kalau ia berhenti sendiri (crash). Tidak
// ada fallback akselerasi seperti LLM — TTS v1 cuma punya varian CPU.
func monitorTTS(cmd *exec.Cmd) {
	failedAttempts := 0

	for {
		mulai := time.Now()

		setTTSEngine(true)
		cmd.Wait()
		setTTSEngine(false)

		if isTTSForceShutdown() {
			return
		}

		if time.Since(mulai) > time.Minute {
			failedAttempts = 0
		}

		failedAttempts++
		if failedAttempts > 3 {
			fmt.Println("mesin TTS gagal 3 kali berturut-turut, berhenti mencoba")
			return
		}

		pause := time.Duration(failedAttempts) * 2 * time.Second
		fmt.Printf("mesin TTS berhenti, mencoba lagi dalam %v (percobaan %d/3)\n",
			pause, failedAttempts)
		time.Sleep(pause)

		newCmd, err := runKobold()
		if err != nil {
			fmt.Println("gagal menyalakan ulang mesin TTS:", err)
			continue
		}

		if err := waitForTTSReady(); err != nil {
			fmt.Println("mesin TTS tidak siap setelah restart:", err)
		}

		cmd = newCmd
	}
}

// waitForTTSReady polling /api/extra/version — koboldcpp tidak punya
// endpoint /health seperti llama-server.
func waitForTTSReady() error {
	limit := time.Now().Add(60 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}

	for time.Now().Before(limit) {
		res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/extra/version", getTTSPort()))
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("mesin TTS tidak merespons dalam 60 detik")
}

func shutdownTTS(cmd *exec.Cmd) {
	if killProcess(cmd) {
		setTTSForceShutdown(true)
	}
}

// ---------- akses variabel bersama ----------

func setTTSProcess(cmd *exec.Cmd, port int) {
	ttsMu.Lock()
	ttsProcess, ttsPort = cmd, port
	ttsMu.Unlock()
}

func getTTSProcess() *exec.Cmd {
	ttsMu.Lock()
	defer ttsMu.Unlock()
	return ttsProcess
}

func getTTSPort() int {
	ttsMu.Lock()
	defer ttsMu.Unlock()
	return ttsPort
}

func setTTSEngine(v bool) {
	ttsMu.Lock()
	ttsRunning = v
	ttsMu.Unlock()
}

func isTTSRunning() bool {
	ttsMu.Lock()
	defer ttsMu.Unlock()
	return ttsRunning
}

func setTTSForceShutdown(v bool) {
	ttsMu.Lock()
	ttsForceShutdown = v
	ttsMu.Unlock()
}

func isTTSForceShutdown() bool {
	ttsMu.Lock()
	defer ttsMu.Unlock()
	return ttsForceShutdown
}

func setTTSActiveModel(name string) {
	ttsMu.Lock()
	ttsActiveModel = name
	ttsMu.Unlock()
}

func getTTSActiveModel() string {
	ttsMu.Lock()
	defer ttsMu.Unlock()
	return ttsActiveModel
}

// ---------- handler ----------

func handleTTSStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"mesinHidup": isTTSRunning(),
		"model":      getTTSActiveModel(),
	})
}

func handleTTSModelsList(w http.ResponseWriter, r *http.Request) {
	models := listTTSModels()
	if models == nil {
		models = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"models": models,
		"active": getTTSActiveModel(),
		"ready":  isTTSRunning(),
	})
}

func handleTTSSelectModel(w http.ResponseWriter, r *http.Request) {
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

	if !isValidTTSModel(req.Model) {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "model tidak ditemukan"})
		return
	}

	if req.Model == getTTSActiveModel() && isTTSRunning() {
		writeJSON(w, http.StatusOK,
			map[string]any{"ok": true, "model": req.Model, "note": "sudah aktif"})
		return
	}

	if p := getTTSProcess(); p != nil {
		shutdownTTS(p)
	}
	setTTSForceShutdown(false)
	setTTSActiveModel(req.Model)

	go startTTSEngine()

	writeJSON(w, http.StatusOK,
		map[string]any{"ok": true, "model": req.Model})
}

func handleTTSCatalog(w http.ResponseWriter, r *http.Request) {
	c, err := loadCatalog("manifests/tts_models.json")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "katalog rusak"})
		return
	}

	terpasang := map[string]bool{}
	for _, m := range listTTSModels() {
		terpasang[m] = true
	}

	type item struct {
		CatalogModel
		Installed bool `json:"installed"`
	}
	out := make([]item, 0, len(c.Models))
	for _, m := range c.Models {
		out = append(out, item{m, terpasang[m.File]})
	}

	writeJSON(w, http.StatusOK, map[string]any{"models": out})
}

func handleTTSDownloadModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}

	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "permintaan tidak valid"})
		return
	}

	if err := startModelDownload(req.URL, ttsModelDir, []string{".gguf"}, isGGUF); err != nil {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleTTSDeleteModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}

	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !isValidTTSModel(req.Model) {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "model tidak ditemukan"})
		return
	}

	// Model yang sedang dipakai harus dilepas dulu, kalau tidak file-nya
	// terkunci di Windows dan penghapusan gagal.
	if req.Model == getTTSActiveModel() {
		if p := getTTSProcess(); p != nil {
			shutdownTTS(p)
		}
		setTTSActiveModel("")
	}

	if err := os.Remove(filepath.Join(ttsModelDir, req.Model)); err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menghapus"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleTTSSpeak mengubah teks jadi audio lewat koboldcpp, lalu meneruskan
// hasilnya apa adanya (koboldcpp membalas bytes audio mentah, bukan JSON).
func handleTTSSpeak(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}

	if !isTTSRunning() {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "mesin TTS sedang mati"})
		return
	}

	var req struct {
		Text  string `json:"text"`
		Voice string `json:"voice"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Text) == "" {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "teks tidak boleh kosong"})
		return
	}

	payload, err := json.Marshal(map[string]string{"input": req.Text, "voice": req.Voice})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menyiapkan permintaan"})
		return
	}

	httpReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/v1/audio/speech", getTTSPort()),
		bytes.NewReader(payload),
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menyiapkan permintaan"})
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")

	// Sintesis butuh waktu, tapi tidak selama unduhan — batasi supaya
	// permintaan yang macet tidak menggantung selamanya.
	client := &http.Client{Timeout: 120 * time.Second}
	res, err := client.Do(httpReq)
	if err != nil {
		setTTSEngine(false)
		writeJSON(w, http.StatusBadGateway,
			map[string]any{"error": "mesin TTS tidak merespons"})
		return
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway,
			map[string]any{"error": "mesin TTS gagal membuat audio"})
		return
	}

	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "audio/wav"
	}
	w.Header().Set("Content-Type", ct)
	io.Copy(w, res.Body)
}

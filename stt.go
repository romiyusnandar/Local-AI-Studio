package main

import (
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
	sttBackendDir = "app/stt-backend"
	sttModelDir   = "app/stt-models"
)

var (
	sttMu            sync.Mutex
	sttPort          int
	sttProcess       *exec.Cmd
	sttRunning       bool
	sttForceShutdown bool
	sttActiveModel   string
)

// ---------- pemasangan backend ----------

func ensureSTTBackend() error {
	return ensureBackendFor(sttBackendDir, "manifests/stt_backends.json", "cpu")
}

// ---------- model ----------

func listSTTModels() []string {
	entries, err := os.ReadDir(sttModelDir)
	if err != nil {
		return nil
	}

	var out []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasSuffix(strings.ToLower(e.Name()), ".bin") {
			out = append(out, e.Name())
		}
	}
	return out
}

func isValidSTTModel(name string) bool {
	return slices.Contains(listSTTModels(), name)
}

// ---------- siklus hidup mesin ----------

func startSTTEngine() {
	cmd, err := runWhisper()
	if err != nil {
		fmt.Println("gagal menjalankan mesin STT:", err)
		return
	}

	fmt.Println("menunggu mesin STT siap...")
	if err := waitForSTTReady(); err != nil {
		fmt.Println("mesin STT tidak siap:", err)
		shutdownSTT(cmd)
		return
	}
	fmt.Println("mesin STT siap dengan model:", getSTTActiveModel())

	monitorSTT(cmd)
}

func sttBinPath() string {
	bin := filepath.Join(sttBackendDir, "whisper-server")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	return bin
}

func runWhisper() (*exec.Cmd, error) {
	model := getSTTActiveModel()
	if model == "" {
		return nil, fmt.Errorf("belum ada model STT yang dipilih")
	}

	modelPath := filepath.Join(sttModelDir, model)
	if _, err := os.Stat(modelPath); err != nil {
		return nil, fmt.Errorf("model STT %q tidak ditemukan", model)
	}

	port, err := emptyPort()
	if err != nil {
		return nil, err
	}

	cmd := exec.Command(sttBinPath(),
		"-m", modelPath,
		"--host", "127.0.0.1",
		"--port", fmt.Sprint(port),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	setSTTProcess(cmd, port)
	return cmd, nil
}

// monitorSTT me-restart mesin STT kalau ia berhenti sendiri (crash). Tidak
// ada fallback akselerasi seperti LLM — STT v1 cuma punya varian CPU.
func monitorSTT(cmd *exec.Cmd) {
	failedAttempts := 0

	for {
		mulai := time.Now()

		setSTTEngine(true)
		cmd.Wait()
		setSTTEngine(false)

		if isSTTForceShutdown() {
			return
		}

		if time.Since(mulai) > time.Minute {
			failedAttempts = 0
		}

		failedAttempts++
		if failedAttempts > 3 {
			fmt.Println("mesin STT gagal 3 kali berturut-turut, berhenti mencoba")
			return
		}

		pause := time.Duration(failedAttempts) * 2 * time.Second
		fmt.Printf("mesin STT berhenti, mencoba lagi dalam %v (percobaan %d/3)\n",
			pause, failedAttempts)
		time.Sleep(pause)

		newCmd, err := runWhisper()
		if err != nil {
			fmt.Println("gagal menyalakan ulang mesin STT:", err)
			continue
		}

		if err := waitForSTTReady(); err != nil {
			fmt.Println("mesin STT tidak siap setelah restart:", err)
		}

		cmd = newCmd
	}
}

// waitForSTTReady polling /health — whisper-server punya endpoint /health
// yang sama gayanya dengan llama-server.
func waitForSTTReady() error {
	limit := time.Now().Add(60 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}

	for time.Now().Before(limit) {
		res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", getSTTPort()))
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("mesin STT tidak merespons dalam 60 detik")
}

func shutdownSTT(cmd *exec.Cmd) {
	if killProcess(cmd) {
		setSTTForceShutdown(true)
	}
}

// ---------- akses variabel bersama ----------

func setSTTProcess(cmd *exec.Cmd, port int) {
	sttMu.Lock()
	sttProcess, sttPort = cmd, port
	sttMu.Unlock()
}

func getSTTProcess() *exec.Cmd {
	sttMu.Lock()
	defer sttMu.Unlock()
	return sttProcess
}

func getSTTPort() int {
	sttMu.Lock()
	defer sttMu.Unlock()
	return sttPort
}

func setSTTEngine(v bool) {
	sttMu.Lock()
	sttRunning = v
	sttMu.Unlock()
}

func isSTTRunning() bool {
	sttMu.Lock()
	defer sttMu.Unlock()
	return sttRunning
}

func setSTTForceShutdown(v bool) {
	sttMu.Lock()
	sttForceShutdown = v
	sttMu.Unlock()
}

func isSTTForceShutdown() bool {
	sttMu.Lock()
	defer sttMu.Unlock()
	return sttForceShutdown
}

func setSTTActiveModel(name string) {
	sttMu.Lock()
	sttActiveModel = name
	sttMu.Unlock()
}

func getSTTActiveModel() string {
	sttMu.Lock()
	defer sttMu.Unlock()
	return sttActiveModel
}

// ---------- handler ----------

func handleSTTStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"mesinHidup": isSTTRunning(),
		"model":      getSTTActiveModel(),
	})
}

func handleSTTModelsList(w http.ResponseWriter, r *http.Request) {
	models := listSTTModels()
	if models == nil {
		models = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"models": models,
		"active": getSTTActiveModel(),
		"ready":  isSTTRunning(),
	})
}

func handleSTTSelectModel(w http.ResponseWriter, r *http.Request) {
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

	if !isValidSTTModel(req.Model) {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "model tidak ditemukan"})
		return
	}

	if req.Model == getSTTActiveModel() && isSTTRunning() {
		writeJSON(w, http.StatusOK,
			map[string]any{"ok": true, "model": req.Model, "note": "sudah aktif"})
		return
	}

	if p := getSTTProcess(); p != nil {
		shutdownSTT(p)
	}
	setSTTForceShutdown(false)
	setSTTActiveModel(req.Model)

	go startSTTEngine()

	writeJSON(w, http.StatusOK,
		map[string]any{"ok": true, "model": req.Model})
}

func handleSTTCatalog(w http.ResponseWriter, r *http.Request) {
	c, err := loadCatalog("manifests/stt_models.json")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "katalog rusak"})
		return
	}

	terpasang := map[string]bool{}
	for _, m := range listSTTModels() {
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

func handleSTTDownloadModel(w http.ResponseWriter, r *http.Request) {
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

	if err := startModelDownload(req.URL, sttModelDir, []string{".bin"}, isWhisperModel); err != nil {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleSTTDeleteModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}

	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !isValidSTTModel(req.Model) {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "model tidak ditemukan"})
		return
	}

	// Model yang sedang dipakai harus dilepas dulu, kalau tidak file-nya
	// terkunci di Windows dan penghapusan gagal.
	if req.Model == getSTTActiveModel() {
		if p := getSTTProcess(); p != nil {
			shutdownSTT(p)
		}
		setSTTActiveModel("")
	}

	if err := os.Remove(filepath.Join(sttModelDir, req.Model)); err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menghapus"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSTTTranscribe meneruskan upload audio (multipart, field "file")
// apa adanya ke whisper-server. Kita tidak menyuntik field response_format
// karena whisper-server sudah default ke JSON {"text": "..."}.
func handleSTTTranscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}

	if !isSTTRunning() {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "mesin STT sedang mati"})
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/inference", getSTTPort()),
		r.Body,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menyiapkan permintaan"})
		return
	}
	req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	req.ContentLength = r.ContentLength

	// Transkripsi bisa makan waktu untuk audio panjang. Catatan: kalau
	// client memutus koneksi duluan, itu bukan berarti prosesnya mati —
	// status hidup/mati murni ditentukan monitorSTT() lewat cmd.Wait().
	client := &http.Client{Timeout: 120 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway,
			map[string]any{"error": "mesin STT tidak merespons"})
		return
	}
	defer res.Body.Close()

	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(res.StatusCode)
	io.Copy(w, res.Body)
}

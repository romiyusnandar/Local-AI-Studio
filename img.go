package main

import (
	"bytes"
	"encoding/base64"
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
	imgBackendDir = "app/img-backend"
	imgModelDir   = "app/img-models"
)

var (
	imgMu            sync.Mutex
	imgPort          int
	imgProcess       *exec.Cmd
	imgRunning       bool
	imgForceShutdown bool
	imgActiveModel   string
)

// ---------- pemasangan backend ----------

func ensureImgBackend() error {
	return ensureBackendFor(imgBackendDir, "manifests/img_backends.json", "cpu")
}

// ---------- model ----------

func listImgModels() []string {
	entries, err := os.ReadDir(imgModelDir)
	if err != nil {
		return nil
	}

	var out []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := strings.ToLower(e.Name())
		if strings.HasSuffix(name, ".gguf") || strings.HasSuffix(name, ".safetensors") {
			out = append(out, e.Name())
		}
	}
	return out
}

func isValidImgModel(name string) bool {
	return slices.Contains(listImgModels(), name)
}

// ---------- siklus hidup mesin ----------

func startImgEngine() {
	cmd, err := runSD()
	if err != nil {
		fmt.Println("gagal menjalankan mesin image gen:", err)
		return
	}

	fmt.Println("menunggu mesin image gen siap...")
	if err := waitForImgReady(); err != nil {
		fmt.Println("mesin image gen tidak siap:", err)
		shutdownImg(cmd)
		return
	}
	fmt.Println("mesin image gen siap dengan model:", getImgActiveModel())

	monitorImg(cmd)
}

func imgBinPath() string {
	bin := filepath.Join(imgBackendDir, "sd-server")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	return bin
}

func runSD() (*exec.Cmd, error) {
	model := getImgActiveModel()
	if model == "" {
		return nil, fmt.Errorf("belum ada model image gen yang dipilih")
	}

	modelPath := filepath.Join(imgModelDir, model)
	if _, err := os.Stat(modelPath); err != nil {
		return nil, fmt.Errorf("model image gen %q tidak ditemukan", model)
	}

	port, err := emptyPort()
	if err != nil {
		return nil, err
	}

	// sd-server pakai nama flag beda dari llama/whisper/kobold:
	// --listen-ip / --listen-port, bukan --host / --port.
	cmd := exec.Command(imgBinPath(),
		"-m", modelPath,
		"--listen-ip", "127.0.0.1",
		"--listen-port", fmt.Sprint(port),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	setImgProcess(cmd, port)
	return cmd, nil
}

// monitorImg me-restart mesin image gen kalau ia berhenti sendiri (crash).
// Tidak ada fallback akselerasi seperti LLM — image gen v1 cuma CPU.
func monitorImg(cmd *exec.Cmd) {
	failedAttempts := 0

	for {
		mulai := time.Now()

		setImgEngine(true)
		cmd.Wait()
		setImgEngine(false)

		if isImgForceShutdown() {
			return
		}

		if time.Since(mulai) > time.Minute {
			failedAttempts = 0
		}

		failedAttempts++
		if failedAttempts > 3 {
			fmt.Println("mesin image gen gagal 3 kali berturut-turut, berhenti mencoba")
			return
		}

		pause := time.Duration(failedAttempts) * 2 * time.Second
		fmt.Printf("mesin image gen berhenti, mencoba lagi dalam %v (percobaan %d/3)\n",
			pause, failedAttempts)
		time.Sleep(pause)

		newCmd, err := runSD()
		if err != nil {
			fmt.Println("gagal menyalakan ulang mesin image gen:", err)
			continue
		}

		if err := waitForImgReady(); err != nil {
			fmt.Println("mesin image gen tidak siap setelah restart:", err)
		}

		cmd = newCmd
	}
}

// waitForImgReady polling /sdcpp/v1/capabilities — sd-server tidak punya
// endpoint /health, tapi capabilities selalu 200 begitu server siap terima
// koneksi.
func waitForImgReady() error {
	// Model diffusion butuh waktu lebih lama dimuat daripada LLM/TTS/STT.
	limit := time.Now().Add(120 * time.Second)
	client := &http.Client{Timeout: 3 * time.Second}

	for time.Now().Before(limit) {
		res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/sdcpp/v1/capabilities", getImgPort()))
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("mesin image gen tidak merespons dalam 120 detik")
}

func shutdownImg(cmd *exec.Cmd) {
	if killProcess(cmd) {
		setImgForceShutdown(true)
	}
}

// ---------- akses variabel bersama ----------

func setImgProcess(cmd *exec.Cmd, port int) {
	imgMu.Lock()
	imgProcess, imgPort = cmd, port
	imgMu.Unlock()
}

func getImgProcess() *exec.Cmd {
	imgMu.Lock()
	defer imgMu.Unlock()
	return imgProcess
}

func getImgPort() int {
	imgMu.Lock()
	defer imgMu.Unlock()
	return imgPort
}

func setImgEngine(v bool) {
	imgMu.Lock()
	imgRunning = v
	imgMu.Unlock()
}

func isImgRunning() bool {
	imgMu.Lock()
	defer imgMu.Unlock()
	return imgRunning
}

func setImgForceShutdown(v bool) {
	imgMu.Lock()
	imgForceShutdown = v
	imgMu.Unlock()
}

func isImgForceShutdown() bool {
	imgMu.Lock()
	defer imgMu.Unlock()
	return imgForceShutdown
}

func setImgActiveModel(name string) {
	imgMu.Lock()
	imgActiveModel = name
	imgMu.Unlock()
}

func getImgActiveModel() string {
	imgMu.Lock()
	defer imgMu.Unlock()
	return imgActiveModel
}

// ---------- handler ----------

func handleImgStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"mesinHidup": isImgRunning(),
		"model":      getImgActiveModel(),
	})
}

func handleImgModelsList(w http.ResponseWriter, r *http.Request) {
	models := listImgModels()
	if models == nil {
		models = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"models": models,
		"active": getImgActiveModel(),
		"ready":  isImgRunning(),
	})
}

func handleImgSelectModel(w http.ResponseWriter, r *http.Request) {
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

	if !isValidImgModel(req.Model) {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "model tidak ditemukan"})
		return
	}

	if req.Model == getImgActiveModel() && isImgRunning() {
		writeJSON(w, http.StatusOK,
			map[string]any{"ok": true, "model": req.Model, "note": "sudah aktif"})
		return
	}

	if p := getImgProcess(); p != nil {
		shutdownImg(p)
	}
	setImgForceShutdown(false)
	setImgActiveModel(req.Model)

	go startImgEngine()

	writeJSON(w, http.StatusOK,
		map[string]any{"ok": true, "model": req.Model})
}

func handleImgCatalog(w http.ResponseWriter, r *http.Request) {
	c, err := loadCatalog("manifests/img_models.json")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "katalog rusak"})
		return
	}

	terpasang := map[string]bool{}
	for _, m := range listImgModels() {
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

func handleImgDownloadModel(w http.ResponseWriter, r *http.Request) {
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

	if err := startModelDownload(req.URL, imgModelDir, []string{".gguf", ".safetensors"}, isValidImageModel); err != nil {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleImgDeleteModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}

	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !isValidImgModel(req.Model) {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "model tidak ditemukan"})
		return
	}

	// Model yang sedang dipakai harus dilepas dulu, kalau tidak file-nya
	// terkunci di Windows dan penghapusan gagal.
	if req.Model == getImgActiveModel() {
		if p := getImgProcess(); p != nil {
			shutdownImg(p)
		}
		setImgActiveModel("")
	}

	if err := os.Remove(filepath.Join(imgModelDir, req.Model)); err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menghapus"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// sdImageResponse cocok dengan bentuk balasan /v1/images/generations dan
// /v1/images/edits milik sd-server (OpenAI-compatible).
type sdImageResponse struct {
	OutputFormat string `json:"output_format"`
	Data         []struct {
		B64JSON string `json:"b64_json"`
	} `json:"data"`
}

// proxyImageRequest meneruskan request ke sd-server, lalu decode base64
// gambar pertama dan kirim sebagai bytes mentah — pola yang sama dengan
// handleTTSSpeak supaya klien tinggal <img>/blob tanpa decode manual.
func proxyImageRequest(w http.ResponseWriter, r *http.Request, path string, body io.Reader, contentType string) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d%s", getImgPort(), path),
		body,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menyiapkan permintaan"})
		return
	}
	req.Header.Set("Content-Type", contentType)

	// Generasi gambar di CPU bisa makan waktu lama untuk resolusi/step besar.
	client := &http.Client{Timeout: 10 * time.Minute}
	res, err := client.Do(req)
	if err != nil {
		setImgEngine(false)
		writeJSON(w, http.StatusBadGateway,
			map[string]any{"error": "mesin image gen tidak merespons"})
		return
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(res.Body)
		writeJSON(w, http.StatusBadGateway,
			map[string]any{"error": "mesin image gen gagal membuat gambar", "detail": string(respBody)})
		return
	}

	var out sdImageResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || len(out.Data) == 0 {
		writeJSON(w, http.StatusBadGateway,
			map[string]any{"error": "respons mesin image gen tidak dikenal"})
		return
	}

	imgBytes, err := base64.StdEncoding.DecodeString(out.Data[0].B64JSON)
	if err != nil {
		writeJSON(w, http.StatusBadGateway,
			map[string]any{"error": "gagal decode gambar"})
		return
	}

	format := out.OutputFormat
	if format == "" {
		format = "png"
	}
	w.Header().Set("Content-Type", "image/"+format)
	w.Write(imgBytes)
}

// handleImgGenerate: text-to-image. Body diteruskan apa adanya ke
// /v1/images/generations (field minimal: prompt).
func handleImgGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}
	if !isImgRunning() {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "mesin image gen sedang mati"})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "permintaan tidak valid"})
		return
	}

	proxyImageRequest(w, r, "/v1/images/generations", bytes.NewReader(body), "application/json")
}

// handleImgEdit: image-to-image / edit. Multipart (field "prompt", "image",
// dst.) diteruskan apa adanya, mirip handleSTTTranscribe.
func handleImgEdit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}
	if !isImgRunning() {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "mesin image gen sedang mati"})
		return
	}

	proxyImageRequest(w, r, "/v1/images/edits", r.Body, r.Header.Get("Content-Type"))
}

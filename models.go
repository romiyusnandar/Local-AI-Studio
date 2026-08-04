package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

type CatalogModel struct {
	Name      string `json:"name"`
	File      string `json:"file"`
	URL       string `json:"url"`
	SizeBytes int64  `json:"sizeBytes"`
	Note      string `json:"note,omitempty"`
}

type ModelCatalog struct {
	Models []CatalogModel `json:"models"`
}

// Hanya satu unduhan sekaligus. Dua unduhan 5GB bersamaan lebih menyakitkan
// daripada berguna, dan progresnya jadi tidak bisa ditampilkan dengan jelas.
var (
	dlMu     sync.Mutex
	dlCancel context.CancelFunc
	dlBusy   bool
)

func loadCatalog(manifestPath string) (*ModelCatalog, error) {
	b, err := manifestFS.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	var c ModelCatalog
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// safeFilename mengambil nama file dari URL dan menolak apa pun yang bisa
// keluar dari folder model.
func safeFilename(raw string, exts []string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("URL tidak valid")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("hanya http/https yang didukung")
	}

	name := path.Base(u.Path)
	if name == "" || name == "." || name == "/" {
		return "", fmt.Errorf("nama file tidak bisa ditentukan dari URL")
	}
	if strings.ContainsAny(name, `/\`) || name == ".." {
		return "", fmt.Errorf("nama file tidak valid")
	}

	lower := strings.ToLower(name)
	if !slices.ContainsFunc(exts, func(e string) bool { return strings.HasSuffix(lower, e) }) {
		return "", fmt.Errorf("hanya file %s yang didukung", strings.Join(exts, "/"))
	}
	return name, nil
}

// hasMagic memeriksa byte pertama file. Pengganti murah untuk SHA256:
// menangkap kasus paling umum yaitu server mengirim halaman HTML error,
// bukan model.
func hasMagic(path, magic string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()

	buf := make([]byte, len(magic))
	if _, err := f.Read(buf); err != nil {
		return false
	}
	return string(buf) == magic
}

func isGGUF(path string) bool {
	return hasMagic(path, "GGUF")
}

// isWhisperModel memeriksa magic bytes format ggml ("lmgg") yang dipakai
// model whisper.cpp (ekstensi .bin, beda dari GGUF).
func isWhisperModel(path string) bool {
	return hasMagic(path, "lmgg")
}

// isSafetensors memvalidasi header safetensors: 8 byte pertama adalah
// panjang header (little-endian), diikuti JSON yang dimulai dengan '{'.
// Tidak ada magic string ASCII seperti GGUF, jadi diperiksa strukturnya.
func isSafetensors(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()

	var lenBuf [8]byte
	if _, err := io.ReadFull(f, lenBuf[:]); err != nil {
		return false
	}
	headerLen := binary.LittleEndian.Uint64(lenBuf[:])
	if headerLen == 0 || headerLen > 100*1024*1024 {
		return false
	}

	var first [1]byte
	if _, err := io.ReadFull(f, first[:]); err != nil {
		return false
	}
	return first[0] == '{'
}

// isValidImageModel memilih validator sesuai ekstensi — image gen
// menerima .gguf (magic GGUF) maupun .safetensors (header terstruktur).
func isValidImageModel(path string) bool {
	if strings.HasSuffix(strings.ToLower(path), ".safetensors") {
		return isSafetensors(path)
	}
	return isGGUF(path)
}

func startModelDownload(rawURL, targetDir string, exts []string, validate func(string) bool) error {
	dlMu.Lock()
	if dlBusy {
		dlMu.Unlock()
		return fmt.Errorf("masih ada unduhan berjalan")
	}

	name, err := safeFilename(rawURL, exts)
	if err != nil {
		dlMu.Unlock()
		return err
	}

	final := filepath.Join(targetDir, name)
	if _, err := os.Stat(final); err == nil {
		dlMu.Unlock()
		return fmt.Errorf("model %q sudah ada", name)
	}

	ctx, cancel := context.WithCancel(context.Background())
	dlCancel, dlBusy = cancel, true
	dlMu.Unlock()

	setProgress(Progress{Active: true, Label: "Mengunduh " + name})

	go func() {
		defer func() {
			dlMu.Lock()
			dlBusy, dlCancel = false, nil
			dlMu.Unlock()
		}()

		if err := os.MkdirAll(targetDir, 0o755); err != nil {
			setProgress(Progress{Done: true, Err: err.Error()})
			return
		}

		tmp := final + ".part"
		if err := downloadCtx(ctx, rawURL, tmp); err != nil {
			// File .part sengaja dibiarkan supaya bisa dilanjutkan nanti.
			setProgress(Progress{Done: true, Err: err.Error(), Label: name})
			return
		}

		if !validate(tmp) {
			os.Remove(tmp)
			setProgress(Progress{Done: true, Label: name,
				Err: "file yang diunduh bukan model yang valid"})
			return
		}

		// Rename hanya setelah lengkap dan tervalidasi, supaya file setengah
		// jadi tidak pernah muncul di daftar model.
		if err := os.Rename(tmp, final); err != nil {
			setProgress(Progress{Done: true, Err: err.Error()})
			return
		}

		setProgress(Progress{Done: true, Percent: 100, Label: name + " siap"})
		fmt.Println("model terunduh:", name)
	}()

	return nil
}

func cancelDownload() bool {
	dlMu.Lock()
	defer dlMu.Unlock()
	if dlCancel == nil {
		return false
	}
	dlCancel()
	return true
}

// ---------- handler ----------

func handleCatalog(w http.ResponseWriter, r *http.Request) {
	c, err := loadCatalog("manifests/models.json")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "katalog rusak"})
		return
	}

	terpasang := map[string]bool{}
	for _, m := range listModels() {
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

func handleDownloadModel(w http.ResponseWriter, r *http.Request) {
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

	if err := startModelDownload(req.URL, modelDir, []string{".gguf"}, isGGUF); err != nil {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleCancelDownload(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": cancelDownload()})
}

func handleDeleteModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed,
			map[string]any{"error": "gunakan POST"})
		return
	}

	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !isValidModel(req.Model) {
		writeJSON(w, http.StatusBadRequest,
			map[string]any{"error": "model tidak ditemukan"})
		return
	}

	// Model yang sedang dipakai harus dilepas dulu, kalau tidak file-nya
	// terkunci di Windows dan penghapusan gagal.
	if req.Model == getActiveModel() {
		if p := getProcess(); p != nil {
			shutdown(p)
		}
		setActiveModel("")
	}

	if err := os.Remove(filepath.Join(modelDir, req.Model)); err != nil {
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "gagal menghapus"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
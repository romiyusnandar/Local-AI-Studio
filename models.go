package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
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
func safeFilename(raw string) (string, error) {
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
	if !strings.HasSuffix(strings.ToLower(name), ".gguf") {
		return "", fmt.Errorf("hanya file .gguf yang didukung")
	}
	return name, nil
}

// isGGUF memeriksa 4 byte pertama. Pengganti murah untuk SHA256: menangkap
// kasus paling umum yaitu server mengirim halaman HTML error, bukan model.
func isGGUF(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()

	magic := make([]byte, 4)
	if _, err := f.Read(magic); err != nil {
		return false
	}
	return string(magic) == "GGUF"
}

func startModelDownload(rawURL, targetDir string) error {
	dlMu.Lock()
	if dlBusy {
		dlMu.Unlock()
		return fmt.Errorf("masih ada unduhan berjalan")
	}

	name, err := safeFilename(rawURL)
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

		if !isGGUF(tmp) {
			os.Remove(tmp)
			setProgress(Progress{Done: true, Label: name,
				Err: "file yang diunduh bukan model GGUF"})
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

	if err := startModelDownload(req.URL, modelDir); err != nil {
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
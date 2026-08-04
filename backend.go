package main

import (
	"archive/zip"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed manifests
var manifestFS embed.FS

type BackendEntry struct {
	OS         string `json:"os"`
	Accel      string `json:"accel"`
	URL        string `json:"url"`
	Entrypoint string `json:"entrypoint"`
}

type BackendManifest struct {
	Version  string         `json:"version"`
	Backends []BackendEntry `json:"backends"`
}

// Progress dibaca UI lewat polling. Unduhan bisa berjalan menit-menit,
// jauh lebih lama dari satu request HTTP.
type Progress struct {
	Active     bool   `json:"active"`
	Label      string `json:"label"`
	Downloaded int64  `json:"downloaded"`
	Total      int64  `json:"total"`
	Percent    int    `json:"percent"`
	Err        string `json:"error,omitempty"`
	Done       bool   `json:"done"`
}

var (
	progMu   sync.Mutex
	progress Progress
)

func setProgress(p Progress) {
	progMu.Lock()
	progress = p
	progMu.Unlock()
}

func getProgress() Progress {
	progMu.Lock()
	defer progMu.Unlock()
	return progress
}

func updateProgress(downloaded, total int64) {
	progMu.Lock()
	progress.Downloaded = downloaded
	progress.Total = total
	if total > 0 {
		progress.Percent = int(downloaded * 100 / total)
	}
	progMu.Unlock()
}

// ---------- manifest ----------

func loadManifest() (*BackendManifest, error) {
	b, err := manifestFS.ReadFile("manifests/backends.json")
	if err != nil {
		return nil, err
	}
	var m BackendManifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// pickBackend memilih entri yang cocok dengan OS dan akselerasi. Kalau
// varian yang diinginkan tidak ada, mundur ke CPU daripada gagal total.
func pickBackend(m *BackendManifest, accel string) (*BackendEntry, error) {
	var fallback *BackendEntry
	for i := range m.Backends {
		e := &m.Backends[i]
		if e.OS != runtime.GOOS {
			continue
		}
		if e.Accel == accel {
			return e, nil
		}
		if e.Accel == "cpu" || e.Accel == "metal" {
			fallback = e
		}
	}
	if fallback != nil {
		return fallback, nil
	}
	return nil, fmt.Errorf("tidak ada backend untuk %s", runtime.GOOS)
}

// ---------- pemasangan ----------

func versionFile() string {
	return filepath.Join(backendDir, ".version")
}

// fallbackToCPU dipanggil saat backend berakselerasi gagal jalan berulang
// kali. Lebih baik lambat daripada tidak jalan sama sekali.
func fallbackToCPU() error {
	if installedAccel() == "cpu" {
		return fmt.Errorf("backend CPU pun gagal jalan")
	}

	fmt.Println("backend berakselerasi gagal, mundur ke CPU...")

	// Hapus yang lama supaya tidak tercampur file dari varian berbeda.
	if err := os.RemoveAll(backendDir); err != nil {
		return err
	}

	m, err := loadManifest()
	if err != nil {
		return err
	}
	entry, err := pickBackend(m, "cpu")
	if err != nil {
		return err
	}

	return installBackend(m, entry)
}

func backendReady(m *BackendManifest, e *BackendEntry) bool {
	if _, err := os.Stat(filepath.Join(backendDir, e.Entrypoint)); err != nil {
		return false
	}
	b, err := os.ReadFile(versionFile())
	if err != nil {
		return false
	}
	baris := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)
	return baris[0] == m.Version
}

func installedAccel() string {
	b, err := os.ReadFile(versionFile())
	if err != nil {
		return ""
	}
	baris := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)
	if len(baris) < 2 {
		return ""
	}
	return baris[1]
}

func ensureBackend() error {
	m, err := loadManifest()
	if err != nil {
		return fmt.Errorf("manifest rusak: %w", err)
	}

	entry, err := pickBackend(m, detectAccel())
	if err != nil {
		return err
	}

	if backendReady(m, entry) {
		fmt.Printf("backend sudah ada: %s (%s)\n", m.Version, entry.Accel)
		return nil
	}

	return installBackend(m, entry)
}

// installBackend mengunduh dan memasang satu varian backend.
func installBackend(m *BackendManifest, entry *BackendEntry) error {
	fmt.Printf("mengunduh backend %s (%s)...\n", m.Version, entry.Accel)
	setProgress(Progress{Active: true, Label: "Mengunduh backend " + m.Version})

	if err := os.MkdirAll(backendDir, 0o755); err != nil {
		return err
	}

	tmp := filepath.Join(backendDir, "backend.zip.part")
	if err := download(entry.URL, tmp); err != nil {
		setProgress(Progress{Err: err.Error(), Done: true})
		return err
	}

	setProgress(Progress{Active: true, Label: "Mengekstrak...", Percent: 100})
	if err := unzip(tmp, backendDir, entry.Entrypoint); err != nil {
		setProgress(Progress{Err: err.Error(), Done: true})
		return err
	}
	os.Remove(tmp)

	// Catat versi sekaligus varian, supaya kita tahu apa yang terpasang.
	stamp := m.Version + "\n" + entry.Accel
	if err := os.WriteFile(versionFile(), []byte(stamp), 0o644); err != nil {
		return err
	}

	setProgress(Progress{Done: true, Percent: 100, Label: "Backend siap"})
	fmt.Println("backend siap:", entry.Accel)
	return nil
}

// ---------- unduh ----------

func download(url, dest string) error {
	// Kalau ada sisa unduhan sebelumnya, lanjutkan dari situ.
	var start int64
	if fi, err := os.Stat(dest); err == nil {
		start = fi.Size()
	}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if start > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", start))
	}

	// Timeout nol: unduhan besar bisa berjalan berjam-jam.
	res, err := (&http.Client{Timeout: 0}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	switch res.StatusCode {
	case http.StatusOK:
		start = 0 // server mengabaikan Range, mulai dari awal
	case http.StatusPartialContent:
		// resume diterima
	default:
		return fmt.Errorf("server menolak (HTTP %d)", res.StatusCode)
	}

	flag := os.O_CREATE | os.O_WRONLY
	if start > 0 {
		flag |= os.O_APPEND
	} else {
		flag |= os.O_TRUNC
	}

	f, err := os.OpenFile(dest, flag, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	total := res.ContentLength + start
	written := start
	buf := make([]byte, 256*1024)
	lastTick := time.Now()

	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			written += int64(n)
			// Jangan update tiap potongan — mutex-nya jadi macet sendiri.
			if time.Since(lastTick) > 300*time.Millisecond {
				updateProgress(written, total)
				lastTick = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}

	updateProgress(written, total)

	// Pengganti SHA256: minimal pastikan ukurannya utuh.
	if total > 0 && written != total {
		return fmt.Errorf("unduhan tidak lengkap (%d dari %d byte)", written, total)
	}
	return nil
}

// ---------- ekstrak ----------

func unzip(src, destDir, entrypoint string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return fmt.Errorf("file zip rusak: %w", err)
	}
	defer r.Close()

	absDest, err := filepath.Abs(destDir)
	if err != nil {
		return err
	}

	for _, f := range r.File {
		// Rilis llama.cpp membungkus isinya dalam folder build/bin/.
		// Kita ratakan semuanya ke satu folder.
		name := filepath.Base(f.Name)
		if f.FileInfo().IsDir() || name == "" || name == "." {
			continue
		}

		target := filepath.Join(absDest, name)
		// Cegah zip slip: entri bernama "../../etc/passwd" bisa menulis
		// di luar folder tujuan.
		if !strings.HasPrefix(target, absDest+string(os.PathSeparator)) {
			return fmt.Errorf("isi zip mencurigakan: %s", f.Name)
		}

		rc, err := f.Open()
		if err != nil {
			return err
		}

		// Izin executable wajib di Linux/macOS, kalau tidak muncul
		// "permission denied" saat menjalankan backend.
		mode := os.FileMode(0o644)
		if name == entrypoint || strings.HasPrefix(name, "llama-") {
			mode = 0o755
		}

		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			rc.Close()
			return err
		}

		_, cerr := io.Copy(out, rc)
		out.Close()
		rc.Close()
		if cerr != nil {
			return cerr
		}
	}

	if _, err := os.Stat(filepath.Join(absDest, entrypoint)); err != nil {
		return fmt.Errorf("%s tidak ditemukan di dalam zip", entrypoint)
	}
	return nil
}

// detectAccel memilih varian backend berdasarkan hardware. Urutannya
// dari tercepat ke paling aman: CUDA → Vulkan → CPU.
func detectAccel() string {
	if runtime.GOOS == "darwin" {
		return "metal" // semua Mac Apple Silicon
	}

	if hasNvidia() {
		return "cuda"
	}
	if hasVulkan() {
		return "vulkan"
	}
	return "cpu"
}

// hasNvidia menandai keberadaan driver NVIDIA. nvidia-smi ikut terpasang
// bersama driver di semua platform, jadi lebih andal daripada mengecek path.
func hasNvidia() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// -L cuma mendaftar GPU, jauh lebih cepat daripada query penuh.
	err := exec.CommandContext(ctx, "nvidia-smi", "-L").Run()
	return err == nil
}

// hasVulkan mengecek loader Vulkan lewat tool bawaan SDK. Kalau vulkaninfo
// tidak ada, kita periksa keberadaan library loader-nya langsung — banyak
// mesin punya driver Vulkan tanpa memasang SDK.
func hasVulkan() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := exec.CommandContext(ctx, "vulkaninfo", "--summary").Run(); err == nil {
		return true
	}

	var kandidat []string
	switch runtime.GOOS {
	case "windows":
		sys := os.Getenv("SystemRoot")
		if sys == "" {
			sys = `C:\Windows`
		}
		kandidat = []string{filepath.Join(sys, "System32", "vulkan-1.dll")}
	default:
		kandidat = []string{
			"/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
			"/usr/lib64/libvulkan.so.1",
			"/usr/lib/libvulkan.so.1",
		}
	}

	for _, p := range kandidat {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}


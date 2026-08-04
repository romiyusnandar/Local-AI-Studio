package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"
)

//go:embed web
var file embed.FS

func main() {
	proses, err := runLlama()
	if err != nil {
		fmt.Println("gagal menjalankan LLaMA:", err)
	}
	defer proses.Process.Kill()

	fmt.Println("menunggu mesin siap...")
	if err := waitForReady(); err != nil {
		fmt.Println("mesin tidak siap:", err)
		return
	}
	fmt.Println("mesin siap!")

	http.Handle("/", http.FileServer(http.FS(sub())))

	http.HandleFunc("/api/waktu", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"waktu":%q}`, time.Now().Format("15:04:05"))
	})

	http.HandleFunc("/api/chat", func (w http.ResponseWriter, r *http.Request) {
		res, err := http.Post(
			"http://127.0.0.1:8080/v1/chat/completions",
			"application/json",
			r.Body,
		)
		if err != nil {
			http.Error(w, "Gagal menghubungi LLaMA", http.StatusInternalServerError)
			return
		}
		defer res.Body.Close()

		w.Header().Set("Content-Type", "application/json")
		io.Copy(w, res.Body)
	})

	fmt.Println("buka http://localhost:1420")
	http.ListenAndServe("127.0.0.1:1420", nil)
}

func runLlama() (*exec.Cmd, error) {
	path := "app/backend/llama-server"
	if runtime.GOOS == "windows" {
		path += ".exe"
	}

	cmd := exec.Command(path,
		"-m", "app/models/model.gguf",
		"--host", "127.0.0.1",
		"--port", "8080",
	)

	// logging
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd, cmd.Start()
}

func waitForReady() error {
	limit := time.Now().Add(60 * time.Second)

	for time.Now().Before(limit) {
		res, err := http.Get("http://127.0.0.1:8080/health")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("mesin tidak merespons dalam 60 detik")
}

func sub() fs.FS {
	f, err := fs.Sub(file, "web")
	if err != nil {
		panic(err)
	}
	return f
}
package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"
)

//go:embed web
var file embed.FS
var portLlama int

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
			fmt.Sprintf("http://127.0.0.1:%d/v1/chat/completions", portLlama),
			"application/json",
			r.Body,
		)
		if err != nil {
			http.Error(w, "Gagal menghubungi LLaMA", 502)
			return
		}
		defer res.Body.Close()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")

		flusher := w.(http.Flusher)

		buf := make([]byte, 4096)
		for {
			n, err := res.Body.Read(buf)
			if n > 0 {
				w.Write(buf[:n])
				flusher.Flush()
			}
			if err != nil {
				if err != io.EOF {
					http.Error(w, "Gagal membaca respons dari LLaMA", 502)
				}
				break
			}
		}
	})

	fmt.Println("buka http://localhost:1420")
	http.ListenAndServe("127.0.0.1:1420", nil)
}

func emptyPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func runLlama() (*exec.Cmd, error) {
	p, err := emptyPort()
	if err != nil {
		return nil, err
	}
	portLlama = p

	path := "app/backend/llama-server"
	if runtime.GOOS == "windows" {
		path += ".exe"
	}

	cmd := exec.Command(path,
		"-m", "app/models/model.gguf",
		"--host", "127.0.0.1",
		"--port", fmt.Sprint(portLlama),
	)

	// logging
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd, cmd.Start()
}

func waitForReady() error {
	limit := time.Now().Add(60 * time.Second)

	for time.Now().Before(limit) {
		res, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/health", portLlama))
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
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"
)

var (
	//go:embed web
	file embed.FS

	mu             sync.Mutex
	portLlama      int
	engineRunning  bool
	forceShutdown  bool
	runningProcess *exec.Cmd
)

func main() {
	if _, err := runLlama(); err != nil {
		fmt.Println("gagal menjalankan LLaMA:", err)
		return
	}

	sinyal := make(chan os.Signal, 1)
	signal.Notify(sinyal, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sinyal
		fmt.Println("\nmenghentikan mesin AI...")
		shutdown(getProcess())
		os.Exit(0)
	}()

	fmt.Println("menunggu mesin siap...")
	if err := waitForReady(); err != nil {
		fmt.Println("mesin tidak siap:", err)
		shutdown(getProcess())
		return
	}
	fmt.Println("mesin siap!")

	go monitor(getProcess())

	http.Handle("/", http.FileServer(http.FS(sub())))
	http.HandleFunc("/api/status", handleStatus)
	http.HandleFunc("/api/chat", handleChat)

	fmt.Println("buka http://localhost:1420")
	if err := http.ListenAndServe("127.0.0.1:1420", nil); err != nil {
		fmt.Println("server berhenti:", err)
	}
}

// ---------- handler ----------

func handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"mesinHidup":%t}`, isEngineRunning())
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if !isEngineRunning() {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":"mesin AI sedang mati"}`)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"error":"streaming tidak didukung"}`)
		return
	}

	res, err := http.Post(
		fmt.Sprintf("http://127.0.0.1:%d/v1/chat/completions", getPort()),
		"application/json",
		r.Body,
	)
	if err != nil {
		setEngine(false)
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, `{"error":"mesin AI tidak merespons"}`)
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

// ---------- siklus hidup mesin ----------

func runLlama() (*exec.Cmd, error) {
	port, err := emptyPort()
	if err != nil {
		return nil, err
	}

	path := "app/backend/llama-server"
	if runtime.GOOS == "windows" {
		path += ".exe"
	}

	cmd := exec.Command(path,
		"-m", "app/models/model.gguf",
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
			return
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

func shutdown(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}

	setForceShutdown(true)

	if runtime.GOOS == "windows" {
		exec.Command("taskkill", "/PID",
			fmt.Sprint(cmd.Process.Pid), "/T", "/F").Run()
	} else {
		cmd.Process.Kill()
	}

	time.Sleep(200 * time.Millisecond)
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

// ---------- lain-lain ----------

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
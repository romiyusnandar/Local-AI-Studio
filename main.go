package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"time"
)

//go:embed web
var berkas embed.FS

func main() {
	http.Handle("/", http.FileServer(http.FS(sub())))

	http.HandleFunc("/api/waktu", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"waktu":%q}`, time.Now().Format("15:04:05"))
	})

	fmt.Println("buka http://localhost:1420")
	http.ListenAndServe("127.0.0.1:1420", nil)
}

func sub() fs.FS {
	f, err := fs.Sub(berkas, "web")
	if err != nil {
		panic(err)
	}
	return f
}
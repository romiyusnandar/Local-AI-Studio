package main

import (
	"fmt"
	"net/http"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "halo dari server")
	})

	fmt.Println("buka http://localhost:1420")
	http.ListenAndServe(":1420", nil)
}
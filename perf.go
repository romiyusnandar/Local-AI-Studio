package main

import (
	"context"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type GPUStats struct {
	Name               string  `json:"name"`
	UtilizationPercent float64 `json:"utilizationPercent"`
	VRAMUsedBytes      uint64  `json:"vramUsedBytes"`
	VRAMTotalBytes     uint64  `json:"vramTotalBytes"`
}

type PerfStats struct {
	CPUPercent    float64   `json:"cpuPercent"`
	CPUCores      int       `json:"cpuCores"`
	RAMUsedBytes  uint64    `json:"ramUsedBytes"`
	RAMTotalBytes uint64    `json:"ramTotalBytes"`
	GPU           *GPUStats `json:"gpu,omitempty"`
}

// nvidiaStats mengambil statistik GPU lewat nvidia-smi — dipakai ulang
// karena sudah ada nvidia-smi di sistem kalau hasNvidia() (backend.go)
// pernah mendeteksinya. Kalau tidak ada GPU NVIDIA, kembalikan nil saja
// daripada error; dashboard tetap tampil tanpa panel GPU.
func nvidiaStats() *GPUStats {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=name,utilization.gpu,memory.used,memory.total",
		"--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil
	}

	firstLine := strings.TrimSpace(strings.Split(string(out), "\n")[0])
	fields := strings.Split(firstLine, ",")
	if len(fields) < 4 {
		return nil
	}
	for i := range fields {
		fields[i] = strings.TrimSpace(fields[i])
	}

	util, _ := strconv.ParseFloat(fields[1], 64)
	usedMB, _ := strconv.ParseUint(fields[2], 10, 64)
	totalMB, _ := strconv.ParseUint(fields[3], 10, 64)

	return &GPUStats{
		Name:               fields[0],
		UtilizationPercent: util,
		VRAMUsedBytes:      usedMB * 1024 * 1024,
		VRAMTotalBytes:     totalMB * 1024 * 1024,
	}
}

// cpuPercent dan memoryInfo diimplementasikan per-OS (perf_windows.go,
// perf_linux.go, perf_darwin.go) karena caranya beda total di tiap platform.

func handlePerf(w http.ResponseWriter, r *http.Request) {
	cpu, err := cpuPercent()
	if err != nil {
		cpu = 0
	}
	ramUsed, ramTotal, err := memoryInfo()
	if err != nil {
		ramUsed, ramTotal = 0, 0
	}

	writeJSON(w, http.StatusOK, PerfStats{
		CPUPercent:    cpu,
		CPUCores:      runtime.NumCPU(),
		RAMUsedBytes:  ramUsed,
		RAMTotalBytes: ramTotal,
		GPU:           nvidiaStats(),
	})
}

//go:build darwin

package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// cpuPercent di macOS mem-parsing keluaran `top` karena tidak ada API
// sesederhana Windows/Linux tanpa cgo.
func cpuPercent() (float64, error) {
	out, err := exec.Command("top", "-l", "1", "-n", "0", "-stats", "cpu").Output()
	if err != nil {
		return 0, err
	}

	for line := range strings.SplitSeq(string(out), "\n") {
		if !strings.HasPrefix(line, "CPU usage:") {
			continue
		}
		// format: "CPU usage: 12.5% user, 3.2% sys, 84.3% idle"
		for part := range strings.SplitSeq(line, ",") {
			part = strings.TrimSpace(part)
			if !strings.Contains(part, "idle") {
				continue
			}
			fields := strings.Fields(part)
			if len(fields) == 0 {
				continue
			}
			idle, err := strconv.ParseFloat(strings.TrimSuffix(fields[0], "%"), 64)
			if err != nil {
				continue
			}
			return 100 - idle, nil
		}
	}
	return 0, fmt.Errorf("gagal membaca cpu usage")
}

func memoryInfo() (used, total uint64, err error) {
	totOut, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		return 0, 0, err
	}
	total, err = strconv.ParseUint(strings.TrimSpace(string(totOut)), 10, 64)
	if err != nil {
		return 0, 0, err
	}

	vmOut, err := exec.Command("vm_stat").Output()
	if err != nil {
		return 0, total, nil
	}

	const pageSize = uint64(4096)
	var free, inactive uint64
	for line := range strings.SplitSeq(string(vmOut), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "Pages free:"):
			free = parseVMStatPages(line)
		case strings.HasPrefix(line, "Pages inactive:"):
			inactive = parseVMStatPages(line)
		}
	}

	avail := (free + inactive) * pageSize
	if avail > total {
		return 0, total, nil
	}
	return total - avail, total, nil
}

func parseVMStatPages(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return 0
	}
	v := strings.TrimSuffix(fields[len(fields)-1], ".")
	n, _ := strconv.ParseUint(v, 10, 64)
	return n
}

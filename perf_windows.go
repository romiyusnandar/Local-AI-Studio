//go:build windows

package main

import (
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGetSystemTimes       = kernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
)

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func filetimeToU64(ft syscall.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

func getSystemTimes() (idle, kernelT, user uint64, err error) {
	var idleTime, kernelTime, userTime syscall.Filetime
	r, _, e := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idleTime)),
		uintptr(unsafe.Pointer(&kernelTime)),
		uintptr(unsafe.Pointer(&userTime)),
	)
	if r == 0 {
		return 0, 0, 0, e
	}
	return filetimeToU64(idleTime), filetimeToU64(kernelTime), filetimeToU64(userTime), nil
}

// cpuPercent mengambil dua cuplikan GetSystemTimes berjarak 200ms untuk
// menghitung delta pemakaian. kernelTime dari Win32 API sudah termasuk
// idleTime, jadi busy = (kernel+user) - idle.
func cpuPercent() (float64, error) {
	idle1, kernel1, user1, err := getSystemTimes()
	if err != nil {
		return 0, err
	}
	time.Sleep(200 * time.Millisecond)
	idle2, kernel2, user2, err := getSystemTimes()
	if err != nil {
		return 0, err
	}

	idleDelta := idle2 - idle1
	totalDelta := (kernel2 - kernel1) + (user2 - user1)
	if totalDelta == 0 {
		return 0, nil
	}
	return float64(totalDelta-idleDelta) / float64(totalDelta) * 100, nil
}

func memoryInfo() (used, total uint64, err error) {
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	r, _, e := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m)))
	if r == 0 {
		return 0, 0, e
	}
	return m.TotalPhys - m.AvailPhys, m.TotalPhys, nil
}

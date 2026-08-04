//go:build windows

package main

import (
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// Jendela monitor kecil pakai Win32 API mentah lewat syscall — tanpa
// dependency eksternal, tetap satu binary. Menampilkan alamat server,
// CPU/RAM/GPU, dan status tiap mesin (model aktif + varian backend-nya).

var (
	user32Mon   = syscall.NewLazyDLL("user32.dll")
	gdi32Mon    = syscall.NewLazyDLL("gdi32.dll")
	kernel32Mon = syscall.NewLazyDLL("kernel32.dll")

	procRegisterClassExW = user32Mon.NewProc("RegisterClassExW")
	procCreateWindowExW  = user32Mon.NewProc("CreateWindowExW")
	procDefWindowProcW   = user32Mon.NewProc("DefWindowProcW")
	procShowWindow       = user32Mon.NewProc("ShowWindow")
	procUpdateWindow     = user32Mon.NewProc("UpdateWindow")
	procGetMessageW      = user32Mon.NewProc("GetMessageW")
	procTranslateMessage = user32Mon.NewProc("TranslateMessage")
	procDispatchMessageW = user32Mon.NewProc("DispatchMessageW")
	procPostQuitMessage  = user32Mon.NewProc("PostQuitMessage")
	procSetTimer         = user32Mon.NewProc("SetTimer")
	procKillTimer        = user32Mon.NewProc("KillTimer")
	procInvalidateRect   = user32Mon.NewProc("InvalidateRect")
	procBeginPaint       = user32Mon.NewProc("BeginPaint")
	procEndPaint         = user32Mon.NewProc("EndPaint")
	procGetClientRect    = user32Mon.NewProc("GetClientRect")
	procDrawTextW        = user32Mon.NewProc("DrawTextW")
	procLoadCursorW      = user32Mon.NewProc("LoadCursorW")

	procSetBkMode    = gdi32Mon.NewProc("SetBkMode")
	procCreateFontW  = gdi32Mon.NewProc("CreateFontW")
	procSelectObject = gdi32Mon.NewProc("SelectObject")
	procDeleteObject = gdi32Mon.NewProc("DeleteObject")

	procGetModuleHandleW = kernel32Mon.NewProc("GetModuleHandleW")
)

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     syscall.Handle
	hIcon         syscall.Handle
	hCursor       syscall.Handle
	hbrBackground syscall.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       syscall.Handle
}

type winMsg struct {
	hwnd    syscall.Handle
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      winPoint
}

type winPoint struct{ x, y int32 }

type winRect struct{ left, top, right, bottom int32 }

type paintStruct struct {
	hdc         syscall.Handle
	fErase      int32
	rcPaint     winRect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

const (
	wsOverlapped  = 0x00000000
	wsCaption     = 0x00C00000
	wsSysMenu     = 0x00080000
	wsMinimizeBox = 0x00020000
	wsVisible     = 0x10000000
	cwUseDefault  = 0x80000000

	wmDestroy = 0x0002
	wmPaint   = 0x000F
	wmTimer   = 0x0113

	swShow = 5

	dtLeft       = 0x00000000
	dtTop        = 0x00000000
	dtExpandTabs = 0x00000040
	dtNoClip     = 0x00000100

	colorWindow = 5

	idcArrow = 32512

	transparentBk = 1

	defaultCharset = 1
)

var monitorText = "Local AI Studio\r\nMemuat status..."

func utf16ptr(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

func wndProc(hwnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case wmTimer:
		monitorText = buildMonitorText()
		procInvalidateRect.Call(uintptr(hwnd), 0, 1)
		return 0

	case wmPaint:
		var ps paintStruct
		hdc, _, _ := procBeginPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))

		var rc winRect
		procGetClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rc)))
		procSetBkMode.Call(hdc, transparentBk)

		if font := createMonitorFont(); font != 0 {
			old, _, _ := procSelectObject.Call(hdc, font)
			defer func() {
				procSelectObject.Call(hdc, old)
				procDeleteObject.Call(font)
			}()
		}

		rc.left += 14
		rc.top += 12
		rc.right -= 10
		text := utf16ptr(monitorText)
		// cchText -1: string null-terminated, biar Windows yang hitung
		// panjangnya sendiri (byte-length Go string tidak sama dengan
		// jumlah unit UTF-16 kalau ada karakter non-ASCII).
		nullTerminated := int32(-1)
		procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(text)), uintptr(nullTerminated),
			uintptr(unsafe.Pointer(&rc)), uintptr(dtLeft|dtTop|dtExpandTabs|dtNoClip))

		procEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		return 0

	case wmDestroy:
		procKillTimer.Call(uintptr(hwnd), 1)
		procPostQuitMessage.Call(0)
		return 0
	}

	ret, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

func createMonitorFont() uintptr {
	name := utf16ptr("Consolas")
	fontHeight := int32(-14) // tinggi negatif = ukuran karakter dalam pixel
	h, _, _ := procCreateFontW.Call(
		uintptr(fontHeight),
		0, 0, 0,
		400, // FW_NORMAL
		0, 0, 0,
		defaultCharset,
		0, 0, 0, 0,
		uintptr(unsafe.Pointer(name)),
	)
	return h
}

// startMonitorWindow membuka jendela status kecil dan menjalankan message
// loop-nya. Win32 mensyaratkan loop pesan tetap berada di thread yang
// membuat window, jadi goroutine ini dikunci ke satu OS thread. Menutup
// jendela ini hanya menghentikan loop-nya sendiri — server & mesin AI
// tetap berjalan di goroutine lain.
func startMonitorWindow() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hInstance, _, _ := procGetModuleHandleW.Call(0)
	className := utf16ptr("LocalAIStudioMonitor")
	cursor, _, _ := procLoadCursorW.Call(0, uintptr(idcArrow))

	wc := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   syscall.NewCallback(wndProc),
		hInstance:     syscall.Handle(hInstance),
		hCursor:       syscall.Handle(cursor),
		hbrBackground: syscall.Handle(colorWindow + 1),
		lpszClassName: className,
	}
	if r, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		fmt.Println("gagal mendaftarkan jendela monitor")
		return
	}

	style := uintptr(wsOverlapped | wsCaption | wsSysMenu | wsMinimizeBox | wsVisible)
	title := utf16ptr("Local AI Studio - Monitor")
	hwnd, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		style,
		uintptr(cwUseDefault), uintptr(cwUseDefault),
		560, 380,
		0, 0,
		hInstance, 0,
	)
	if hwnd == 0 {
		fmt.Println("gagal membuat jendela monitor")
		return
	}

	procShowWindow.Call(hwnd, swShow)
	procUpdateWindow.Call(hwnd)
	procSetTimer.Call(hwnd, 1, 2000, 0)

	monitorText = buildMonitorText()
	procInvalidateRect.Call(hwnd, 0, 1)

	var m winMsg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func accelLabel(dir string) string {
	if a := installedAccelIn(dir); a != "" {
		return a
	}
	return "?"
}

func engineLine(label, accel string, running bool, model string) string {
	status := "mati"
	if running {
		status = "siap"
	}
	if model == "" {
		model = "-"
	}
	return fmt.Sprintf("%-12s[%-6s] %-5s %s", label, accel, status, model)
}

func buildMonitorText() string {
	cpu, _ := cpuPercent()
	ramUsed, ramTotal, _ := memoryInfo()
	ramPct := 0.0
	if ramTotal > 0 {
		ramPct = float64(ramUsed) / float64(ramTotal) * 100
	}

	gpuLine := "GPU     : tidak ada NVIDIA terdeteksi"
	if g := nvidiaStats(); g != nil {
		gpuLine = fmt.Sprintf("GPU     : %s - %.0f%% (%s / %s VRAM)",
			g.Name, g.UtilizationPercent, formatBytes(g.VRAMUsedBytes), formatBytes(g.VRAMTotalBytes))
	}

	lines := []string{
		"Local AI Studio",
		"Alamat  : http://" + uiAddr,
		"",
		fmt.Sprintf("CPU     : %.0f%% (%d core)", cpu, runtime.NumCPU()),
		fmt.Sprintf("RAM     : %.0f%% (%s / %s)", ramPct, formatBytes(ramUsed), formatBytes(ramTotal)),
		gpuLine,
		"",
		"Mesin        Backend  Status Model",
		engineLine("Chat", accelLabel(backendDir), isEngineRunning(), getActiveModel()),
		engineLine("Image Gen", accelLabel(imgBackendDir), isImgRunning(), getImgActiveModel()),
		engineLine("Suara->Teks", accelLabel(sttBackendDir), isSTTRunning(), getSTTActiveModel()),
		engineLine("Teks->Suara", accelLabel(ttsBackendDir), isTTSRunning(), getTTSActiveModel()),
	}

	return strings.Join(lines, "\r\n")
}

func formatBytes(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for n2 := n / unit; n2 >= unit; n2 /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}

//go:build !windows

package main

// startMonitorWindow tidak melakukan apa-apa di luar Windows — jendela
// monitor native saat ini cuma diimplementasikan lewat Win32 API.
func startMonitorWindow() {}

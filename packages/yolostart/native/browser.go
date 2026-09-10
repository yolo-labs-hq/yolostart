package yolostart

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"syscall"
)

// browserCommand is deliberately pure. BROWSER names an executable (including
// an absolute path with spaces), never shell code. The URL is one argument.
func browserCommand(platform string, env map[string]string, noBrowser bool, uri string) ([]string, string) {
	if noBrowser {
		return nil, ""
	}
	if env["CI"] != "" {
		return nil, "Not opening a browser automatically (CI is set)."
	}
	if browser := env["BROWSER"]; browser != "" {
		return []string{browser, uri}, ""
	}
	if platform == "darwin" {
		return []string{"open", uri}, ""
	}
	if platform == "linux" && (env["DISPLAY"] != "" || env["WAYLAND_DISPLAY"] != "") {
		return []string{"xdg-open", uri}, ""
	}
	if platform == "linux" {
		return nil, "No desktop session detected (DISPLAY and WAYLAND_DISPLAY unset) — open the link above."
	}
	return nil, fmt.Sprintf("Automatic browser opening is unsupported on %s — open the link above.", platform)
}

func openBrowser(uri string, noBrowser bool, report io.Writer) {
	env := map[string]string{}
	for _, key := range []string{"CI", "BROWSER", "DISPLAY", "WAYLAND_DISPLAY"} {
		env[key] = os.Getenv(key)
	}
	args, reason := browserCommand(runtime.GOOS, env, noBrowser, uri)
	if reason != "" {
		fmt.Fprintln(report, reason)
	}
	if len(args) == 0 {
		return
	}
	cmd := exec.Command(args[0], args[1:]...)
	// Nil standard streams use /dev/null. A new session detaches the browser
	// from the CLI's terminal and process group; it survives CLI cancellation.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if cmd.Start() != nil {
		fmt.Fprintln(report, "Could not launch a browser — open the link above.")
		return
	}
	// Reap asynchronously: never delay sign-in polling waiting for a browser.
	go func() { _ = cmd.Wait() }()
	fmt.Fprintln(report, "Opened your browser — if nothing appeared, use the link above.")
}

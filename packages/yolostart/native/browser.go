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
func browserCommand(platform string, env map[string]string, noBrowser bool, uri string) []string {
	if noBrowser || env["CI"] != "" {
		return nil
	}
	if browser := env["BROWSER"]; browser != "" {
		return []string{browser, uri}
	}
	if platform == "darwin" {
		return []string{"open", uri}
	}
	if platform == "linux" && (env["DISPLAY"] != "" || env["WAYLAND_DISPLAY"] != "") {
		return []string{"xdg-open", uri}
	}
	return nil
}

func openBrowser(uri string, noBrowser bool, report io.Writer) {
	env := map[string]string{}
	for _, key := range []string{"CI", "BROWSER", "DISPLAY", "WAYLAND_DISPLAY"} {
		env[key] = os.Getenv(key)
	}
	args := browserCommand(runtime.GOOS, env, noBrowser, uri)
	if len(args) == 0 {
		return
	}
	cmd := exec.Command(args[0], args[1:]...)
	// Nil standard streams use /dev/null. A new session detaches the browser
	// from the CLI's terminal and process group; it survives CLI cancellation.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if cmd.Start() != nil {
		return
	}
	// Reap asynchronously: never delay sign-in polling waiting for a browser.
	go func() { _ = cmd.Wait() }()
	fmt.Fprintln(report, "Opened your browser — if nothing appeared, use the link above.")
}

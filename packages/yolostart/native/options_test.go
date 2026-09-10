package yolostart

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestBrowserDecision(t *testing.T) {
	const uri = "https://yolo.studio/device?code=ABCD-1234"
	for _, tt := range []struct {
		name, os string
		env      map[string]string
		disabled bool
		want     []string
	}{
		{"mac", "darwin", nil, false, []string{"open", uri}},
		{"linux headless", "linux", nil, false, nil},
		{"X11", "linux", map[string]string{"DISPLAY": ":0"}, false, []string{"xdg-open", uri}},
		{"Wayland", "linux", map[string]string{"WAYLAND_DISPLAY": "wayland-0"}, false, []string{"xdg-open", uri}},
		{"explicit headless", "linux", map[string]string{"BROWSER": "firefox"}, false, []string{"firefox", uri}},
		{"explicit mac", "darwin", map[string]string{"BROWSER": "/Applications/My Browser/bin/open"}, false, []string{"/Applications/My Browser/bin/open", uri}},
		{"CI overrides explicit", "darwin", map[string]string{"CI": "true", "BROWSER": "firefox"}, false, nil},
		{"CI false still set", "linux", map[string]string{"CI": "false", "DISPLAY": ":0"}, false, nil},
		{"flag overrides explicit", "linux", map[string]string{"DISPLAY": ":0", "BROWSER": "firefox"}, true, nil},
		{"flag on mac", "darwin", nil, true, nil},
		{"unsupported", "windows", nil, false, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := browserCommand(tt.os, tt.env, tt.disabled, uri); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("%v != %v", got, tt.want)
			}
		})
	}
}

func TestEndpointValidation(t *testing.T) {
	defaults, err := resolveEndpoints("", "")
	if err != nil || defaults.api != defaultAPIURL || defaults.app != defaultAppURL {
		t.Fatal(defaults, err)
	}
	for _, value := range []string{"https://staging-api.yolo.studio/v1", "https://staging.yolo.studio/", "http://localhost:3000/v1", "http://127.0.0.1:8080", "https://localhost"} {
		got, err := resolveEndpoints(value, value)
		if err != nil || got.api != strings.TrimRight(value, "/") || got.app != got.api {
			t.Fatal(got, err)
		}
	}
	for _, value := range []string{"http://example.com", "http://localhost.evil", "http://127.0.0.2", "http://[::1]", "https://", "//host", "file:///tmp", "https://user:PRIVATE@host", "https://host?token=PRIVATE", "https://host#PRIVATE", "https://host?", "https://host#", "https://host:99999", "https://host:", "https://host:abc", " https://host", "https://host\n"} {
		for _, pair := range [][2]string{{value, ""}, {"", value}} {
			_, err := resolveEndpoints(pair[0], pair[1])
			if err == nil || strings.Contains(err.Error(), "PRIVATE") {
				t.Fatalf("accepted or leaked invalid endpoint %q: %v", value, err)
			}
		}
	}
}

func TestOverrideReportingBeforeLogin(t *testing.T) {
	t.Setenv("YOLOSTART_API_URL", "https://staging-api.yolo.studio/v1/")
	t.Setenv("YOLOSTART_APP_URL", "http://localhost:3000")
	var report bytes.Buffer
	stop := errors.New("stop before network")
	called := false
	err := run(context.Background(), []string{"--no-browser"}, io.Discard, &report, func(context.Context) (string, error) {
		called = true
		for _, target := range []string{"https://staging-api.yolo.studio/v1", "http://localhost:3000"} {
			if strings.Count(report.String(), target) != 1 {
				t.Fatal(report.String())
			}
		}
		return "", stop
	})
	if !called || !errors.Is(err, stop) {
		t.Fatal(called, err)
	}
	t.Setenv("YOLOSTART_API_URL", "http://evil.test")
	called = false
	if err := run(context.Background(), nil, io.Discard, io.Discard, func(context.Context) (string, error) { called = true; return "", nil }); err == nil || called {
		t.Fatal("invalid endpoint reached auth", err)
	}
}

func TestDeviceLinkPrintedBeforeBrowserOpen(t *testing.T) {
	a, _, _, report := authFixture(t, []poll{{200, `{"access_token":"PRIVATE-TOKEN"}`}}, 600)
	calls := 0
	a.openBrowser = func(uri string) {
		calls++
		if !strings.Contains(report.String(), "Sign in: "+uri+"\n") || !strings.Contains(uri, "code=ABCD-2345") {
			t.Fatal(report.String(), uri)
		}
	}
	if _, err := a.login(context.Background()); err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
}

func TestRunUsesConfiguredAPIAndApprovalURL(t *testing.T) {
	const id = "0123456789abcdef01234567"
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("missing token")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/yolostart/sessions":
			io.WriteString(w, `{"id":"`+id+`","status":"awaiting-approval"}`)
		case "GET /v1/yolostart/sessions/" + id:
			io.WriteString(w, `{"id":"`+id+`","status":"denied"}`)
		default:
			t.Error("unexpected request", r.Method, r.URL.Path)
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	t.Setenv("YOLOSTART_API_URL", server.URL+"/v1")
	t.Setenv("YOLOSTART_APP_URL", "https://staging.example.test")
	var report bytes.Buffer
	err := run(context.Background(), []string{"--no-browser", "--scan", t.TempDir()}, io.Discard, &report, func(context.Context) (string, error) { return "fixture", nil })
	if err == nil || err.Error() != "import denied" || calls != 2 || !strings.Contains(report.String(), "Approve import: https://staging.example.test/start/"+id) {
		t.Fatal(err, calls, report.String())
	}
}

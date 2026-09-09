package yolostart

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type poll struct {
	status int
	body   string
}

func authFixture(t *testing.T, polls []poll, expiry int) (authDriver, *[]string, *[]time.Duration, *bytes.Buffer) {
	t.Helper()
	calls := []string{}
	sleeps := []time.Duration{}
	report := &bytes.Buffer{}
	now := time.Unix(0, 0)
	a := newAuth(report)
	a.now = func() time.Time { return now }
	a.sleep = func(_ context.Context, d time.Duration) error {
		sleeps = append(sleeps, d)
		now = now.Add(d)
		return nil
	}
	a.client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		calls = append(calls, r.URL.String())
		if r.Method != "POST" || r.Header.Get("Content-Type") != "application/json" {
			t.Fatal(r)
		}
		p := poll{}
		if len(calls) == 1 {
			b, _ := json.Marshal(map[string]any{"device_code": "PRIVATE-DEVICE", "user_code": "ABCD-2345", "verification_uri": "https://yolo.studio/device", "expires_in": expiry, "interval": 5})
			p = poll{200, string(b)}
		} else {
			if len(polls) == 0 {
				t.Fatal("unexpected poll")
			}
			p = polls[0]
			polls = polls[1:]
			body, _ := io.ReadAll(r.Body)
			if string(body) != `{"device_code":"PRIVATE-DEVICE"}` {
				t.Fatal(string(body))
			}
		}
		if r.URL.String() != authURL+"/device/code" && r.URL.String() != authURL+"/device/token" {
			t.Fatal("unexpected network")
		}
		return &http.Response{StatusCode: p.status, Body: io.NopCloser(strings.NewReader(p.body)), Header: make(http.Header)}, nil
	})
	return a, &calls, &sleeps, report
}
func TestDevicePendingAndSuccess(t *testing.T) {
	a, calls, sleeps, report := authFixture(t, []poll{{400, `{"error":{"message":"authorization_pending"}}`}, {200, `{"access_token":"PRIVATE-TOKEN"}`}}, 600)
	token, e := a.login(context.Background())
	if e != nil || token != "PRIVATE-TOKEN" || len(*calls) != 3 || len(*sleeps) != 2 || (*sleeps)[0] != 5*time.Second {
		t.Fatal(token, e, *calls, *sleeps)
	}
	if strings.Contains(report.String(), "PRIVATE-") || !strings.Contains(report.String(), "https://yolo.studio/device?code=ABCD-2345") {
		t.Fatal(report.String())
	}
}
func TestDeviceDenialExpiryAndServerErrors(t *testing.T) {
	for _, tt := range []struct {
		p       []poll
		expiry  int
		message string
	}{{[]poll{{403, `{"error":{"message":"access_denied"}}`}}, 600, "denied"}, {nil, 5, "expired"}, {[]poll{{500, `{"error":{"message":"PRIVATE-DATA"}}`}}, 600, "HTTP 500"}} {
		a, _, _, report := authFixture(t, tt.p, tt.expiry)
		_, e := a.login(context.Background())
		if e == nil || !strings.Contains(e.Error(), tt.message) || strings.Contains(report.String(), "PRIVATE-") {
			t.Fatal(e)
		}
	}
}
func TestDeviceSlowDown(t *testing.T) {
	a, _, sleeps, _ := authFixture(t, []poll{{400, `{"error":"slow_down"}`}, {200, `{"access_token":"token"}`}}, 600)
	if _, e := a.login(context.Background()); e != nil {
		t.Fatal(e)
	}
	if (*sleeps)[1] != 10*time.Second {
		t.Fatal(*sleeps)
	}
}

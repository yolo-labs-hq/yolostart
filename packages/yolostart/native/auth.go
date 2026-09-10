package yolostart

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const authURL = "https://auth.yololabs.ai/api/v1/auth"

type authDriver struct {
	openBrowser func(string)
	client      *http.Client
	now         func() time.Time
	sleep       func(context.Context, time.Duration) error
	report      io.Writer
}

func newAuth(w io.Writer) authDriver {
	return authDriver{client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("auth redirects are not allowed") }}, now: time.Now, sleep: func(ctx context.Context, d time.Duration) error {
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case <-timer.C:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}, report: w}
}
func (a authDriver) post(ctx context.Context, route string, body any) (map[string]any, int, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", authURL+"/device/"+route, bytes.NewReader(data))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := a.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("device sign-in request failed: %w", err)
	}
	defer res.Body.Close()
	var out map[string]any
	if err = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return nil, res.StatusCode, errors.New("invalid device sign-in response")
	}
	return out, res.StatusCode, nil
}
func (a authDriver) login(ctx context.Context) (string, error) {
	data, status, err := a.post(ctx, "code", map[string]string{})
	if err != nil {
		return "", err
	}
	if status != 200 {
		return "", fmt.Errorf("device sign-in unavailable (HTTP %d)", status)
	}
	code, _ := data["device_code"].(string)
	userCode, _ := data["user_code"].(string)
	uri, _ := data["verification_uri"].(string)
	expiry, _ := data["expires_in"].(float64)
	if code == "" || userCode == "" || expiry <= 0 {
		return "", errors.New("invalid device sign-in response")
	}
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return "", errors.New("device verification requires HTTPS")
	}
	q := u.Query()
	q.Set("code", userCode)
	u.RawQuery = q.Encode()
	fmt.Fprintf(a.report, "Sign in: %s\n", u.String())
	if a.openBrowser != nil {
		a.openBrowser(u.String())
	}
	fmt.Fprintln(a.report, "Waiting for browser approval...")
	deadline := a.now().Add(time.Duration(min(expiry, 600) * float64(time.Second)))
	interval := 5 * time.Second
	if v, ok := data["interval"].(float64); ok && v > 5 {
		interval = time.Duration(min(v, 600) * float64(time.Second))
	}
	for a.now().Before(deadline) {
		if err = a.sleep(ctx, min(interval, deadline.Sub(a.now()))); err != nil {
			return "", err
		}
		if !a.now().Before(deadline) {
			break
		}
		data, status, err = a.post(ctx, "token", map[string]string{"device_code": code})
		if err != nil {
			return "", err
		}
		if token, ok := data["access_token"].(string); status == 200 && ok && token != "" {
			fmt.Fprintln(a.report, "Signed in.")
			return token, nil
		}
		message, _ := data["error"].(string)
		if nested, ok := data["error"].(map[string]any); ok {
			message, _ = nested["message"].(string)
		}
		if status == 400 && message == "authorization_pending" {
			continue
		}
		if status == 400 && message == "slow_down" {
			interval += 5 * time.Second
			continue
		}
		if message == "access_denied" {
			return "", errors.New("device sign-in denied")
		}
		if message == "expired_token" || message == "Device code expired" {
			break
		}
		return "", fmt.Errorf("device sign-in failed (HTTP %d); re-run to sign in again", status)
	}
	return "", errors.New("device sign-in expired; re-run to sign in again")
}

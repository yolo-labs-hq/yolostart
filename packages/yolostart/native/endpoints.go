package yolostart

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

const defaultAPIURL = "https://api.yolo.studio/v1"
const defaultAppURL = "https://yolo.studio"

type endpoints struct{ api, app string }

func endpoint(raw, fallback, name string) (string, error) {
	if raw == "" {
		return fallback, nil
	}
	invalid := func() (string, error) {
		return "", fmt.Errorf("%s must be an HTTPS base URL (HTTP only for localhost or 127.0.0.1), without credentials, query or fragment", name)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") || strings.TrimSpace(raw) != raw {
		return invalid()
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (strings.EqualFold(u.Hostname(), "localhost") || u.Hostname() == "127.0.0.1")) {
		return invalid()
	}
	if strings.HasSuffix(u.Host, ":") {
		return invalid()
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return invalid()
		}
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func resolveEndpoints(api, app string) (endpoints, error) {
	a, err := endpoint(api, defaultAPIURL, "YOLOSTART_API_URL")
	if err != nil {
		return endpoints{}, err
	}
	b, err := endpoint(app, defaultAppURL, "YOLOSTART_APP_URL")
	return endpoints{a, b}, err
}

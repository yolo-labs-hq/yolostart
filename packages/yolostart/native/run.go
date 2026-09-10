package yolostart

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

var Version = "dev"

func Run(ctx context.Context, args []string, out, errOut io.Writer) error {
	return run(ctx, args, out, errOut, nil)
}
func run(ctx context.Context, args []string, out, errOut io.Writer, login func(context.Context) (string, error)) error {
	flags := flag.NewFlagSet("yolostart", flag.ContinueOnError)
	flags.SetOutput(errOut)
	scan := flags.String("scan", "", "directory to scan (default: current directory)")
	project := flags.String("project", "", "one named repository or relative path")
	noBrowser := flags.Bool("no-browser", false, "print the sign-in and approval links without opening a browser")
	dry := flags.Bool("dry-run", false, "print candidate metadata without uploading")
	version := flags.Bool("version", false, "print version")
	flags.Usage = func() {
		fmt.Fprintln(out, "Usage: yolostart [--no-browser] [--dry-run] [--scan <directory>] [--project <name-or-relative-path>]\nSigns in, scans, and opens browser approval before importing one project.\n--dry-run prints metadata without creating an approval session or uploading.\nGit is required for repository discovery; no language runtime is needed.")
	}
	if e := flags.Parse(args); e != nil {
		if errors.Is(e, flag.ErrHelp) {
			return nil
		}
		return e
	}
	if flags.NArg() > 0 {
		return errors.New("unexpected positional arguments")
	}
	if *version {
		fmt.Fprintln(out, Version)
		return nil
	}
	urls, e := resolveEndpoints(os.Getenv("YOLOSTART_API_URL"), os.Getenv("YOLOSTART_APP_URL"))
	if e != nil {
		return e
	}
	if urls.api != defaultAPIURL {
		fmt.Fprintf(errOut, "Using YOLOSTART_API_URL: %s\n", urls.api)
	}
	if urls.app != defaultAppURL {
		fmt.Fprintf(errOut, "Using YOLOSTART_APP_URL: %s\n", urls.app)
	}
	if login == nil {
		auth := newAuth(errOut)
		auth.openBrowser = func(uri string) { openBrowser(uri, *noBrowser, errOut) }
		login = auth.login
	}
	token, e := login(ctx)
	if e != nil {
		return e
	}
	if *scan == "" {
		cwd, e := os.Getwd()
		if e != nil {
			return e
		}
		*scan = cwd
	}
	if !*dry {
		manifest, inventories, e := scanImport(ctx, *scan, *project)
		if e != nil {
			return e
		}
		driver := newImport(errOut, token)
		driver.base, driver.browser = urls.api, urls.app
		driver.openBrowser = func(uri string) { openBrowser(uri, *noBrowser, errOut) }
		return driver.execute(ctx, manifest, inventories, out)
	}
	manifest, e := Scan(*scan, *project)
	if e != nil {
		return e
	}
	fmt.Fprintln(errOut, "Dry run only. Nothing uploaded. Excluded secrets must be supplied separately in the workspace.")
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(manifest)
}

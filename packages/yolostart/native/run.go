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
	return run(ctx, args, out, errOut, newAuth(errOut).login)
}
func run(ctx context.Context, args []string, out, errOut io.Writer, login func(context.Context) (string, error)) error {
	flags := flag.NewFlagSet("yolostart", flag.ContinueOnError)
	flags.SetOutput(errOut)
	scan := flags.String("scan", "", "directory to scan (default: current directory)")
	project := flags.String("project", "", "one named repository or relative path")
	dry := flags.Bool("dry-run", false, "print candidate metadata without uploading")
	version := flags.Bool("version", false, "print version")
	flags.Usage = func() {
		fmt.Fprintln(out, "Usage: yolostart [--dry-run] [--scan <directory>] [--project <name-or-relative-path>]\nSigns in, scans, and prints browser approval before importing one project.\n--dry-run prints metadata without creating an approval session or uploading.\nGit is required for repository discovery; no language runtime is needed.")
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
		return newImport(errOut, token).execute(ctx, manifest, inventories, out)
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

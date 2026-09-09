package main

import (
	"context"
	"fmt"
	yolostart "github.com/yolo-labs-hq/yolostart"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	done := make(chan error, 1)
	go func() { done <- yolostart.Run(ctx, os.Args[1:], os.Stdout, os.Stderr) }()
	select {
	case err := <-done:
		if err != nil {
			fmt.Fprintln(os.Stderr, "yolostart:", err)
			os.Exit(1)
		}
	case sig := <-signals:
		cancel()
		if sig == syscall.SIGTERM {
			os.Exit(143)
		}
		os.Exit(130)
	}
}

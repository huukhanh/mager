package main

import (
	"context"
	"flag"
	"log"
	"os/signal"
	"syscall"
	"time"

	"github.com/huukhanh/cftun-mager/agent/internal/agent"
)

func main() {
	workerURL := flag.String("worker-url", "", "CloudTunnel Worker base URL (required), e.g. https://cloudtunnel.example.workers.dev")
	stateDir := flag.String("state-dir", "/etc/cloudtunnel", "Directory for node.id")
	cloudflaredPath := flag.String("cloudflared-path", "cloudflared", "cloudflared binary path (--system-cloudflared style override)")
	poll := flag.Duration("poll-interval", 30*time.Second, "Config poll interval")
	machineName := flag.String("machine-name", "", "Machine name sent to /api/register (default: os.Hostname)")
	flag.Parse()

	if *workerURL == "" {
		log.Fatal("-worker-url is required")
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	err := agent.Run(ctx, agent.Options{
		WorkerURL:       *workerURL,
		StateDir:        *stateDir,
		CloudflaredPath: *cloudflaredPath,
		PollInterval:    *poll,
		MachineName:     *machineName,
	})
	if err != nil && err != context.Canceled {
		log.Fatal(err)
	}
}

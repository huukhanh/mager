package agent

import (
	"context"
	"log"
	"os"
	"time"

	apiclient "github.com/huukhanh/mager/agent/internal/api"
	"github.com/huukhanh/mager/agent/internal/nodeid"
	"github.com/huukhanh/mager/agent/internal/tunnel"
)

type Options struct {
	WorkerURL       string
	StateDir        string
	CloudflaredPath string
	PollInterval    time.Duration
	MachineName     string
}

func Run(ctx context.Context, o Options) error {
	if o.PollInterval <= 0 {
		o.PollInterval = 30 * time.Second
	}
	name := o.MachineName
	if name == "" {
		h, err := os.Hostname()
		if err != nil {
			return err
		}
		name = h
	}

	nodeID, err := nodeid.Ensure(o.StateDir)
	if err != nil {
		return err
	}

	client := apiclient.NewClient(o.WorkerURL)
	reg, err := client.Register(ctx, nodeID, name)
	if err != nil {
		return err
	}
	session := reg.SessionToken

	cfg, err := client.FetchConfig(ctx, nodeID, session)
	if err != nil {
		return err
	}

	lastHash := cfg.ConfigHash
	sup := &tunnel.Supervisor{CloudflaredPath: o.CloudflaredPath}
	sup.Replace(ctx, cfg)

	t := time.NewTicker(o.PollInterval)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			sup.Stop()
			return ctx.Err()
		case <-t.C:
			next, err := client.FetchConfig(ctx, nodeID, session)
			if err != nil {
				log.Printf("poll config failed: %v", err)
				continue
			}
			if next.ConfigHash != lastHash {
				lastHash = next.ConfigHash
				sup.Replace(ctx, next)
			}
		}
	}
}

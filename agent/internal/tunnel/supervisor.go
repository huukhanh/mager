package tunnel

import (
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/huukhanh/mager/agent/internal/api"
	"github.com/huukhanh/mager/agent/internal/cloudflared"
)

// Supervisor runs cloudflared with backoff until the inner context is cancelled.
type Supervisor struct {
	CloudflaredPath string

	mu     sync.Mutex
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func (s *Supervisor) Replace(parent context.Context, cfg *api.NodeConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cancel != nil {
		s.cancel()
		s.wg.Wait()
		s.cancel = nil
	}

	if cfg == nil || cfg.TunnelID == "" || cfg.TunnelToken == "" {
		return
	}

	runCtx, cancel := context.WithCancel(parent)
	s.cancel = cancel
	s.wg.Add(1)

	go func(cfg api.NodeConfig) {
		defer s.wg.Done()
		defer cancel()

		yamlText := cloudflared.BuildConfigYAML(cfg.TunnelID, cfg.Ingress)
		f, err := os.CreateTemp("", "mager-ingress-*.yml")
		if err != nil {
			log.Printf("cloudflared: temp config: %v", err)
			return
		}
		cfgPath := f.Name()
		_, _ = f.WriteString(yamlText)
		_ = f.Close()
		defer func() { _ = os.Remove(cfgPath) }()

		path := s.CloudflaredPath
		if path == "" {
			path = "cloudflared"
		}

		backoff := time.Second
		for runCtx.Err() == nil {
			err := runCloudflared(runCtx, path, cfgPath, cfg.TunnelToken)
			if errors.Is(err, context.Canceled) {
				return
			}
			if runCtx.Err() != nil {
				return
			}
			log.Printf("cloudflared exited (%v); restarting in %s", err, backoff)
			select {
			case <-runCtx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}(*cfg)
}

func (s *Supervisor) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.wg.Wait()
		s.cancel = nil
	}
}

func runCloudflared(ctx context.Context, bin, cfgPath, tunnelToken string) error {
	cmd := exec.Command(bin, "tunnel", "--config", cfgPath, "run")
	cmd.Env = append(os.Environ(), "TUNNEL_TOKEN="+tunnelToken)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return err
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case <-ctx.Done():
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
		select {
		case <-done:
		case <-time.After(12 * time.Second):
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			<-done
		}
		return context.Canceled
	case err := <-done:
		return err
	}
}

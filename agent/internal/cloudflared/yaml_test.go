package cloudflared

import (
	"strings"
	"testing"

	"github.com/huukhanh/mager/agent/internal/api"
)

func TestBuildConfigYAML(t *testing.T) {
	got := BuildConfigYAML("tid-1", []api.IngressRule{
		{Hostname: "a.example.com", Service: "http://localhost:3000"},
	})
	for _, frag := range []string{
		"tunnel: tid-1",
		`hostname: "a.example.com"`,
		`service: "http://localhost:3000"`,
		"http_status:404",
	} {
		if !strings.Contains(got, frag) {
			t.Fatalf("missing %q in yaml:\n%s", frag, got)
		}
	}
}

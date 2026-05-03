package cloudflared

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/huukhanh/cftun-mager/agent/internal/api"
)

// BuildConfigYAML builds a minimal ingress file. Tunnel token is supplied via TUNNEL_TOKEN env only.
func BuildConfigYAML(tunnelID string, ingress []api.IngressRule) string {
	var b strings.Builder
	fmt.Fprintf(&b, "tunnel: %s\n", tunnelID)
	fmt.Fprintf(&b, "ingress:\n")
	for _, r := range ingress {
		fmt.Fprintf(&b, "  - hostname: %s\n", strconv.Quote(r.Hostname))
		fmt.Fprintf(&b, "    service: %s\n", strconv.Quote(r.Service))
	}
	fmt.Fprintf(&b, "  - service: http_status:404\n")
	return b.String()
}

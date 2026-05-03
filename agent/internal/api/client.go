package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type IngressRule struct {
	Hostname string `json:"hostname"`
	Service  string `json:"service"`
}

type RegisterResponse struct {
	SessionToken string `json:"sessionToken"`
	NodeID       string `json:"nodeId"`
	MachineName  string `json:"machineName"`
}

type NodeConfig struct {
	TunnelID    string        `json:"tunnelId"`
	Ingress     []IngressRule `json:"ingress"`
	TunnelToken string        `json:"tunnelToken"`
	ConfigHash  string        `json:"configHash"`
}

type Client struct {
	BaseURL    string
	HTTPClient *http.Client
}

func NewClient(baseURL string) *Client {
	u := strings.TrimRight(baseURL, "/")
	return &Client{
		BaseURL: u,
		HTTPClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

func (c *Client) Register(ctx context.Context, nodeID, machineName string) (*RegisterResponse, error) {
	body, err := json.Marshal(map[string]string{
		"nodeId":      nodeID,
		"machineName": machineName,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/register", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("register: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out RegisterResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) FetchConfig(ctx context.Context, nodeID, sessionToken string) (*NodeConfig, error) {
	u := fmt.Sprintf("%s/api/nodes/%s/config", c.BaseURL, nodeID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("config: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out NodeConfig
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

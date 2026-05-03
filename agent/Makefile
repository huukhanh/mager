.PHONY: build build-all test fmt

build:
	go build -o bin/cloudtunnel-agent ./cmd/cloudtunnel-agent

build-all:
	GOOS=linux GOARCH=amd64 go build -o bin/cloudtunnel-agent-linux-amd64 ./cmd/cloudtunnel-agent
	GOOS=linux GOARCH=arm64 go build -o bin/cloudtunnel-agent-linux-arm64 ./cmd/cloudtunnel-agent

test:
	go test ./...

fmt:
	go fmt ./...

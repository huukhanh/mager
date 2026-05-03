.PHONY: build build-all test fmt

build:
	go build -o bin/mager-agent ./cmd/mager-agent

build-all:
	GOOS=linux GOARCH=amd64 go build -o bin/mager-agent-linux-amd64 ./cmd/mager-agent
	GOOS=linux GOARCH=arm64 go build -o bin/mager-agent-linux-arm64 ./cmd/mager-agent

test:
	go test ./...

fmt:
	go fmt ./...

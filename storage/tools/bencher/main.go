package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/Venbiess/autonomous-vehicles-search-platform/storage/tools/bencher/object"
	"github.com/Venbiess/autonomous-vehicles-search-platform/storage/tools/bencher/vector"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "bencher error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		printUsage()
		return errors.New("mode is required: vector|object")
	}

	mode := strings.ToLower(strings.TrimSpace(args[0]))
	forwardArgs := args[1:]

	switch mode {
	case "vector":
		return vector.RunCLI(forwardArgs)
	case "object":
		return object.RunCLI(forwardArgs)
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		printUsage()
		return fmt.Errorf("unsupported mode %q, expected vector or object", mode)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Unified storage bencher")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Usage:")
	fmt.Fprintln(os.Stderr, "  go run ./tools/bencher <mode> [flags]")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Modes:")
	fmt.Fprintln(os.Stderr, "  vector    benchmark vector backends")
	fmt.Fprintln(os.Stderr, "  object    benchmark object storage")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Examples:")
	fmt.Fprintln(os.Stderr, "  go run ./tools/bencher vector -config config/storage.integration.qdrant.yaml -mode run -seed-count 4000 -query-count 1200")
	fmt.Fprintln(os.Stderr, "  go run ./tools/bencher object -target storage -url http://localhost:9000 -bucket bench -size 1MB -ops 2000 -concurrency 8")
}

package main

import "testing"

func TestRunRequiresMode(t *testing.T) {
	err := run(nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

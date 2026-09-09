package yolostart

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeSourceHasNoTerminalInputAPI(t *testing.T) {
	err := filepath.WalkDir(".", func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, e := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if e != nil {
			return e
		}
		for _, imp := range f.Imports {
			if strings.Contains(imp.Path.Value, "readline") || strings.Contains(imp.Path.Value, "prompt") || strings.Contains(imp.Path.Value, "term") {
				t.Errorf("interactive import in %s: %s", path, imp.Path.Value)
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if selector, ok := n.(*ast.SelectorExpr); ok {
				if selector.Sel.Name == "Stdin" || selector.Sel.Name == "Scanln" || selector.Sel.Name == "Scanf" {
					t.Errorf("input API in %s: %s", path, selector.Sel.Name)
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

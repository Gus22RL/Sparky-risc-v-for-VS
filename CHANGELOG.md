# Changelog

## Unreleased

- Documented and tested folding of named groups inside a function (`#fn push` … `#endfn push`); the id after the marker is a free label shown when folded, and it can be reused.

## 0.2.0

- Function folding: `label: #fn` … `#endfn` collapses a function in the editor gutter (`.macro` … `.end_macro` still folds). The markers are highlighted differently from regular comments.

## 0.1.0

- First version: RISC-V language support (highlighting, hover, completion, signature help) generated from the RARS 1.6 jar.
- Editor help only explains how an instruction is written and what it is made of (`addi rd, rs1, imm`); it never suggests values or code. No snippets; inline and word-based suggestions are turned off for this language.
- Real-time errors using the RARS assembler.
- Debugger (DAP): breakpoints, step, step out, step back, pause, registers, watch expressions, memory and disassembly views.
- RARS-style panels: Registers, Text Segment, Data Segment and Labels, following the VS Code theme.
- Program I/O in the "Sparky I/O" terminal.

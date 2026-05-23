# Penelope Debug Adapter (DAP)

`bin/penelope-dap` speaks the standard Debug Adapter Protocol over stdio, so any DAP-compatible editor (VSCode, Neovim with `nvim-dap`, etc.) can drive a debugging session.

## What works (MVP)

- **`launch`** — load a `.pen` file
- **`setBreakpoints`** — by source line; mapped to opcode `ip` via the compiler's `sourceMap`
- **`configurationDone`** — starts execution
- **`continue`** — runs until the next breakpoint or program end
- **`threads` / `stackTrace`** — single thread; reports the suspended IP's source position and any call frames below it
- **`scopes` / `variables`** — `Locals` (visible bindings via the parent chain) + `Value Stack`
- **`terminate` / `disconnect`** — clean exit

## What does not work yet

- `stepIn` / `stepOver` / `stepOut` — needs proper single-step in the VM
- Conditional / log breakpoints
- Exception breakpoints
- `repl` evaluation

## VSCode usage

If the Penelope extension (`vscode-extension/`) is installed in dev mode (`F5` from the extension folder), open any `.pen` file and pick *Run and Debug → Penelope Debugger* from the sidebar. The default `launch.json` config is:

```json
{
  "type": "penelope",
  "request": "launch",
  "name": "Launch Penelope file",
  "program": "${workspaceFolder}/${file}"
}
```

## Neovim usage (nvim-dap)

```lua
local dap = require('dap')
dap.adapters.penelope = {
  type = 'executable',
  command = 'bin/penelope-dap',
  args = {},
}
dap.configurations.penelope = {
  {
    type = 'penelope',
    request = 'launch',
    name = 'Launch Penelope file',
    program = '${workspaceFolder}/${relativeFile}',
  },
}
```

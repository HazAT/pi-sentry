# TODO

## When `extension_error` event lands upstream in pi-coding-agent

Tracking: https://github.com/HazAT/pi-mono/tree/feat/extension-error-event

### What the patch does

Two changes to `ExtensionRunner` in `@mariozechner/pi-coding-agent`:

1. **`extension_error` event** — `emitError()` dispatches to extension handlers registered for `"extension_error"`, so extensions (like this one) can capture errors from other extensions. Errors from these handlers are swallowed to prevent infinite recursion.

2. **`emitToolCall` try/catch** — was the only emit method without error handling. A throwing `tool_call` handler would crash the process. Now routes errors through `emitError()` like all other emit methods.

### Steps to remove the patch

1. Update `@mariozechner/pi-coding-agent` to the version that includes these changes
2. Delete `patches/extension-error-event.patch`
3. Delete `scripts/apply-patches.mjs`
4. Remove the `"postinstall"` script from `package.json`
5. Remove the `as any` cast from `pi.on("extension_error" as any, ...)` in `pi-extension/index.ts`
6. Run `npm install && vp check && vp test` — all 63 tests should pass
7. Delete this file

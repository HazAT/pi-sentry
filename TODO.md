# Maintenance Notes

The `extension_error` / `tool_call` fixes are still carried locally in `patches/extension-error-event.patch`, but they are now applied only by maintainers when they explicitly run `npm run patch:apply`.

When the upstream `@mariozechner/pi-coding-agent` release includes those changes, we should:

1. Remove `patches/extension-error-event.patch`
2. Delete `scripts/apply-patches.mjs`
3. Remove `patch:apply` from `package.json`
4. Drop the `as any` cast from `pi.on("extension_error" as any, ...)` in `pi-extension/index.ts`
5. Run `npm install && vp check && vp test`

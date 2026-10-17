/**
 * dsh-remote-control — client half (plain JavaScript, no build step).
 *
 * One `window.__ModuleLoader__.load` entry, exactly like the sibling panels
 * (`@misaka10091/dsh-git-panel`): the browser boot graph mounts this factory and
 * the host serves it through `exports["./client"]`. There is no second entry and
 * no compiled output (`.trellis/spec/backend/quality-guidelines.md`).
 *
 * Stage 0/1 scope: the entry exists and is inert. The sidebar device panel —
 * enable switch, port, QR pairing, device list with revoke, audit export — is
 * stage 5 (`implement.md`). Registering a seat now would put an empty panel in
 * the sidebar of every profile that installs the package, so the factory
 * declares no slot until it has something to show.
 *
 * When the panel arrives it takes seats via the injected services listed in
 * `package.json` (`dsh.client.inject`); this file must keep working on a host
 * that offers none of them.
 */
window.__ModuleLoader__.load({
  id: '@misaka10091/dsh-remote-control',
  factory: (require) => {
    /* `require` is the host module loader handed to every client plugin
       (`react`, `@deepseek-ai/dsh-client-ui-primitives`, …). Nothing is required
       yet: an unused require at load time is a load-order dependency on a host
       that may not provide it. */
    void require

    /**
     * Mount point for the client half.
     *
     * Inert in this build: no slot, no request, no timer. Everything it would do
     * is conditional on the pairing flow existing.
     */
    function apply() {
      /* no-op until stage 5 */
    }

    return { name: 'dsh-remote-control', inject: [], apply }
  },
})

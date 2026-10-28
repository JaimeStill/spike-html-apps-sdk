// The module the router fixture's lazy route loads: it defines its element on its first import.

export const tag = "x-lazy";

customElements.define(tag, class extends HTMLElement {});

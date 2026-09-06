/** Wrangler's `CompiledWasm` rule turns a `.wasm` import into a WebAssembly.Module. */
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

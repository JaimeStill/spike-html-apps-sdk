// The application SDK's event-sequence interface: a CloudEvent, the opaque cursor that marks a place
// in a sequence, and the sequence an app reads, from its oldest kept event or from after a cursor,
// live as events are appended. It is the contract only, types with no runtime and no dependency:
// an implementation (the NATS adapter, a test's in-memory sequence) meets the semantics its doc
// comments state.
export {};

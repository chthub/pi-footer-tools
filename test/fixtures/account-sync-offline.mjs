// Preloaded before Pi: never let an integration-test extension loading failure
// turn synthetic credentials into a real provider request.
globalThis.fetch = async () => { throw new Error("Network disabled in account sync integration test"); };

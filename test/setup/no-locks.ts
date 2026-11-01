// Runs the suite as Node 18/20, older Safari, non-secure pages and React Native would: without Web Locks.
Object.defineProperty(globalThis.navigator, "locks", { value: undefined, configurable: true });

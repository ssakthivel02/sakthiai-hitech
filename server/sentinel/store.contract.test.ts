import { defineStoreContract } from "./store.contract";
import { InMemorySentinelStore } from "./testing";

defineStoreContract("in-memory", async () => ({ store: new InMemorySentinelStore() }));

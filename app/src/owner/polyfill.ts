// Lucid's dependency tree reads a global Buffer at load time.
import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

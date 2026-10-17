// gendo-agent releases, as this server knows them. The latest comes from the package in this checkout;
// raise the minimum only for a fix agents must have (older ones then can't submit until they update).
import pkg from "../../gendo-agent/package.json" with { type: "json" };

export const LATEST_AGENT: string = pkg.version;
export const MIN_AGENT = "0.1.1";

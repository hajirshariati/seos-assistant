// Liveness + database check for the host's health check and uptime
// monitors. Public, no secrets: status, commit and timings only.
import { healthCheck } from "../lib/health-check.server";

export const loader = () => healthCheck();
